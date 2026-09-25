/**
 * 三种模式的简报模板集中于此：每份模板是子 agent 唯一的上下文来源。
 * 与各自的预设 flag（presets.ts）、模式实例（types.ts）配套。
 */
import { SOCKET } from "../core/tmux";
import type { VccSummary } from "./vcc";

/** brief 的可选取材：advisor 取证栏目用（task / web-research 忽略）。
 * sessionFile = 主会话（执行方）的 jsonl 绝对路径；vccCli = pi-vcc 独立 CLI 调用命令；
 * vccSummary = advisor 启动时预生成的 vcc 压缩摘要（runVccCompact 的结果）。 */
export interface BriefOpts {
	sessionFile?: string;
	vccCli?: string;
	vccSummary?: VccSummary;
}

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

/** advisor 模式的 brief 模板：只求判断，不求执行。useWatchdog = 收尾走 stop_watchdog（false 时 pi -p 跑完自动退出）。
 * 取证栏目两级（BriefOpts）：① 有预生成摘要 → read vcc-summary（全局视野）；② 按需用 recall CLI 检索/展开补细节。 */
export function buildAdvisorBrief(
	question: string,
	context: string | undefined,
	artifactPath: string,
	useWatchdog: boolean,
	opts?: BriefOpts,
): string {
	const sessionFile = opts?.sessionFile;
	const vccCli = opts?.vccCli;
	const tools = useWatchdog ? "read/write/stop_watchdog/bash" : "read/write/bash";
	const finish = useWatchdog ? "，然后调用 stop_watchdog 结束" : "（批处理模式，写完即结束，无需其他收尾动作）";
	const recall =
		sessionFile && vccCli
			? vccSummaryOk(opts?.vccSummary)
				? `## 原始会话取证（vcc 压缩摘要 + recall CLI，只读；补充视野，不是必读）
- 第一步——补全视野：read ${opts?.vccSummary?.path}。这是 advisor 启动时预生成的整段会话 vcc 压缩摘要（已发生的步骤、命令与结论全貌）；背景摘要只覆盖主会话认为与问题相关的部分——背景摘要已够判断时不必读它，存疑才读
- 第二步——按需补细节：摘要可能仍截断命令输出/报错原文。怀疑遗漏时用 bash 跑 recall CLI 检索主会话的完整记录：
  - 检索：\`${vccCli} recall ${sessionFile} <关键词>\`（多词按相关性排序，命中只带局部 snippet）
  - 看全文：\`${vccCli} recall ${sessionFile} --expand N1,N2\`（N 为命中条目的 #N，toolResult/bash 输出原文不截断）
  - 文件当时的内容：query 传 \`#N:path\`（\`#N:path:full\` 看全部），读的是会话里工具调用参数记录的版本，文件后来被改也能看到
  - 翻页：\`--page N\`；换分支：\`--scope all\`；列改动文件：\`--mode touched\`
  - 更多用法（翻页窗口、歧义 #N、退出码约定）：\`${vccCli} --help\`（仅在上述模板不够用时跑，不要为翻手册而探索）
- 会话文件：${sessionFile}
- 摘要/取证与背景摘要（主会话手写）冲突时：以摘要与取证为准，并把冲突本身点进结论——这往往正是问题所在

`
				: `## 原始会话取证（recall CLI，只读）
- 本简报是压缩摘要：命令输出、报错原文、时序细节可能未纳入。怀疑遗漏时用 bash 跑 recall CLI 恢复：
  - 检索：\`${vccCli} recall ${sessionFile} <关键词>\`（多词按相关性排序，命中只带局部 snippet）
  - 看全文：\`${vccCli} recall ${sessionFile} --expand N1,N2\`（N 为命中条目的 #N，toolResult/bash 输出原文不截断）
  - 文件当时的内容：query 传 \`#N:path\`（\`#N:path:full\` 看全部），读的是会话里工具调用参数记录的版本，文件后来被改也能看到
  - 翻页：\`--page N\`；换分支：\`--scope all\`；列改动文件：\`--mode touched\`
  - 更多用法（翻页窗口、歧义 #N、退出码约定）：\`${vccCli} --help\`（仅在上述模板不够用时跑，不要为翻手册而探索）
  - 也可以自行跑 \`${vccCli} compact ${sessionFile}\` 先看整段会话的压缩摘要（只读 stdout，不加 --write）
- 会话文件：${sessionFile}

`
			: sessionFile
				? `## 原始会话取证
- 会话文件：${sessionFile}（未配置 advisor.vccCli，本次无法用 recall CLI 取证；需要原始上下文时在结论中说明缺口，由主会话补充）

`
				: `## 原始会话取证
- 主会话尚未落盘，本次无法取证；如需原始上下文请在结论中说明缺口，由主会话补充。

`;
	return `# 咨询简报

## 问题
${question}

## 背景摘要（主会话提供；主会话对 advisor 之后的执行过程零了解）
${context?.trim() || "（无）"}

## 你要做的事
- 给出判断：计划（具体下一步，按顺序）/ 纠偏（指出错误方向并重定向，说明理由）/ 停止信号（应停下上报用户）
- 结论优先，克制篇幅；点名文件/函数/行号；标注未核实的内容
- 上下文分两级取用：背景摘要覆盖主会话认为与问题相关的部分，通常已够判断；取证栏目（原始会话取证）是补充视野——摘要已预生成就读它，还缺细节才 recall。不问自取会拖慢咨询：question 本身已够判断时不要翻取证
- 只在需要核实说法/补全细节时才 read 文件；不做任何实质修改（write 仅限交付物）

${recall}
## 交付物
- 将完整建议写入 ${artifactPath}${finish}

## 边界
- 你的工具只有 ${tools}，这是设计使然：你负责判断，执行属于主会话`;
}

/** vccSummary 存在且成功（brief 模板里不导 runVccCompact 的语义，只认结果形状） */
function vccSummaryOk(s?: VccSummary): boolean {
	return !!s && s.ok;
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
