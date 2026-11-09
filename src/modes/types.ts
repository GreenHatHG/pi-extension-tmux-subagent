/**
 * Mode framework: task / web-research / verification differences are collapsed into one
 * SubagentMode descriptor. launchSub only sees this interface, so a new mode = one instance + a
 * brief/preset if needed.
 *
 * (advisor left this framework: it forks the main session's transcript instead of getting a brief,
 * see launch/advisor-fork.ts and tools/advisor.ts.)
 *
 * Three axes of mode difference: brief (brief template), presetFlags (sub-agent pi CLI flags),
 * display (TUI label).
 */
import { buildTaskBrief, buildVerificationBrief, buildWebResearchBrief } from "./briefs";
import { verificationPresetFlags, webResearchPresetFlags } from "./presets";

/** Labels for brief/reply entries in the TUI (the modes share one renderer). */
export interface SubagentDisplay {
	briefLabel: string;
	replyLabel: string;
}

export type ModeName = "task" | "web-research" | "verification";

export interface SubagentMode {
	name: ModeName;
	/** Sub-agent brief template. */
	brief(question: string, context: string | undefined, artifactPath: string, useWatchdog: boolean): string;
	/**
	 * Preset CLI flags for the sub-agent pi (put first in the launch args; caller extraArgs come
	 * after, and pi single-value flags are last-wins).
	 */
	presetFlags(useWatchdog: boolean): string[];
	/** TUI labels for brief/reply. */
	display: SubagentDisplay;
}

export const taskMode: SubagentMode = {
	name: "task",
	brief: buildTaskBrief,
	presetFlags: () => [],
	display: { briefLabel: "Sub-agent brief", replyLabel: "Sub-agent reply" },
};

export const verificationMode: SubagentMode = {
	name: "verification",
	brief: buildVerificationBrief,
	presetFlags: verificationPresetFlags,
	display: { briefLabel: "Verification brief", replyLabel: "Verification reply" },
};

export const webResearchMode: SubagentMode = {
	name: "web-research",
	brief: buildWebResearchBrief,
	presetFlags: () => webResearchPresetFlags(),
	display: { briefLabel: "Web research brief", replyLabel: "Web research reply" },
};
