/**
 * advisor tool (main session, optional: registered by index.ts when resolveAdvisor().enabled).
 * Fork-based design: one call = the plugin forks the main session's transcript into an interactive
 * pi pane, the advisor model reviews the full verbatim history and answers in ONE round; the
 * plugin reads the judgment back and (on REDIRECT/STOP) injects it as the next user turn (steer).
 * No question/context params: the transcript is the context.
 */

import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { isModelDisabled, parseModelSpec } from "../core/config";
import { launchAdvisorFork } from "../launch/advisor-fork";
import { onEvent } from "../registry";
import { showSubagentBrief } from "../ui/subagent-entries";

/** Turn a pi --model string into a registration notice (split model and thinking). */
function advisorRegistrationMessage(advisorModel: string): string {
	const { model, thinking } = parseModelSpec(advisorModel);
	if (!model) return `advisor registered (model: ${advisorModel})`;
	const thinkingNote = thinking ? `, thinking: ${thinking}` : "";
	return `advisor registered (model: ${model}${thinkingNote})`;
}

/**
 * Narrow advisor by the main session's current model. session_start handles start/resume,
 * model_select handles in-session switches; setActiveTools rebuilds the system prompt, so from the
 * next turn the model no longer sees the disabled tool.
 */
export function setupAdvisorModelGuard(
	pi: ExtensionAPI,
	patterns: readonly string[] | undefined,
	session: { enabled: boolean; disabledByMainModel?: boolean },
): void {
	if (!patterns?.length) return;
	let restoreWhenAllowed = false;

	function apply(modelSpec: string | undefined): void {
		const disabled = isModelDisabled(patterns, modelSpec);
		session.disabledByMainModel = disabled;
		const active = pi.getActiveTools();
		if (disabled) {
			if (active.includes("advisor")) {
				restoreWhenAllowed = true;
				pi.setActiveTools(active.filter((name) => name !== "advisor"));
			}
			return;
		}
		if (restoreWhenAllowed && session.enabled && !active.includes("advisor")) {
			restoreWhenAllowed = false;
			pi.setActiveTools([...active, "advisor"]);
		}
	}

	onEvent(
		pi,
		"session_start",
		{
			where: "tools/advisor.ts:main-model filter",
			note: "On session start/resume: remove the advisor tool when the current main model hits advisor.disabledModels",
		},
		(_event: unknown, ctx: ExtensionContext) => {
			const model = ctx.model;
			apply(model ? `${model.provider}/${model.id}` : undefined);
		},
	);
	onEvent(
		pi,
		"model_select",
		{
			where: "tools/advisor.ts:main-model filter",
			note: "On in-session main-model switch: add/remove the advisor tool by advisor.disabledModels",
		},
		(event: unknown) => {
			const model = (event as { model?: { provider?: string; id?: string } }).model;
			apply(model?.provider && model.id ? `${model.provider}/${model.id}` : undefined);
		},
	);
}

/** Register the advisor tool. `getModel` re-reads config at call time (a /advisor panel change applies next call). */
export function setupAdvisor(pi: ExtensionAPI, advisorModel: string, getModel: () => string): void {
	// Explicitly tell the user advisor is registered and its model/thinking, so they don't have to trigger a call to find out
	onEvent(
		pi,
		"session_start",
		{
			where: "tools/advisor.ts:enabled notice",
			note: "When advisor is registered: session_start shows the model and thinking level (parsed from the pi --model string)",
		},
		(_event: unknown, ctx: { ui: { notify(text: string, level: string): void } }) => {
			if (pi.getActiveTools().includes("advisor")) {
				ctx.ui.notify(advisorRegistrationMessage(advisorModel), "info");
			} else {
				ctx.ui.notify("advisor is disabled for the current main model (hits advisor.disabledModels)", "warning");
			}
		},
	);

	pi.registerTool({
		name: "advisor",
		label: "Consult advisor",
		description: [
			"Escalate to a stronger advisor model when you hit a decision difficulty (errors recurring, approach not converging,",
			"results that don't fit) or when changing approach. The advisor is forked from THIS session's transcript, so it sees",
			"the full history including all tool inputs/outputs — do not restate the task; it already knows. It answers in one",
			"round with a judgment ending in VERDICT: PROCEED/REDIRECT/STOP. On REDIRECT/STOP the judgment is queued as the next",
			"user turn; on PROCEED the judgment comes back as this tool's result.",
		].join(" "),
		promptSnippet:
			"fork a stronger advisor over this session's full transcript when stuck or changing approach; it returns one verdict + judgment",
		promptGuidelines: [
			"advisor: call when stuck (errors recurring, approach not converging, results that don't fit) or when changing approach. It reads this session's full transcript itself — pass no arguments; just call it.",
			"advisor: give the advice serious weight — if a step fails empirically or evidence contradicts a specific claim, surface the conflict in another advisor call instead of silently switching branches.",
			"advisor: not for trivial lookups where the next action is dictated by tool output you just read — it adds latency and pays off on judgment calls.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Advisor not started: this session is not on disk yet (no messages persisted).",
						},
					],
					details: undefined,
				};
			}
			const r = await launchAdvisorFork(
				pi,
				sessionFile,
				ctx.sessionManager.getSessionId(),
				getModel(),
				fileURLToPath(import.meta.resolve("../launch/verdict-extension.ts")),
			);
			// TUI display of the judgment (not into the LLM context; the return value below carries it)
			if (r.judgment) {
				showSubagentBrief(
					pi,
					{ brief: r.judgment },
					{ briefLabel: "Advisor judgment", replyLabel: "Advisor judgment" },
				);
			}
			if (r.ok && r.judgment && (r.verdict === "REDIRECT" || r.verdict === "STOP")) {
				// Do NOT ctx.abort() here. In pi's TUI, ctx.abort() wires to restoreQueuedMessagesToEditor:
				// it clears the steering queue into the editor and kills the run, and the agent loop
				// returns immediately on an aborted assistant message without draining what was queued
				// after the abort — the injected judgment would sit undelivered (seen live 2026-11-04,
				// session 01a1a438: REDIRECT queued at .894, run died at .910, no continuation).
				// Instead: queue as steer. The loop drains steering after this tool batch, so the very
				// next LLM call sees the judgment as a user turn; the current tool result closes cleanly.
				pi.sendUserMessage(
					`[advisor ${r.verdict}] The advisor reviewed this session and issued a ${r.verdict}. Its judgment:\n\n${r.judgment}\n\nFollow this judgment now${r.verdict === "STOP" ? " — stop working and report to the user" : ""}.`,
					{ deliverAs: "steer" },
				);
				return {
					content: [
						{
							type: "text" as const,
							text: `Advisor issued ${r.verdict}: its judgment was queued as the next user turn — follow it now${r.verdict === "STOP" ? " (stop working and report to the user)" : ""}.`,
						},
					],
					details: undefined,
				};
			}
			return { content: [{ type: "text" as const, text: r.text }], details: undefined };
		},
		renderResult(result, _options, _theme, _context) {
			const first = result.content[0];
			return new Text(first?.type === "text" ? (first.text ?? "") : "", 0, 0);
		},
	});
}

/** When enabled: true but no model, tell the user in the session to add config. */
export function notifyAdvisorMissingModel(pi: ExtensionAPI): void {
	onEvent(
		pi,
		"session_start",
		{
			where: "tools/advisor.ts:missing model notice",
			note: "advisor.enabled: true but no advisor.model: tell the user to add config (advisor is not registered)",
		},
		(_event: unknown, ctx: { ui: { notify(text: string, level: string): void } }) => {
			ctx.ui.notify(
				"advisor is not on: subagent_advisor.json has advisor.enabled: true but no advisor.model. Set advisor.model in subagent_advisor.json or set the PI_ADVISOR_MODEL env var",
				"warning",
			);
		},
	);
}
