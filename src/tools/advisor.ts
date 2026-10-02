/**
 * advisor 工具（主会话，可选功能：resolveAdvisor().enabled 时由 index.ts 注册）。
 * 职责：工具定义与配置提示。配置解析在 core/config.ts，简报模板与预设 flag 在
 * modes/，简报/回复的 TUI 呈现（三个工具共用）在 ui/subagent-entries.ts。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isModelDisabled, parseModelSpec } from "../core/config";
import { advisorMode } from "../modes/types";
import { onEvent } from "../registry";
import { showSubagentBrief, watchSubagentReply } from "../ui/subagent-entries";
import { type LaunchFn, renderResultWithOps, startedToolResult } from "./shared";

// ---------- 工具注册 ----------

/** 把 pi 的 provider/model:thinking 配置转换为稳定的注册提示。 */
function advisorRegistrationMessage(advisorModel: string): string {
	const { model, thinking } = parseModelSpec(advisorModel);
	if (!model) return `advisor 已注册（模型：${advisorModel}）`;
	const thinkingNote = thinking ? `，思考档位：${thinking}` : "";
	return `advisor 已注册（模型：${model}${thinkingNote}）`;
}

/**
 * 按主会话当前模型收窄 advisor。session_start 处理启动/恢复，model_select 处理会话内切换；
 * setActiveTools 会重建系统提示词，因此下一轮开始时模型看不到已禁用的工具。
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
			where: "tools/advisor.ts:主模型过滤",
			note: "启动/恢复会话时：当前主模型命中 advisor.disabledModels 则移除 advisor 工具",
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
			where: "tools/advisor.ts:主模型过滤",
			note: "会话内切换主模型时：按 advisor.disabledModels 动态增删 advisor 工具",
		},
		(event: unknown) => {
			const model = (event as { model?: { provider?: string; id?: string } }).model;
			apply(model?.provider && model.id ? `${model.provider}/${model.id}` : undefined);
		},
	);
}

/**
 * 注册 advisor 工具。模型/thinking 由配置决定，不可通过工具参数干预：index.ts 的 launch
 * 回调在**每次调用时**现读配置补 `--model`（/advisor 面板改完下次调用即生效），这里管工具
 * 定义与注册提示。
 *
 * @param advisorModel 会话启动时解析出的 pi --model 串（"provider/id:thinking"）：用于 session_start
 *                     提示，并作为调用时读不到配置的兜底
 * @param launch       index.ts 注入的启动回调（包一层 launchSub，mode = advisorMode）
 */
export function setupAdvisor(pi: ExtensionAPI, advisorModel: string, launch: LaunchFn): void {
	// 显式提示：开启时让用户在会话里能直接看到 advisor 已注册及其模型/思考档位，
	// 不用靠问模型或触发调用来确认。模型串格式为 pi --model 的 "provider/id:thinking"，
	// ":" 后是思考档位（如 max/high），没有 ":" 就只展示模型。
	onEvent(
		pi,
		"session_start",
		{
			where: "tools/advisor.ts:开启提示",
			note: "advisor 已注册时：session_start 提示模型与思考档位（解析 pi --model 格式串）",
		},
		(_event: unknown, ctx: { ui: { notify(text: string, level: string): void } }) => {
			if (pi.getActiveTools().includes("advisor")) {
				ctx.ui.notify(advisorRegistrationMessage(advisorModel), "info");
			} else {
				ctx.ui.notify("advisor 已按当前主模型禁用（命中 advisor.disabledModels）", "warning");
			}
		},
	);

	pi.registerTool({
		name: "advisor",
		label: "咨询 advisor",
		description: [
			"Escalate to a stronger advisor model to review your plan, claim, or completed work before you act. The advisor is isolated:",
			"it sees `question` and `context` (your claims, not established facts) and, when advisor.vccCli is configured, a read-only",
			"vcc summary of this session plus recall access to the full transcript. Returns a plan, a correction, or a stop signal.",
			"The full advice is written to a system-generated path (/tmp/pi-sub-<session>/result.md), whose exact value is given in the",
			"tool response. Do not put the deliverable path in `question` — the brief the advisor receives already carries it",
		].join(" "),
		promptSnippet:
			"get a second opinion on approach/claims/done-ness; call before substantive work, when stuck, or before declaring done",
		// 取材 rpiv-advisor 的规则，按本项目「context 需自包含」的调用方式改写。
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
			// advisor 也走完整的 spawn 流程（watchdog、pane-died 钩子、exit 文件、
			// wait-for 协议），只是换了 brief 模板和子 agent 的工具/提示词。
			// 主会话 jsonl 路径只能在 execute 的 ctx 拿到（ExtensionAPI 无 sessionManager），
			// 传给 launch 写进简报的取证栏目（recall CLI 以路径为参数，无需环境变量注入）；
			// 首条消息落盘前可能为 undefined，简报会声明取证不可用。
			const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
			const r = await launch(params.question, params.context, sessionFile);
			if (r.ok) {
				// 简报 + 完成后回复都只进 TUI（appendEntry，不进 LLM 上下文），
				// 等待/读取协议不受影响（见 ui/subagent-entries.ts）。
				showSubagentBrief(pi, r, advisorMode.display);
				watchSubagentReply(pi, r, advisorMode.display);
			}
			return startedToolResult(r.text, r.ops);
		},
		renderResult(result, _options, theme, _context) {
			return renderResultWithOps(result, "已启动 advisor（复制到任意终端围观）：", theme);
		},
	});
}

/** enabled: true 而没配 model 时，在会话里提示用户补配置 */
export function notifyAdvisorMissingModel(pi: ExtensionAPI): void {
	onEvent(
		pi,
		"session_start",
		{
			where: "tools/advisor.ts:缺模型提示",
			note: "advisor.enabled: true 但没配 advisor.model 时：提示用户补配置（此时 advisor 未注册）",
		},
		(_event: unknown, ctx: { ui: { notify(text: string, level: string): void } }) => {
			ctx.ui.notify(
				"advisor 未开启：subagent_advisor.json 配了 advisor.enabled: true 但没有 advisor.model。请在 subagent_advisor.json 配置 advisor.model 或设置环境变量 PI_ADVISOR_MODEL",
				"warning",
			);
		},
	);
}
