/**
 * web_research tool (main session, on by default): all web search/fetch is delegated to a
 * web-research sub-agent, so raw search results and page content stay in the sub-agent's context
 * and the main session only reads the distilled conclusions.
 * In-process bootstrap for the sub-agent: session/web-bootstrap.ts.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { webResearchMode } from "../modes/types";
import { showSubagentBrief, watchSubagentReply } from "../ui/subagent-entries";
import { type LaunchFn, renderResultWithOps, startedToolResult } from "./shared";

/** Register the web_research tool. */
export function setupWebResearch(pi: ExtensionAPI, launch: LaunchFn): void {
	pi.registerTool({
		name: "web_research",
		label: "Web research",
		description: [
			"Delegate a web-research task to an isolated pi sub-agent in tmux. The sub-agent runs the web searches and",
			"page fetches itself; only distilled conclusions with source URLs enter this conversation. The full deliverable is",
			"written to a system-generated path (/tmp/pi-sub-<session>/result.md), whose exact value is given in the tool response.",
			"Do not put the deliverable path in `question` — the brief the sub-agent receives already carries it",
		].join(" "),
		promptSnippet: "delegate web search/fetch to an isolated tmux sub-agent; only distilled conclusions return",
		// Strong nudge: the main session has no web tools by default, so all search/fetch must go
		// through here to keep raw page content out of the main-session context
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
					description: [
						"Self-contained context the sub-agent needs: URLs, conclusions so far, user preferences or constraints.",
						"It has zero memory of this conversation — anything not written here is unknown to it",
					].join(" "),
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const r = await launch(params.question, params.context, undefined, ctx.sessionManager.getSessionId());
			if (r.ok) {
				// Brief/reply go through appendEntry to the TUI only, not into the LLM context
				showSubagentBrief(pi, r, webResearchMode.display);
				watchSubagentReply(pi, r, webResearchMode.display);
			}
			return startedToolResult(r.text, r.ops);
		},
		renderResult(result, _options, theme, _context) {
			return renderResultWithOps(result, "Web-research sub-agent started (copy into any terminal to watch):", theme);
		},
	});
}
