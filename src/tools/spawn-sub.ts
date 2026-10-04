/**
 * spawn_sub tool (main session, task mode): delegate a multi-step or context-heavy task to a pi
 * sub-agent isolated in tmux. Launch orchestration is in launch/launch.ts.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { taskMode } from "../modes/types";
import { showSubagentBrief, watchSubagentReply } from "../ui/subagent-entries";
import { type LaunchFn, renderResultWithOps, startedToolResult } from "./shared";

/** Register the spawn_sub tool. */
export function setupSpawnSub(pi: ExtensionAPI, launch: LaunchFn): void {
	pi.registerTool({
		name: "spawn_sub",
		label: "Sub-agent delegation",
		description: [
			"Delegate a task to an isolated pi sub-agent; the full deliverable is written to a system-generated path",
			"(/tmp/pi-sub-<session>/result.md), whose exact value is given in the tool response.",
			"Do not put the deliverable path in `question` — the brief the sub-agent receives already carries it",
		].join(" "),
		promptSnippet: "delegate multi-step or context-heavy tasks to an isolated tmux sub-agent",
		// Only the pre-call decision info goes here; how to get the result after the call (wait-for
		// channel, exit reading) depends on runtime values, so it can only live in the mainAgentNote
		// returned by the tool
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
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const r = await launch(params.question, params.context, undefined, ctx.sessionManager.getSessionId());
			if (r.ok) {
				// Brief/reply go through appendEntry to the TUI only, not into the LLM context
				showSubagentBrief(pi, r, taskMode.display);
				watchSubagentReply(pi, r, taskMode.display);
			}
			return startedToolResult(r.text, r.ops);
		},
		renderResult(result, _options, theme, _context) {
			return renderResultWithOps(result, "Started. Common commands (copy into any terminal):", theme);
		},
	});
}
