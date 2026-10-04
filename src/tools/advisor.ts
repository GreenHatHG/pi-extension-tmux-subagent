/**
 * advisor tool (main session, optional: registered by index.ts when resolveAdvisor().enabled).
 * Tool definition and config notices. Brief template and preset flags live in modes/.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isModelDisabled, parseModelSpec } from "../core/config";
import { advisorMode } from "../modes/types";
import { onEvent } from "../registry";
import { showSubagentBrief, watchSubagentReply } from "../ui/subagent-entries";
import { type LaunchFn, renderResultWithOps, startedToolResult } from "./shared";

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

/**
 * Register the advisor tool. Model/thinking come from config and can't be changed through tool
 * args: index.ts's launch callback reads config on each call to add --model; this function handles
 * the tool definition and the registration notice.
 *
 * @param advisorModel the pi --model string resolved at session start: used for the session_start
 *                     notice and as the fallback when config can't be read at call time
 * @param launch       the launch callback injected by index.ts (wraps launchSub with mode = advisorMode)
 */
export function setupAdvisor(pi: ExtensionAPI, advisorModel: string, launch: LaunchFn): void {
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
			"Escalate to a stronger advisor model to review your plan, claim, or completed work before you act. The advisor is isolated:",
			"it sees `question` and `context` (your claims, not established facts) and, when advisor.vccCli is configured, a read-only",
			"vcc summary of this session plus recall access to the full transcript. Returns a plan, a correction, or a stop signal.",
			"The full advice is written to a system-generated path (/tmp/pi-sub-<session>/result.md), whose exact value is given in the",
			"tool response. Do not put the deliverable path in `question` — the brief the advisor receives already carries it",
		].join(" "),
		promptSnippet:
			"get a second opinion on approach/claims/done-ness; call before substantive work, when stuck, or before declaring done",
		// Rules borrowed from rpiv-advisor, rewritten for this project's "context must be self-contained" style.
		promptGuidelines: [
			"advisor: call BEFORE substantive work — before writing, before committing to an interpretation, before building on an assumption; orientation (finding files, fetching a source, seeing what's there) is not substantive work.",
			"advisor: also call when stuck (errors recurring, approach not converging, results that don't fit) or when considering a change of approach.",
			"advisor: call when you believe the task is complete — make the deliverable durable FIRST (write the file, save the result), because the advisor call takes time and a durable result survives a session that ends mid-call.",
			"advisor: write `context` as claims under audit, not established facts — state your plan/interpretation, mark which premises you verified and which you are assuming; the advisor is instructed to verify load-bearing unverified premises itself and to override your framing where the session record disagrees.",
			"advisor: every file path inside the context parameter MUST be absolute — resolve relative paths against your cwd before calling.",
			"advisor: give its advice serious weight — if a step fails empirically or evidence contradicts a specific claim, surface the conflict in another advisor call instead of silently switching branches.",
			"advisor: after each result, restate its key guidance in your next visible reply to the user — they often cannot see collapsed tool results. The full advice lives in the result.md path given in the tool response: wait for completion as instructed there, read the file, then restate what it actually says.",
			"advisor: not for trivial lookups where the next action is dictated by tool output you just read — it adds latency and pays off on judgment calls.",
		],
		parameters: Type.Object({
			question: Type.String({
				description:
					"The decision you need help with, stated precisely. This is judgment on a plan/approach/claim, not task delegation — do not paste the whole task; state what you intend to do and what you're unsure about",
			}),
			context: Type.Optional(
				Type.String({
					description: [
						"Your claims under audit, not established facts: the plan/interpretation you want reviewed plus the key premises behind it (file paths, function/line references, constraints, URLs).",
						"Mark what you verified and what you are assuming — the advisor is instructed to verify load-bearing unverified premises itself and to override your framing where the session record disagrees.",
						"File paths MUST be absolute (e.g. /Users/you/Projects/app/src/index.ts), never relative — the advisor cannot resolve them against your cwd.",
						"Anything not stated here is unknown to the advisor (except, when advisor.vccCli is configured, the read-only session forensics above)",
					].join(" "),
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// advisor runs the full spawn flow (watchdog, pane-died, exit, wait-for); only the brief and
			// the sub-agent's tools/prompt differ. The main session jsonl path is only available in
			// execute's ctx, so pass it to launch for the brief's forensics section; it may be undefined
			// before the first message lands on disk, and the brief then says forensics is unavailable.
			const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
			const r = await launch(params.question, params.context, sessionFile, ctx.sessionManager.getSessionId());
			if (r.ok) {
				// Brief/reply go through appendEntry to the TUI only, not into the LLM context
				showSubagentBrief(pi, r, advisorMode.display);
				watchSubagentReply(pi, r, advisorMode.display);
			}
			return startedToolResult(r.text, r.ops);
		},
		renderResult(result, _options, theme, _context) {
			return renderResultWithOps(result, "Advisor started (copy into any terminal to watch):", theme);
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
