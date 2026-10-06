/** Completion protocol: the watchdog interactive path and the pi -p batch path, plus the tmux hook and command chain that tell the main session when it's done. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ENV_SUB_DONE, ENV_SUB_EXIT_FILE, ENV_SUBAGENT } from "../core/env";
import type { SubagentPaths } from "../core/paths";
import { runTmux, SOCKET, shQuote } from "../core/tmux";

/**
 * The wrap-up tool name, owned by pi-watchdog (its src/constants.ts TOOL_NAME). Copied, not imported:
 * the two extensions install and version separately, so an import would break whenever the other
 * side is missing or older. A rename upstream has to be mirrored here.
 */
export const WATCHDOG_TOOL = "watchdog_decide";

/**
 * Whether the watchdog wrap-up path is available: pi-watchdog always registers the /watchdog
 * command, so its presence means the extension loaded (loaded = usable; whether the sub-agent is
 * monitored is decided by the PI_WATCHDOG this extension injects). The main session and sub-agent
 * share the same extension config, so what the main session sees, the sub-agent has too.
 * We can only probe at spawn/advisor call time, since load-time registration order is not
 * guaranteed. Match on source === "extension" to avoid a same-named skill/prompt template. If
 * missing, fall back to the pi -p batch path (see resolveCompletion).
 */
export function isWatchdogAvailable(pi: ExtensionAPI): boolean {
	return pi.getCommands().some((c) => c.name === "watchdog" && c.source === "extension");
}

/**
 * Wrap-up profile: collects everything in launchSub that branches on whether watchdog loaded, so
 * the launchSub body just reads fields instead of spreading ternaries around.
 *
 * Watchdog path (default): interactive pi with mode=keep, always monitoring. When the AI calls
 * watchdog_decide, the ON_STOP hook (runs locally in the extension, no LLM, so no API failure risk)
 * does this in order: writes 0 to the exit file (pi is still running, so write 0 first and the
 * waiter reads "done" the moment it gets the signal instead of mistaking a missing exit for a
 * crash) -> sends the done signal -> closes the tmux session. pi gets SIGHUP and exits gracefully;
 * the pane shell shares pi's process group and normally dies on SIGHUP, so it never gets a chance
 * to overwrite the pre-written 0 with pi's real exit code. sleep 0.3 gives pi room to finish; if
 * ON_STOP fails midway, the pane-died hook still sends the signal as a backstop.
 * pi -p fallback: the process exits after one turn, and the pane shell writes the real exit code;
 * no watchdog env vars are injected; no timeout in the pane (macOS has no timeout command). pi
 * sessions are saved by default.
 * Both paths lean on the pane-died hook as a backstop: if the process crashes or is killed, the
 * signal still fires, and a missing exit file means the waiter sees an abnormal exit.
 */
export interface CompletionProfile {
	/** "watchdog" = interactive pi + watchdog_decide wrap-up; "batch" = pi -p batch fallback. */
	kind: "watchdog" | "batch";
	/** pi command prefix (no flags, no task prompt). */
	piCommandPrefix: "pi" | "pi -p";
	/** Output redirect appended after the task prompt. */
	outputRedirect: string;
	/** Watchdog-only tmux -e env injection (already interpolated; empty for the batch path). */
	extraEnvArgs: string[];
	/** Whether to kill the session when the pane-died hook fails to register: the batch path's only signal source is that hook, so it must roll back. */
	rollbackOnHookFailure: boolean;
	/** Exit file reading note (goes into the LLM context). */
	exitNote: string;
}

export function resolveCompletion(useWatchdog: boolean, paths: SubagentPaths): CompletionProfile {
	if (useWatchdog) {
		return {
			kind: "watchdog",
			piCommandPrefix: "pi",
			// Interactive pi's stdout must stay in the pane (for watchers), stderr goes to a file:
			// startup errors (bad --model, extension load failure) go to stderr and the process exits
			// at once, so without the redirect you only get exit=1 + an empty reply and no root cause.
			// Redirecting stderr does not affect the TUI.
			outputRedirect: ` 2> ${paths.logPath}`,
			extraEnvArgs: [
				"-e",
				"PI_WATCHDOG=timeout=5 max=50 mode=keep",
				// ON_STOP is one full shell chain: write 0 -> send done signal -> after a short pause, close the session
				"-e",
				`PI_WATCHDOG_ON_STOP=echo 0 > ${paths.exitFile} && TMUX= tmux -L ${SOCKET} wait-for -S ${paths.done} && sleep 0.3 && TMUX= tmux -L ${SOCKET} kill-session -t ${paths.session}`,
			],
			rollbackOnHookFailure: false,
			exitNote: "exit file 0 = clean wrap-up; non-zero or missing = failure/abnormal exit.",
		};
	}
	return {
		kind: "batch",
		piCommandPrefix: "pi -p",
		outputRedirect: ` > ${paths.logPath} 2>&1`,
		extraEnvArgs: [],
		rollbackOnHookFailure: true,
		exitNote: "Sub-agent runs in pi -p batch mode: exit file 0 = success, non-zero = failure, missing = crash/killed.",
	};
}

/**
 * tmux -e env injection shared by both wrap-up paths (watchdog-only ones are in resolveCompletion):
 * goes into the session env so pi in the pane can read it, without appearing in the launch command.
 */
export function baseEnvArgs(paths: SubagentPaths): string[] {
	return [
		// Both paths inject: marks the sub-agent process; index.ts uses it to register no tools (no nesting)
		"-e",
		`${ENV_SUBAGENT}=1`,
		// Both paths inject: a failed sub-agent self-check (missing watchdog) writes the exit and
		// sends the done signal, so the waiter fails fast instead of hanging silently
		"-e",
		`${ENV_SUB_EXIT_FILE}=${paths.exitFile}`,
		"-e",
		`${ENV_SUB_DONE}=${paths.done}`,
	];
}

/**
 * Full command chain run inside the pane. The startup prompt is passed as a positional arg: in -p
 * mode a positional arg makes pi wait for the turn to finish (sendUserMessage in a command handler
 * is fire-and-forget, so -p would exit before the background turn starts).
 */
export function buildPaneCommand(completion: CompletionProfile, flags: string[], paths: SubagentPaths): string {
	const briefTask = shQuote(`Read the brief at ${paths.briefPath} and execute it fully.`);
	const piCommand = `${completion.piCommandPrefix} ${flags.join(" ")} ${briefTask}${completion.outputRedirect}`;
	return `${piCommand}; echo $? > ${paths.exitFile}`;
}

/**
 * Sends the done signal automatically when the pane process exits (clean wrap-up/crash/killed),
 * without the sub-agent LLM: the main session can notice failure without polling. Session names
 * have a random suffix so parallel tasks each get their own done channel; the channel name has only
 * letters/digits/dashes, so single-quoting it is safe. Returns the failure reason (trimmed), or
 * undefined on success.
 */
export async function registerPaneDiedHook(paths: SubagentPaths): Promise<string | undefined> {
	const hook = await runTmux([
		"set-hook",
		"-t",
		paths.session,
		"pane-died",
		`run-shell -b 'TMUX= tmux -L ${SOCKET} wait-for -S ${paths.done}'`,
	]);
	if (hook.code === 0) return undefined;
	return (hook.stderr || hook.stdout).trim();
}
