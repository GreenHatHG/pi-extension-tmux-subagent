import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveAdvisor, resolveAdvisorModel } from "./core/config";
import { resolveProcessRole } from "./core/env";
import { shQuote } from "./core/tmux";
import { launchSub } from "./launch/launch";
import { advisorMode, taskMode, webResearchMode } from "./modes/types";
import { setupSubagentSelfCheck } from "./session/gate";
import { setupSubagentReaper } from "./session/reap";
import { bootstrapWebResearch } from "./session/web-bootstrap";
import { notifyAdvisorMissingModel, setupAdvisor, setupAdvisorModelGuard } from "./tools/advisor";
import { type SessionAdvisor, setupAdvisorSettings } from "./tools/advisor-settings";
import { setupSpawnSub } from "./tools/spawn-sub";
import { setupWebResearch } from "./tools/web-research";
import { setupAttachCommand } from "./ui/attach-command";
import { registerSubagentEntryRenderers } from "./ui/subagent-entries";

export default async function (pi: ExtensionAPI) {
	// Parse the process role once; every main-session/sub-agent branch uses role after that
	const role = resolveProcessRole();

	// web-research sub-agent bootstrap: triggered only by role.web (PI_SUB_WEB), separate from the
	// PI_SUBAGENT gate. Must run before the sub-agent branch returns: the sub-agent process loads
	// the pi-web-access tool set at load time. role.web is false in the main session.
	if (role.web) await bootstrapWebResearch(pi);

	// Register no tools inside a sub-agent pane (no nested delegation): the gate always applies.
	// setupSubagentSelfCheck decides whether to register the missing-watchdog self-check by role.watchdog.
	if (role.kind === "sub") {
		setupSubagentSelfCheck(pi, role);
		return;
	}

	// ---------- no orphan panes ----------
	// A pane left behind keeps running commands on the user's machine with nobody watching, so
	// closing this main session closes the panes it started (session/reap.ts)
	setupSubagentReaper(pi);

	// ---------- /attach live watch window ----------
	// Open a window in the user's own tmux and attach to a pi-sub sub-agent session
	setupAttachCommand(pi);

	// ---------- TUI display of sub-agent briefs/replies ----------
	// Decoupled from tool registration: all three tools share one renderer, and labels come from
	// each mode's SubagentMode.display
	registerSubagentEntryRenderers(pi);

	// ---------- advisor (optional, off by default: the main model can't see this tool when unconfigured) ----------
	const advisor = resolveAdvisor();
	const advisorSession: SessionAdvisor = { enabled: advisor.enabled, model: advisor.model };
	// Register the guard before the footer/startup notices: on session_start it updates state from
	// ctx.model first, so later handlers show the final state.
	if (advisor.enabled && advisor.model) {
		setupAdvisorModelGuard(pi, advisor.disabledModels, advisorSession);
	}
	// The settings command is always registered (regardless of enabled), else there is no way to
	// turn advisor back on once it is off
	setupAdvisorSettings(pi, advisorSession);
	if (advisor.enabled && advisor.model) {
		const sessionModel = advisor.model;
		setupAdvisor(pi, sessionModel, (question, context, sessionFile, parentSessionId) => {
			// Read model/thinking from config on every call (a /advisor panel change applies next call);
			// if missing (cleared), fall back to the model from session start
			const model = resolveAdvisorModel() ?? sessionModel;
			return launchSub(pi, question, context, advisorMode, [`--model ${shQuote(model)}`], {
				sessionFile,
				vccCli: advisor.vccCli,
				parentSessionId,
			});
		});
	} else if (advisor.missingModel) {
		// enabled: true with no model: stay off and tell the user in the session to add config
		notifyAdvisorMissingModel(pi);
	}

	// ---------- web_research (on by default) ----------
	setupWebResearch(pi, (question, context, _sessionFile, parentSessionId) =>
		launchSub(pi, question, context, webResearchMode, [], { parentSessionId }),
	);

	// ---------- spawn_sub (task mode, on by default) ----------
	setupSpawnSub(pi, (question, context, _sessionFile, parentSessionId) =>
		launchSub(pi, question, context, taskMode, [], { parentSessionId }),
	);
}
