/**
 * /attach command: pick one of this conversation's running sub-agents and watch it in a tmux
 * display-popup overlay (mechanics live in attach-open.ts).
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { captureSubagentPane, listSubagentSessions } from "../core/tmux";
import { onEvent } from "../registry";
import { manualAttachCmd, openAttach, overlayAvailable, popupMsg } from "./attach-open";

/** One-line picker entry: session name + the last real output line of its pane. */
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
			if (!overlayAvailable(ctx.mode)) {
				const name = args.trim();
				ctx.ui.notify(
					`Can't open an overlay in this mode; run it yourself: ${manualAttachCmd(name || undefined)}`,
					"info",
				);
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
