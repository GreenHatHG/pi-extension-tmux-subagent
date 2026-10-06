/**
 * Main-session cleanup: when this pi session goes away, close the sub-agent panes it started.
 *
 * Why this is needed: a sub-agent pane lives on the shared pi-sub tmux server, so it is not a
 * child of this pi process and nothing kills it when we die. Its own wrap-up only runs when the
 * task reaches stop_watchdog; if we go away first, the pane keeps running for good. An orphan
 * pane still has the full tool set, so it can keep running shell commands and popping dialogs on
 * the user's screen — that is the bug this file closes.
 *
 * Which reasons close panes (pi's session_shutdown): quit = normal exit, SIGTERM or SIGHUP (pi
 * core turns a signal into runtimeHost.dispose(), which emits reason "quit"); new / resume / fork
 * = the session was replaced, so the pane's owner id no longer belongs to any live session and
 * /attach can never see it again; reload = the extension was reloaded, the parent process is
 * still alive, so leave panes alone.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { killSubagentSession, listSubagentSessions } from "../core/tmux";
import { onEvent } from "../registry";

/** Reasons where the pane's owner session id stops existing, so the pane must go with it. */
const REAP_REASONS = new Set(["quit", "new", "resume", "fork"]);

/** Context fields we use (minimal shape; a real ExtensionContext satisfies it). */
interface ReapCtx {
	sessionManager: { getSessionId(): string };
	ui: { notify(text: string, level: string): void };
}

/**
 * Close every sub-agent pane owned by this main session. Runs on the way out, so a failure here
 * must never break the shutdown: errors are swallowed and the shutdown continues.
 */
async function reapOwnSubagents(parentSessionId: string, ctx: ReapCtx): Promise<void> {
	// Nothing to do when no pane is alive; listSubagentSessions also returns [] when no tmux server runs.
	const sessions = await listSubagentSessions(parentSessionId);
	if (sessions.length === 0) return;
	let killed = 0;
	for (const session of sessions) {
		const r = await killSubagentSession(session);
		if (r.code === 0) killed++;
	}
	if (killed > 0) {
		// Say what happened: without this the user only sees their /attach overlay blink out.
		ctx.ui.notify(`Closed ${killed} sub-agent pane(s) started by this session.`, "info");
	}
}

/** Register the shutdown reaper. Main session only; a sub-agent pane has nothing to reap. */
export function setupSubagentReaper(pi: ExtensionAPI): void {
	onEvent(
		pi,
		"session_shutdown",
		{
			where: "session/reap.ts:reap own sub-agents",
			note: "When this main session quits or is replaced, kill the sub-agent panes it started, so no orphan pane keeps running commands",
		},
		async (event: unknown, ctx: unknown) => {
			const { reason } = event as { reason: string };
			if (!REAP_REASONS.has(reason)) return;
			try {
				await reapOwnSubagents((ctx as ReapCtx).sessionManager.getSessionId(), ctx as ReapCtx);
			} catch {
				/* on the way out: a failed cleanup must not break the shutdown */
			}
		},
	);
}
