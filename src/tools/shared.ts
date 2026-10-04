/**
 * Small helpers shared by the three main-session tools (spawn_sub / advisor / web_research):
 * mapping a launch result to a tool return value, and the "started + ops cheatsheet" render.
 * Each tool's registerTool definition still lives in its own file.
 */
import { Text } from "@earendil-works/pi-tui";

/** The tool's launch callback: a subset of launchSub's signature (each tool wraps the mode and extraArgs it needs). */
export type LaunchFn = (
	question: string,
	context: string | undefined,
	sessionFile?: string,
	parentSessionId?: string,
) => Promise<{
	ok: boolean;
	text: string;
	ops?: string;
	/** Brief text (main-session appendEntry, display only). */
	brief?: string;
	artifactPath?: string;
	exitFile?: string;
	session?: string;
	done?: string;
	logPath?: string;
}>;

/** Launch result -> tool return value: text goes into the LLM context, ops only into details (for TUI rendering, not into context). */
export function startedToolResult(text: string, ops?: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: { ops },
	};
}

/**
 * One renderResult for all: with ops -> a gray hint telling the user to copy the cheatsheet into a
 * terminal; without ops -> render the returned text directly (failure path).
 */
export function renderResultWithOps(
	result: { content: ReadonlyArray<{ type: string; text?: string }>; details?: unknown },
	startedPrefix: string,
	theme: { fg(key: string, text: string): string },
) {
	const ops = (result.details as { ops?: string } | undefined)?.ops;
	if (!ops) {
		const first = result.content[0];
		return new Text(first?.type === "text" ? (first.text ?? "") : "", 0, 0);
	}
	return new Text(theme.fg("muted", `${startedPrefix}\n${ops}`), 0, 0);
}
