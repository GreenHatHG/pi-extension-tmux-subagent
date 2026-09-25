/**
 * 主会话侧三个工具（spawn_sub / advisor / web_research）共用的小件：
 * 统一「启动结果 → 工具返回」的映射与「已启动 + ops 速查」的渲染。
 * 每个工具的 registerTool 定义仍在各自文件里（保持 pi 上下文类型推断），这里只提供函数体。
 */
import { Text } from "@earendil-works/pi-tui";

/** 工具的启动回调：launchSub 的签名子集（各工具按需包装模式与 extraArgs） */
export type LaunchFn = (
	question: string,
	context: string | undefined,
) => Promise<{
	ok: boolean;
	text: string;
	ops?: string;
	/** 简报原文（advisor 模式 appendEntry 纯显示用） */
	brief?: string;
	artifactPath?: string;
	exitFile?: string;
	session?: string;
	done?: string;
	logPath?: string;
}>;

/** 启动结果 → 工具返回值：text 进 LLM 上下文，ops 只进 details（TUI 渲染用，不进上下文） */
export function startedToolResult(text: string, ops?: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: { ops },
	};
}

/**
 * 统一的 renderResult 函数体：有 ops 速查 → 灰字提示用户复制到终端围观；
 * 无 ops → 直接渲染返回文本（失败路径）。result 参数类型由 pi 的
 * registerTool 上下文推断，这里放宽为结构最小集。
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
