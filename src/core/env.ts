/**
 * Env var names shared between the main session and sub-agents. Both the writer side
 * (launch/ injects them via tmux -e) and the reader side (resolveProcessRole) use this
 * list, so a rename only happens here.
 * This file is also the only place that reads these process env vars: other modules take
 * a parsed ProcessRole instead of touching process.env.
 */
/** Marks a sub-agent pane. The main session injects it via tmux -e. */
export const ENV_SUBAGENT = "PI_SUBAGENT";

/** Where a failed sub-agent self-check writes its non-zero exit code (tmux -e). */
export const ENV_SUB_EXIT_FILE = "PI_SUB_EXIT_FILE";

/** wait-for channel a failed sub-agent self-check uses to send the done signal (tmux -e). */
export const ENV_SUB_DONE = "PI_SUB_DONE";

/** Watchdog-only: set on the sub-agent when the main session finds the watchdog extension. */
export const ENV_WATCHDOG = "PI_WATCHDOG";

/** Marks a web-research sub-agent process. */
export const ENV_SUB_WEB = "PI_SUB_WEB";

/**
 * Process role, parsed once at factory time. tmux -e sets the env vars at startup and they
 * never change, so reading them once is the same as reading them live.
 */
export interface ProcessRole {
	/** "sub" = sub-agent pane (PI_SUBAGENT=1); "main" = main session. */
	kind: "main" | "sub";
	/** web-research bootstrap flag (PI_SUB_WEB), separate from kind. */
	web: boolean;
	/** Interactive wrap-up path (PI_WATCHDOG set); false = pi -p batch fallback. */
	watchdog: boolean;
	/** File to write a non-zero exit to when the self-check fails (PI_SUB_EXIT_FILE). */
	exitFile?: string;
	/** wait-for channel for the done signal when the self-check fails (PI_SUB_DONE). */
	done?: string;
}

/** Parse the current process role. Pure function, called once at the top of index.ts. */
export function resolveProcessRole(): ProcessRole {
	const env = process.env;
	return {
		kind: env[ENV_SUBAGENT] === "1" ? "sub" : "main",
		web: !!env[ENV_SUB_WEB]?.trim(),
		watchdog: !!env[ENV_WATCHDOG],
		exitFile: env[ENV_SUB_EXIT_FILE],
		done: env[ENV_SUB_DONE],
	};
}
