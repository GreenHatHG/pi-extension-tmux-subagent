/**
 * web_research 工具（主会话，默认开启）：联网搜索/抓取一律委派给 web-research 子
 * agent——原始搜索结果与网页内容隔离在子 agent 上下文里，主会话只读蒸馏后的结论。
 * 与 spawn_sub 同一条 tmux 流程，只是换了 brief 模板、子 agent 工具集、系统提示词，
 * 并注入联网引导环境变量（modes/types.ts 的 webResearchMode 收敛全部差异）。
 * 子 agent 进程内的引导见 session/web-bootstrap.ts。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type LaunchFn, renderResultWithOps, startedToolResult } from "./shared";

/** 注册 web_research 工具（默认开启，无配置门槛） */
export function setupWebResearch(pi: ExtensionAPI, launch: LaunchFn): void {
	pi.registerTool({
		name: "web_research",
		label: "联网调研",
		description:
			"Delegate a web-research task to an isolated pi sub-agent in tmux. The sub-agent runs the web searches and " +
			"page fetches itself; only distilled conclusions with source URLs enter this conversation. The full deliverable is " +
			"written to a system-generated path (/tmp/pi-sub-<session>/result.md), whose exact value is given in the tool response. " +
			"Do not put the deliverable path in `question` — the brief the sub-agent receives already carries it",
		promptSnippet: "delegate web search/fetch to an isolated tmux sub-agent; only distilled conclusions return",
		// 强导向：主会话默认不带任何联网工具（联网能力只存在于 web-research 子 agent），
		// 一切搜索/抓取都必须走这里，防止原始网页内容进入主会话上下文。
		promptGuidelines: [
			"web_research: ALL web search and page fetch goes through this tool — the main session has no direct web access by design; raw search results and page content must never enter this conversation.",
			"web_research: distill everything the sub-agent needs into the context parameter — the precise question, known URLs, facts so far, constraints (language, recency, depth).",
			"web_research: not for local questions answerable from files in this repo — keep those in the main session.",
		],
		parameters: Type.Object({
			question: Type.String({
				description:
					"The research question, stated precisely: what a good answer looks like (depth, language, recency, acceptance criteria)",
			}),
			context: Type.Optional(
				Type.String({
					description:
						"Self-contained context the sub-agent needs: URLs, conclusions so far, user preferences or constraints. " +
						"It has zero memory of this conversation — anything not written here is unknown to it",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const r = await launch(params.question, params.context);
			return startedToolResult(r.text, r.ops);
		},
		renderResult(result, _options, theme, _context) {
			return renderResultWithOps(result, "已启动联网调研子 agent（复制到任意终端围观）：", theme);
		},
	});
}
