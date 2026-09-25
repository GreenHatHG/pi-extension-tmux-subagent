/**
 * 三种模式的简报模板集中于此：每份模板是子 agent 唯一的上下文来源。
 * 与各自的预设 flag（presets.ts）、模式实例（types.ts）配套。
 */
import { SOCKET } from "../core/tmux";

/** useWatchdog = 收尾走 stop_watchdog（false 时改为 pi -p，跑完自动退出，无需收尾动作）。
 * done = wait-for 完成频道名，收尾文案里告知 AI 信号来源。 */
export function buildTaskBrief(
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

/** advisor 模式的 brief 模板：只求判断，不求执行。useWatchdog = 收尾走 stop_watchdog（false 时 pi -p 跑完自动退出） */
export function buildAdvisorBrief(
	question: string,
	context: string | undefined,
	artifactPath: string,
	useWatchdog: boolean,
): string {
	const tools = useWatchdog ? "read/write/stop_watchdog" : "read/write";
	const finish = useWatchdog ? "，然后调用 stop_watchdog 结束" : "（批处理模式，写完即结束，无需其他收尾动作）";
	return `# 咨询简报

## 问题
${question}

## 背景摘要（主会话提供，是你唯一的上下文来源；主会话对 advisor 之后的执行过程零了解）
${context?.trim() || "（无）"}

## 你要做的事
- 给出判断：计划（具体下一步，按顺序）/ 纠偏（指出错误方向并重定向，说明理由）/ 停止信号（应停下上报用户）
- 结论优先，克制篇幅；点名文件/函数/行号；标注未核实的内容
- 只在需要核实背景中的说法时才 read 文件；不做任何实质修改（write 仅限交付物）

## 交付物
- 将完整建议写入 ${artifactPath}${finish}

## 边界
- 你的工具只有 ${tools}，这是设计使然：你负责判断，执行属于主会话`;
}

/** web-research 模式的简报模板：问题 + 背景 + 当前日期 + 工具策略 + 交付物 + 边界 */
export function buildWebResearchBrief(
	question: string,
	context: string | undefined,
	artifactPath: string,
	useWatchdog: boolean,
): string {
	const today = new Date().toISOString().slice(0, 10);
	const completion = useWatchdog
		? `
## 收尾
- 全部完成后（交付物已写完、无其他内容要输出时）把 stop_watchdog 作为最后一个动作调用
`
		: "";
	return `# 网络调研简报

## 问题
${question}

## 已知背景（主会话提供，本简报是你唯一的上下文来源）
${context?.trim() || "（无）"}

## 当前日期
${today}（判断时效性与 recencyFilter 取值时用）

## 工具策略
- 全部联网操作用你 tools list 里的联网工具（pi-web-access 提供）完成
- fetch 默认 readable（answer 模式已禁用），页面由你自己阅读；只抓会引用的页面
- 长内容别整页读入：单个事实用存取检索工具的 findText 定位，整段正文按 responseId 取回
- 若本会话没有任何联网工具，说明联网引导失败：把失败原因写入交付物并直接停止，不要尝试其他联网手段

## 交付物
- 结论写入 ${artifactPath}：结论优先，每条附来源 URL，标注未核实的内容
${completion}
## 边界
- bash 只用于搜索/检索相关的辅助工作（如处理工具输出的文本），不得作为联网手段
- tmux 命令永远带 -L ${SOCKET}（专用 socket）；禁止对默认 tmux server 执行任何 kill 操作`;
}
