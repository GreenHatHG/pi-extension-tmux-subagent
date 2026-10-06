/**
 * Attach mechanics shared by the /attach command and the agent list widget: open a tmux
 * display-popup on the user's tmux and attach to a sub-agent session.
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
 * display-popup -E blocks until the popup closes, so this must be fire-and-forget (spawn + unref),
 * it can't await. Needs tmux >= 3.3 (-b / -S / -T are all 3.3+).
 */
import { spawn } from "node:child_process";
import { run, SOCKET, shQuote, subagentPrefixHint } from "../core/tmux";

/**
 * Resolve the tty of the client that should show the popup: popups are per-client, so with
 * multiple terminals we must open it on the right one. Prefer a match by the $TMUX session id
 * (the second $TMUX field is the server pid, not the client pid); if that fails, fall back to
 * the most recently active client.
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
export interface AttachResult {
	error?: string;
	prefix?: string;
}

/** Open an overlay attached to a sub-agent session. */
export async function openAttach(session: string): Promise<AttachResult> {
	const socketPath = process.env.TMUX?.split(",")[0];
	if (!socketPath) return { error: "Not inside tmux ($TMUX is empty), can't open an overlay." };

	// A popup belongs to a client, so someone has to be attached to this tmux for it to appear
	const tty = await resolveClientTty(socketPath);
	if (!tty) return { error: "No attached tmux client found, so there is nowhere to show the overlay." };
	const prefix = await subagentPrefixHint();
	// Keep TMUX=: the popup command runs on the outer server, and if that server env has TMUX, attach warns about nesting
	const popupCmd = `TMUX= tmux -L ${SOCKET} attach -t ${shQuote(session)}`;
	const args = ["-S", socketPath, "display-popup", "-c", tty];
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
	// for spawn/early exit: report spawn failures and tmux's own message ("can't find client" for a
	// stale tty, an unknown option on old tmux) instead of a bare exit code.
	const child = spawn("tmux", args, {
		env: { ...process.env, TMUX: "" },
		stdio: ["ignore", "ignore", "pipe"],
		detached: true,
	});
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const error = await new Promise<string | undefined>((resolve) => {
		const timer = setTimeout(() => resolve(undefined), 700);
		child.once("error", () => {
			clearTimeout(timer);
			resolve("Could not start the tmux overlay (spawn tmux failed).");
		});
		child.once("exit", (code) => {
			if (code !== 0) {
				clearTimeout(timer);
				resolve(`Could not open the overlay (tmux exit ${code}): ${stderr.trim() || "needs tmux >= 3.3"}`);
			}
		});
	});
	child.on("error", () => {
		/* swallow a post-spawn error (rare) quietly */
	});
	child.unref();
	return error ? { error } : { prefix };
}

/** Short "can this process open an overlay at all" check, shared by /attach and the agent list. */
export function overlayAvailable(mode: string): boolean {
	return mode === "tui" && !!process.env.TMUX?.split(",")[0];
}

/** Text for the manual attach command when no overlay can be opened. */
export function manualAttachCmd(session?: string): string {
	return `tmux -L ${SOCKET} attach -t ${session ?? "<session-name>"}`;
}

/** Post-attach notice: what to press to leave, what NOT to press. */
export function popupMsg(name: string, prefix: string): string {
	return `Attached to ${name} in an overlay. To quit: ${prefix} d (only detaches the overlay; the sub-agent keeps running). Note Ctrl-c is not quit — it goes into the sub-agent; scroll / ${prefix} [ to look back (normal attach: ${prefix} x / & / : really kills the session, and typing goes into the pane).`;
}
