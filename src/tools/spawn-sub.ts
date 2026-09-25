/**
 * spawn_sub 工具（主会话，任务模式的入口）：把多步/上下文很重的任务委派给
 * tmux 里隔离运行的 pi 子 agent。工具定义在此，启动编排见 launch/launch.ts。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type LaunchFn, renderResultWithOps, startedToolResult } from "./shared";

/** 注册 spawn_sub 工具（默认调用，无配置门槛） */
export function setupSpawnSub(pi: ExtensionAPI, launch: LaunchFn): void {
	pi.registerTool({
		name: "spawn_sub",
		label: "子 agent 委派",
		description:
			"Delegate a task to an isolated pi sub-agent; the full deliverable is written to a system-generated path " +
			"(/tmp/pi-sub-<session>/result.md), whose exact value is given in the tool response. " +
			"Do not put the deliverable path in `question` — the brief the sub-agent receives already carries it",
		promptSnippet: "delegate multi-step or context-heavy tasks to an isolated tmux sub-agent",
		// 只写调用前的决策信息（何时用、context 要自包含）。
		// 调用后怎么拿结论（wait-for 频道名、exit 文件判读）依赖运行时才知道的值，
		// 只能写在工具返回的 mainAgentNote 里，这里不放。
		promptGuidelines: [
			"spawn_sub: use for multi-step, exploration-heavy, or token-heavy tasks; keep single-step work in the main session.",
			"spawn_sub: distill everything the sub-agent needs into the context parameter before calling — file paths, conclusions so far, URLs, constraints.",
		],
		parameters: Type.Object({
			question: Type.String({
				description:
					"Task goal, stated precisely; define what a good deliverable looks like (depth, language, acceptance criteria)",
			}),
			context: Type.Optional(
				Type.String({
					description:
						"Session context relevant to the task: file paths, conclusions so far, URLs, user preferences or constraints. The sub-agent has zero memory of this conversation — anything not written here is unknown to it",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const r = await launch(params.question, params.context);
			return startedToolResult(r.text, r.ops);
		},
		renderResult(result, _options, theme, _context) {
			return renderResultWithOps(result, "已启动。常用操作（复制到任意终端）：", theme);
		},
	});
}
