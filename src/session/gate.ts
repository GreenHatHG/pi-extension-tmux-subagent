/**
 * Self-check inside a sub-agent pane. This code runs in the sub-agent's pi process (the main
 * session injects PI_SUBAGENT=1 via tmux -e), a separate execution context from the rest of the
 * main-session wiring. The gate lives in index.ts's role.kind branch; this module only does the
 * self-check, and the caller passes in the process role.
 */
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isWatchdogAvailable } from "../completion/profile";
import type { ProcessRole } from "../core/env";
import { SOCKET, shQuote } from "../core/tmux";
import { onEvent } from "../registry";

/**
 * Sub-agent self-check (registered only when role.watchdog = PI_WATCHDOG was injected). Put in
 * session_start: by then all extensions have loaded, so /watchdog registration timing can't cause
 * false negatives. PI_WATCHDOG injected but no watchdog extension = the interactive wrap-up is
 * missing: when the task is done pi won't exit or send the done signal, and the tmux session stays
 * forever. So write a non-zero exit and send the done signal at once, letting the waiter see the
 * failure immediately instead of hanging silently. The pi -p fallback does not inject PI_WATCHDOG
 * (role.watchdog is false), so this branch does not run.
 */
export function setupSubagentSelfCheck(pi: ExtensionAPI, role: ProcessRole): void {
	if (!role.watchdog) return;

	onEvent(
		pi,
		"session_start",
		{
			where: "session/gate.ts:watchdog self-check",
			note: "Sub-agent pane has PI_WATCHDOG but no watchdog extension: write exit=97 and send the done signal, so it fails fast instead of hanging",
		},
		async (_event: unknown, ctx: { ui: { notify(text: string, level: string): void } }) => {
			if (isWatchdogAvailable(pi)) return;
			ctx.ui.notify(
				"Sub-agent error: PI_WATCHDOG was injected but the watchdog extension is not loaded, so the wrap-up can't happen automatically. This delegation is marked failed (exit=97) and the waiter was told; try again with the -p fallback path.",
				"warning",
			);
			// 97 = sub-agent self-check failed (no watchdog); the waiter sees a missing result.md + non-zero exit and calls it a failure
			if (role.exitFile) {
				try {
					writeFileSync(role.exitFile, "97\n");
				} catch {
					/* ignore */
				}
			}
			if (role.done) {
				// Send and go: wait-for -S returns at once, the server remembers the signal, so a late waiter still gets it
				pi.exec("sh", ["-c", `TMUX= tmux -L ${SOCKET} wait-for -S ${shQuote(role.done)}`]).catch(() => {});
			}
		},
	);
}
