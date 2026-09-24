/**
 * 扩展入口（纯接线）：子 agent 门禁与自检、advisor 开关、spawn_sub 工具注册。
 * 各职责的实现所在：
 * - selfcheck.ts：子 agent pane 内的门禁 + watchdog 缺位时的自检
 * - launch.ts：子 agent 启动编排（launchSub，含 ops 速查/等待说明文案）
 * - completion.ts：两条收尾路径（watchdog 交互式 / pi -p 批处理）的差异收敛
 * - brief.ts / paths.ts / tmux.ts：简报模板、/tmp 运行目录布局、tmux 原语
 * - advisor.ts：advisor 配置解析、简报模板与工具定义
 * - web-research.ts：web_research 工具（默认开启）与子 agent 联网工具的引导激活
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { notifyAdvisorMissingModel, resolveAdvisor, setupAdvisor } from "./advisor";
import { launchSub } from "./launch";
import { setupSelfCheck } from "./selfcheck";
import { shQuote } from "./tmux";
import { bootstrapWebResearch, setupWebResearch } from "./web-research";

export default async function (pi: ExtensionAPI) {
	// web-research 子 agent 引导：必须在 setupSelfCheck 的子 agent 提前 return 之前执行。
	// 主会话进程无 PI_SUB_WEB，直接空操作；web-research 子 agent 进程在 load 阶段
	// 动态激活 pi-web-access 工具集（见 web-research.ts）。
	await bootstrapWebResearch(pi);
	// 子 agent pane 内（启动时经 tmux -e 注入 PI_SUBAGENT=1）不注册任何工具，直接返回：
	// 门禁无条件生效（防嵌套委派，替代原先的 promptGuidelines 软约束），watchdog 缺位
	// 的自检钩子是否注册由 setupSelfCheck 按 PI_WATCHDOG 注入与否决定，见 selfcheck.ts。
	if (setupSelfCheck(pi)) return;

	// ---------- advisor（可选功能）----------
	// 默认不注册：未配置时主模型看不到这个工具，promptGuidelines 也不会注入（零开销）。
	// 开关与工具定义见 advisor.ts；这里只负责把 launchSub 包成 AdvisorLaunch 回调，
	// 并补 --model 预设（advisor 模型/thinking 完全由配置决定，模型不可干预）。
	const advisor = resolveAdvisor();
	if (advisor.enabled && advisor.model) {
		const advisorModel = advisor.model;
		// enabled 蕴含 model 非空（resolveAdvisor 保证）：沿用默认模型就没有 advisor 的意义
		setupAdvisor(pi, (question, context) =>
			launchSub(pi, question, context, { mode: "advisor", extraArgs: [`--model ${shQuote(advisorModel)}`] }),
		);
		// 显式提示：开启时让用户在会话里能直接看到 advisor 已注册及其模型/思考档位，
		// 不用靠问模型或触发调用来确认。模型串格式为 pi --model 的 "provider/id:thinking"，
		// ":" 后是思考档位（如 max/high），没有 ":" 就只展示模型。
		pi.on("session_start", (_event, ctx) => {
			const colon = advisorModel.lastIndexOf(":");
			const model = colon > 0 ? advisorModel.slice(0, colon) : advisorModel;
			const thinking = colon > 0 ? advisorModel.slice(colon + 1) : undefined;
			ctx.ui.notify(`advisor 已注册（模型：${model}${thinking ? `，思考档位：${thinking}` : ""}）`, "info");
		});
	} else if (advisor.missingModel) {
		// 配了 enabled: true 但没配模型：不开启，直接在会话里提示用户补配置
		notifyAdvisorMissingModel(pi);
	}

	// ---------- web_research（默认开启）----------
	// 联网搜索/抓取一律委派给 web-research 子 agent：原始搜索结果与网页内容隔离在子
	// agent 上下文里，主会话只读蒸馏后的结论。工具定义与子 agent 引导见 web-research.ts。
	setupWebResearch(pi, (question, context) => launchSub(pi, question, context, { mode: "web-research" }));

	// ---------- spawn_sub ----------
	pi.registerTool({
		name: "spawn_sub",
		label: "子 agent 委派",
		description: "Delegate a task to an isolated pi sub-agent; deliverable written to /tmp/pi-sub-<name>/result.md",
		promptSnippet: "delegate multi-step or context-heavy tasks to an isolated tmux sub-agent",
		// 只写调用前的决策信息（何时用、context 要自包含）。
		// 调用后怎么拿结论（wait-for 频道名、exit 文件判读）依赖运行时才知道的值，
		// 只能写在工具返回的 mainAgentNote 里，这里不放。
		promptGuidelines: [
			"Use spawn_sub when a task needs many steps, heavy exploration, or lots of tokens; keep single-step work in the main session.",
			"Before calling spawn_sub, distill everything the sub-agent needs into the context parameter (file paths, conclusions, URLs, constraints) — it has zero memory of this conversation.",
		],
		parameters: Type.Object({
			question: Type.String({
				description:
					"Task goal, stated precisely; define what a good deliverable looks like (depth, language, acceptance criteria). Do not include the deliverable path — the directory is fixed at /tmp/pi-sub-<name>/result.md and the brief carries it",
			}),
			context: Type.Optional(
				Type.String({
					description:
						"Session context relevant to the task: file paths, conclusions so far, URLs, user preferences or constraints. The sub-agent has zero memory of this conversation — anything not written here is unknown to it",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const r = await launchSub(pi, params.question, params.context);
			return {
				content: [{ type: "text", text: r.text }],
				details: { ops: r.ops },
			};
		},
		renderResult(result, _options, theme, _context) {
			const ops = (result.details as { ops?: string } | undefined)?.ops;
			if (!ops) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}
			return new Text(theme.fg("muted", `已启动。常用操作（复制到任意终端）：\n${ops}`), 0, 0);
		},
	});
}
