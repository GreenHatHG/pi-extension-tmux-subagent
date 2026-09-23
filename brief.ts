/**
 * 任务简报（brief.md）模板：任务模式子 agent 的唯一上下文来源。
 * advisor 模式的另一份简报模板见 advisor.ts 的 buildAdvisorBrief。
 */
import { SOCKET } from "./tmux";

/** useWatchdog = 收尾走 stop_watchdog（false 时改为 pi -p，跑完自动退出，无需收尾动作）。
 * done = wait-for 完成频道名，收尾文案里告知 AI 信号来源。 */
export function buildBrief(
	question: string,
	context: string | undefined,
	artifactPath: string,
	useWatchdog: boolean,
): string {
	const completion = useWatchdog
		? `
## 收尾
- 全部完成后（交付物已写完、无其他内容要输出时）把 stop_watchdog 作为最后一个动作调用
`
		: "";
	return `# 任务简报

## 目标
${question}

## 已知背景（来自主会话，本简报是你唯一的上下文来源）
${context?.trim() || "（无）"}

## 交付物
- 交付物写入 ${artifactPath}：结论优先，克制篇幅，每条附来源 URL（如适用），标注未核实的内容
${completion}
## 边界
- 不要再委派新子 agent（spawn_sub）：你自己在执行 brief，委派只属于主会话
- tmux 命令永远带 -L ${SOCKET}（专用 socket）；禁止对默认 tmux server 执行任何 kill 操作`;
}
