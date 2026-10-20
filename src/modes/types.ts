/**
 * Mode framework: task / advisor / web-research differences are collapsed into one SubagentMode
 * descriptor. launchSub only sees this interface, so a new mode = one instance + a brief/preset
 * if needed.
 *
 * Four axes of mode difference: brief (brief template), presetFlags (sub-agent pi CLI flags),
 * extraEnvArgs (extra tmux -e injection), display (TUI label).
 */
import { ENV_BASH_GUARD_MODE, ENV_SUB_WEB } from "../core/env";
import {
	type BriefOpts,
	buildAdvisorBrief,
	buildTaskBrief,
	buildVerificationBrief,
	buildWebResearchBrief,
} from "./briefs";
import { advisorPresetFlags, verificationPresetFlags, webResearchPresetFlags } from "./presets";

/** Labels for brief/reply entries in the TUI (all three modes share one renderer). */
export interface SubagentDisplay {
	briefLabel: string;
	replyLabel: string;
}

export type ModeName = "task" | "advisor" | "web-research" | "verification";

export interface SubagentMode {
	name: ModeName;
	/** Sub-agent brief template. opts is optional: used by the advisor forensics section (task / web-research ignore it). */
	brief(
		question: string,
		context: string | undefined,
		artifactPath: string,
		useWatchdog: boolean,
		opts?: BriefOpts,
	): string;
	/**
	 * Preset CLI flags for the sub-agent pi (put first in the launch args; caller extraArgs come
	 * after, and pi single-value flags are last-wins).
	 */
	presetFlags(useWatchdog: boolean): string[];
	/** Extra tmux -e injection (name/value pairs). */
	extraEnvArgs(): string[];
	/** TUI labels for brief/reply. */
	display: SubagentDisplay;
}

export const taskMode: SubagentMode = {
	name: "task",
	brief: buildTaskBrief,
	presetFlags: () => [],
	extraEnvArgs: () => [],
	display: { briefLabel: "Sub-agent brief", replyLabel: "Sub-agent reply" },
};

export const advisorMode: SubagentMode = {
	name: "advisor",
	brief: buildAdvisorBrief,
	presetFlags: advisorPresetFlags,
	// bash-guard turns this into a read-only command fence: the advisor judges, it does not work.
	// Harmless when the extension is absent, since nothing else reads the var.
	extraEnvArgs: () => ["-e", `${ENV_BASH_GUARD_MODE}=advisor`],
	display: { briefLabel: "Advisor brief", replyLabel: "Advisor reply" },
};

export const verificationMode: SubagentMode = {
	name: "verification",
	brief: buildVerificationBrief,
	presetFlags: verificationPresetFlags,
	// Deliberately NO bash-guard env (unlike advisor): the verifier must run builds/tests, which
	// write artifacts. "Don't modify the project" is enforced by the tool whitelist + system prompt.
	extraEnvArgs: () => [],
	display: { briefLabel: "Verification brief", replyLabel: "Verification reply" },
};

export const webResearchMode: SubagentMode = {
	name: "web-research",
	brief: buildWebResearchBrief,
	presetFlags: () => webResearchPresetFlags(),
	// web-research bootstrap: the sub-agent process loads the pi-web-access tool set at load time
	extraEnvArgs: () => ["-e", `${ENV_SUB_WEB}=1`],
	display: { briefLabel: "Web research brief", replyLabel: "Web research reply" },
};
