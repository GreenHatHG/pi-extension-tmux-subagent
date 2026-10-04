/**
 * /attach command: opens a display-popup overlay on the user's tmux (where the main session runs)
 * and attaches to a sub-agent session.
 *
 * Popup keys go straight to the inner tmux (the outer key table is not involved), so the inner
 * prefix works: prefix key d only detaches the overlay; when attach exits, -E closes the popup
 * automatically and the sub-agent is unaffected. Ctrl-c / Esc do not close the overlay; they are
 * sent into the inner pane, so the hint must say so.
 *
 * A normal (writable) attach means prefix keys x / & / : really kill the sub-agent, and typing goes
 * into the pane; to avoid accidental kills, switch back to attach -r, at the cost of losing
 * copy-mode (no scrolling back through history) in read-only mode.
 *
 * display-popup -E blocks until the popup closes, so this command must be fire-and-forget (spawn +
 * unref), it can't await. Needs tmux >= 3.3 (-b / -S / -T are all 3.3+).
 */
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { captureSubagentPane, listSubagentSessions, run, SOCKET, shQuote, subagentPrefixHint } from "../core/tmux";
import { onEvent } from "../registry";

/**
 * Resolve the tty of the client running /attach: popups are per-client, so with multiple terminals
 * we must open it on the right one. Prefer a match by the $TMUX session id (the second $TMUX field
 * is the server pid, not the client pid); if that fails, fall back to the most recently active client.
 */
async function resolveClientTty(socketPath: string): Promise<string | undefined> {
	const sid = process.env.TMUX?.split(",")[2]?.trim();
	const want = sid ? (sid.startsWith("$") ? sid : `$${sid}`) : undefined;
	const clients = await run("tmux", [
		"-S",
		socketPath,
		"list-clients",
		"-F",
		"#{client_tty}\t#{client_session}\t#{client_activity}",
	]);
	if (clients.code !== 0) return undefined;
	const rows = clients.stdout
		.split("\n")
		.filter(Boolean)
		.map((l) => l.split("\t"));
	if (want) {
		const sessions = await run("tmux", ["-S", socketPath, "list-sessions", "-F", "#{session_id}\t#{session_name}"]);
		const name = sessions.stdout
			.split("\n")
			.filter(Boolean)
			.map((l) => l.split("\t"))
			.find(([id]) => id === want)?.[1];
		const matching = rows.filter(([, s]) => s === name);
		if (matching.length > 0) {
			matching.sort((a, b) => Number(b[2]) - Number(a[2]));
			return matching[0][0];
		}
	}
	rows.sort((a, b) => Number(b[2]) - Number(a[2]));
	return rows[0]?.[0];
}

/** Overlay open result: non-empty error = failure; on success it carries the prefix text. */
interface AttachResult {
	error?: string;
	prefix?: string;
}

/** Open an overlay attached to a sub-agent session. */
async function openAttach(session: string): Promise<AttachResult> {
	const socketPath = process.env.TMUX?.split(",")[0];
	if (!socketPath) return { error: "Not inside tmux ($TMUX is empty), can't open an overlay." };

	const tty = await resolveClientTty(socketPath);
	const prefix = await subagentPrefixHint();
	// Keep TMUX=: the popup command runs on the outer server, and if that server env has TMUX, attach warns about nesting
	const popupCmd = `TMUX= tmux -L ${SOCKET} attach -t ${shQuote(session)}`;
	const args = ["-S", socketPath, "display-popup"];
	if (tty) args.push("-c", tty);
	// -b double + a pink -S border: make the outer overlay itself differ from the user's tmux; the title also carries the exit hint
	args.push(
		"-E",
		"-w",
		"90%",
		"-h",
		"90%",
		"-b",
		"double",
		"-S",
		"fg=colour213,bg=default",
		"-T",
		`sub-agent ${session} · ${prefix} d to quit watching`,
		popupCmd,
	);

	// display-popup -E blocks until the overlay closes, so it must be fire-and-forget. Briefly wait
	// for spawn/early exit: give a clear error when spawn fails or display-popup errors out
	// immediately (e.g. tmux < 3.3).
	const child = spawn("tmux", args, { env: { ...process.env, TMUX: "" }, stdio: "ignore", detached: true });
	const error = await new Promise<string | undefined>((resolve) => {
		const timer = setTimeout(() => resolve(undefined), 700);
		child.once("error", () => {
			clearTimeout(timer);
			resolve("Could not start the tmux overlay (spawn tmux failed).");
		});
		child.once("exit", (code) => {
			if (code !== 0) {
				clearTimeout(timer);
				resolve(`tmux display-popup failed (exit ${code}) — needs tmux >= 3.3.`);
			}
		});
	});
	child.on("error", () => {
		/* swallow a post-spawn error (rare) quietly */
	});
	child.unref();
	return error ? { error } : { prefix };
}

function popupMsg(name: string, prefix: string): string {
	return `Attached to ${name} in an overlay. To quit: ${prefix} d (only detaches the overlay; the sub-agent keeps running). Note Ctrl-c is not quit — it goes into the sub-agent; scroll / ${prefix} [ to look back (normal attach: ${prefix} x / & / : really kills the session, and typing goes into the pane).`;
}

async function listLine(session: string): Promise<string> {
	const cap = await captureSubagentPane(session);
	const lines =
		cap.code === 0
			? cap.stdout
					.trim()
					.split("\n")
					.map((line) => line.trim())
					.filter(Boolean)
			: [];
	// bash-guard is the main pane's safety status bar, not the sub-agent's task progress, so leave it out of the preview
	const last = [...lines].reverse().find((line) => !/bash-guard/i.test(line)) ?? "";
	return `${session}${last ? `  │ ${last}` : "(no content yet)"}`;
}

/** No args: list this conversation's sub-agents in a scrollable picker; picking one opens the overlay attach. */
async function pickSession(ctx: ExtensionCommandContext): Promise<void> {
	const sessions = await listSubagentSessions(ctx.sessionManager.getSessionId());
	if (sessions.length === 0) {
		ctx.ui.notify("No running sub-agents right now", "info");
		return;
	}
	const items = await Promise.all(sessions.map((s) => listLine(s)));
	const chosen = await ctx.ui.select("Running sub-agents (pick one to watch)", items);
	if (!chosen) return;
	const name = chosen.split(/\s/)[0];
	const res = await openAttach(name);
	if (res.error) ctx.ui.notify(res.error, "error");
	else ctx.ui.notify(popupMsg(name, res.prefix ?? "Ctrl-b"), "info");
}

export function setupAttachCommand(pi: ExtensionAPI): void {
	// The argument-completion API does not pass ExtensionCommandContext, so cache the current session
	// ID; the no-arg list and the real handler read from ctx directly, so the current session always wins.
	let currentSessionId: string | undefined;
	onEvent(
		pi,
		"session_start",
		{
			where: "ui/attach-command.ts:current-session filter",
			note: "Record the current main session ID so /attach argument completion shows only sub-agents from this conversation",
		},
		(_event: unknown, ctx: { sessionManager: { getSessionId(): string } }) => {
			currentSessionId = ctx.sessionManager.getSessionId();
		},
	);

	pi.registerCommand("attach", {
		description:
			"Watch this conversation's sub-agent in an overlay (live screen; prefix key d quits and does not affect the sub-agent); with no args, show a picker of running ones",
		getArgumentCompletions: async () => {
			const sessions = await listSubagentSessions(currentSessionId ?? "");
			return sessions.map((value) => ({ value, label: value, description: "watch this sub-agent" }));
		},
		handler: async (args, ctx) => {
			// Fallback: not TUI or not inside the user's tmux -> just print the manual command. Don't use
			// ctx.hasUI: in rpc mode hasUI can be true, but there is no user terminal to open an overlay on.
			const socketPath = process.env.TMUX?.split(",")[0];
			if (ctx.mode !== "tui" || !socketPath) {
				const name = args.trim();
				const cmd = name ? `tmux -L ${SOCKET} attach -t ${name}` : `tmux -L ${SOCKET} attach -t <session-name>`;
				ctx.ui.notify(`Can't open an overlay in this mode; run it yourself: ${cmd}`, "info");
				return;
			}

			const name = args.trim();
			if (!name) {
				await pickSession(ctx);
				return;
			}

			const sessions = await listSubagentSessions(ctx.sessionManager.getSessionId());
			if (!sessions.includes(name)) {
				ctx.ui.notify(
					`Session ${name} does not exist or already ended. Running: ${sessions.join(", ") || "(none)"}`,
					"warning",
				);
				return;
			}

			const res = await openAttach(name);
			if (res.error) {
				ctx.ui.notify(res.error, "error");
				return;
			}
			ctx.ui.notify(popupMsg(name, res.prefix ?? "Ctrl-b"), "info");
		},
	});
}
