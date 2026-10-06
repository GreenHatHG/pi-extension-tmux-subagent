/**
 * Sub-agent launch orchestration: pick a mode -> prep the brief and run dir -> start the tmux pane
 * -> register the done-signal hook. All mode differences come from SubagentMode (modes/types.ts),
 * and all wrap-up protocol differences come from CompletionProfile.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	baseEnvArgs,
	buildPaneCommand,
	type CompletionProfile,
	isWatchdogAvailable,
	registerPaneDiedHook,
	resolveCompletion,
	WATCHDOG_TOOL,
} from "../completion/profile";
import { kebab, resolvePaths, type SubagentPaths, shortId } from "../core/paths";
import { runTmux, SOCKET, styleSubagentSession } from "../core/tmux";
import { type SubagentMode, taskMode } from "../modes/types";
import { runVccCompact, type VccSummary } from "../modes/vcc";

/**
 * The session name has a random suffix so this normally won't hit; but even in the fallback case we
 * don't start a duplicate — report the current state and let the user decide.
 * Returns the error text on a hit; undefined = safe to start.
 */
async function existingSessionReport(session: string): Promise<string | undefined> {
	const has = await runTmux(["has-session", "-t", session]);
	if (has.code !== 0) return undefined;
	const ls = await runTmux(["ls"]);
	return `Session ${session} already exists, not starting another one.\nSessions on the ${SOCKET} socket:\n${ls.stdout || ls.stderr}`;
}

/**
 * Create the run dir and write the brief (owner-only perms). A leftover exit file from a same-named
 * task would poison this run's success check, so clear it before launch.
 */
function prepareRunDir(paths: SubagentPaths, brief: string): void {
	mkdirSync(paths.dir, { recursive: true });
	writeFileSync(paths.briefPath, brief, { mode: 0o600 });
	try {
		rmSync(paths.exitFile, { force: true });
	} catch {
		/* ignore */
	}
}

/**
 * Wait/read instructions for the main-session LLM. The wait command has a timeout so it can't hang
 * forever; on timeout just resend it (tmux remembers the signal, see wait-for semantics); if it
 * times out 2-3 times in a row and the session is still there, capture-pane to see what's going on
 * — this covers cases where the signal never comes (the LLM forgot the watchdog_decide call / watchdog max
 * nudges ran out / watchdog never took over).
 *
 * wait-for semantics (tested): a signal sent with -S is remembered by the server, so a later
 * wait-for returns at once — there is no "signal lost in the wait gap, resend blocks forever"
 * problem. But waiting must be bounded: the signal may never come, and a hung waiter is worse than
 * a timed-out one.
 */
function buildMainAgentNote(paths: SubagentPaths, exitNote: string): string {
	return `To get the result, run in bash: tmux -L ${SOCKET} wait-for ${paths.done}. Waiting must be bounded: use the bash tool's own timeout argument (600s is a good pick; it is a tool-call argument, do not add a shell timeout prefix inside the command). Blocking waits cost zero tokens. On timeout just resend this command to keep waiting (tmux remembers sent signals, so it won't block forever). If it times out 2-3 times in a row and \`TMUX= tmux -L ${SOCKET} has-session -t ${paths.session}\` still shows the session: run \`tmux -L ${SOCKET} capture-pane -t ${paths.session} -p | tail -30\` to see what's up — the sub-agent may have skipped a ${WATCHDOG_TOOL} call or be stuck, so keep waiting or kill-session and treat it as failed. After it returns, read ${paths.artifactPath}. If exit is non-zero or the reply is empty, read ${paths.logPath} for the sub-agent's stderr to find the root cause. ${exitNote}`;
}

export interface LaunchResult {
	ok: boolean;
	/** Note for the main-session model (goes into the LLM context; keep it short). */
	text: string;
	/** Operator cheatsheet for the user (TUI only, not in the LLM context). */
	ops?: string;
	/** Brief text (main session appendEntry into the TUI, not in the LLM context). */
	brief?: string;
	session?: string;
	artifactPath?: string;
	exitFile?: string;
	done?: string;
	logPath?: string;
}

/** Common operator commands: attach/watch, check progress, read deliverable, wait for done, kill session. Ready to copy-paste. */
function opsCheatsheet(session: string, artifactPath: string, exitFile: string, done: string): string {
	return `# Watch the sub-agent live (recommended: /attach in the main session opens a popup — press prefix key d to leave; it only detaches and does not affect the sub-agent. The session closes itself when the task is done; read the pi session history jsonl to review the run)
# Note: attaching nested inside your own tmux eats the prefix key first — Ctrl-b d detaches the whole tmux; to leave the inner one press the prefix twice (Ctrl-b Ctrl-b d), or just use /attach
tmux -L pi-sub attach -t ${session}

# Check current progress without entering (grabs the last screen)
tmux -L pi-sub capture-pane -t ${session} -p | tail -30

# List all running sub-agents
tmux -L pi-sub ls

# Read the deliverable (after it is written)
cat ${artifactPath}

# Block until it finishes (the sub-agent sends a signal when done, or when the process exits, either way; the command returns right after)
# Run it with the tool's timeout (e.g. 600s): tmux remembers sent signals, so on timeout
# just resend this command (it won't block forever); if it times out several times and
# tmux -L pi-sub has-session -t <session> still shows the session, use capture-pane above
# to see what's up — the sub-agent may have skipped a ${WATCHDOG_TOOL} call or be stuck; keep waiting
# or kill-session and treat it as failed
tmux -L pi-sub wait-for ${done}

# Exit code (0 = clean wrap-up; non-zero = failure; missing file = killed/crash)
cat ${exitFile}

# Kill just this sub-agent
tmux -L pi-sub kill-session -t ${session}

# Final cleanup after everything (clears all leftovers on the dedicated socket, not your own tmux)
tmux -L pi-sub kill-server`;
}

/** Assemble the success result: the cheatsheet goes only to the user (details are rendered by renderResult, not into the LLM context); the wait instructions go into the LLM context. */
function startedResult(paths: SubagentPaths, completion: CompletionProfile, brief: string): LaunchResult {
	return {
		ok: true,
		text: `Sub-agent started (deliverable: ${paths.artifactPath}). ${buildMainAgentNote(paths, completion.exitNote)}`,
		ops: opsCheatsheet(paths.session, paths.artifactPath, paths.exitFile, paths.done),
		session: paths.session,
		artifactPath: paths.artifactPath,
		exitFile: paths.exitFile,
		done: paths.done,
		logPath: paths.logPath,
		brief,
	};
}

/**
 * Start an isolated pi sub-agent. Defaults to task mode (taskMode): the brief, tool set and system
 * prompt for advisor / web-research modes come from their own SubagentMode.
 */
export async function launchSub(
	pi: ExtensionAPI,
	question: string,
	context: string | undefined,
	mode: SubagentMode = taskMode,
	extraArgs: string[] = [],
	opts?: {
		/** Advisor forensics: main-session jsonl path and pi-vcc CLI command, passed to the brief's forensics section. */
		sessionFile?: string;
		vccCli?: string;
		/** Main session ID that started this sub-agent. */
		parentSessionId?: string;
	},
): Promise<LaunchResult> {
	if (!question.trim()) {
		return { ok: false, text: "Missing task description (question)." };
	}

	const useWatchdog = isWatchdogAvailable(pi);
	const parentSessionId = opts?.parentSessionId;
	if (!parentSessionId) {
		return { ok: false, text: "Could not figure out the current main session; sub-agent not started." };
	}
	const paths = resolvePaths(`${kebab(question)}-${shortId()}`);
	const completion = resolveCompletion(useWatchdog, paths);

	const clash = await existingSessionReport(paths.session);
	if (clash) {
		return { ok: false, text: clash };
	}

	// Advisor forensics step 1: pre-generate the vcc compressed summary (create the dir first; a
	// failure does not block, the brief falls back to recall-only)
	let vccSummary: VccSummary | undefined;
	if (opts?.sessionFile && opts?.vccCli) {
		mkdirSync(paths.dir, { recursive: true });
		vccSummary = await runVccCompact(opts.vccCli, opts.sessionFile, join(paths.dir, "vcc-summary.md"));
	}

	const brief = mode.brief(question, context, paths.artifactPath, useWatchdog, {
		sessionFile: opts?.sessionFile,
		vccCli: opts?.vccCli,
		vccSummary,
	});
	prepareRunDir(paths, brief);

	// Mode preset flags first, caller extraArgs after: for single-value flags like
	// --model/--tools/--system-prompt, pi uses last-wins, so the caller can override a same-named flag.
	const flags: string[] = [...mode.presetFlags(useWatchdog), ...extraArgs];

	// -e is a new-session argument and must follow new-session; putting it in the tmux global
	// option position gives "unknown option -- e"
	const launch = await runTmux([
		"new-session",
		...baseEnvArgs(paths),
		...completion.extraEnvArgs,
		...mode.extraEnvArgs(),
		"-d",
		"-s",
		paths.session,
		"-x",
		"220",
		"-y",
		"50",
		buildPaneCommand(completion, flags, paths),
	]);
	if (launch.code !== 0) {
		return { ok: false, text: `tmux launch failed: ${launch.stderr || launch.stdout}` };
	}

	// Also write a tmux session option: list-sessions can then bring back the owner in one shot,
	// no per-session show-environment; the startup env vars still serve the sub-agent process.
	await runTmux(["set-option", "-t", paths.session, "@pi-sub-parent-session", parentSessionId]);

	// Watch popup look: give the sub-session a status bar that differs from the main tmux. Pure
	// decoration; a failure just means no color.
	await styleSubagentSession(paths.session);

	const hookError = await registerPaneDiedHook(paths);
	if (hookError) {
		if (completion.rollbackOnHookFailure) {
			// The batch path doesn't rely on the LLM to send a signal; the pane-died hook is the only
			// source, so a failure must roll back
			await runTmux(["kill-session", "-t", paths.session]);
			return {
				ok: false,
				text: `Failed to register the pane-died hook (${hookError}); session reclaimed. The done signal can't be guaranteed, so the sub-agent was not started.`,
			};
		}
		// Watchdog path does not roll back: the ON_STOP hook still sends the signal, we just lose the crash backstop
		return {
			ok: true,
			text: `Sub-agent started, but the pane-died hook failed to register (${hookError}): a crash no longer sends the done signal automatically, so watch it by hand or check on timeout. Deliverable: ${paths.artifactPath}`,
			session: paths.session,
			artifactPath: paths.artifactPath,
			exitFile: paths.exitFile,
			done: paths.done,
			logPath: paths.logPath,
		};
	}

	return startedResult(paths, completion, brief);
}
