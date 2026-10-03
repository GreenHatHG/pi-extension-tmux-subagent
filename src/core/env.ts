/**
 * 主会话与子 agent 进程之间共享的环境变量名。写入侧（launch/ 经 tmux -e 注入）与
 * 读取侧（core/env.ts 的 resolveProcessRole）必须引用同一份定义，改名只动这里。
 *
 * 本文件同时是**全项目唯一读取这些进程内环境变量的地方**（resolveProcessRole）：
 * 各模块不再各自 process.env[...]，而是接收解析好的 ProcessRole。
 */
/** 子 agent pane 门禁标记：main 会话经 tmux -e 注入，resolveProcessRole 读取 */
export const ENV_SUBAGENT = "PI_SUBAGENT";

/** 子 agent 自检失败时写非 0 exit 的目标文件（tmux -e 注入） */
export const ENV_SUB_EXIT_FILE = "PI_SUB_EXIT_FILE";

/** 子 agent 自检失败时发完成信号的 wait-for 频道名（tmux -e 注入） */
export const ENV_SUB_DONE = "PI_SUB_DONE";

/** watchdog 专用环境变量：主会话探测到 watchdog 扩展时注入子 agent（PI_SUBAGENT 门禁之外的收尾开关） */
export const ENV_WATCHDOG = "PI_WATCHDOG";

/** web-research 子 agent 引导标记：存在即表示本进程是 web-research 子 agent */
export const ENV_SUB_WEB = "PI_SUB_WEB";

/**
 * 进程角色：factory 阶段解析一次，全项目唯一读取这些进程内环境变量的地方。
 * 环境变量由 tmux -e 在进程启动时注入、进程生命周期内不变，故「解析一次」与
 * 「每处现读」等价。
 */
export interface ProcessRole {
	/** "sub" = 子 agent pane（PI_SUBAGENT=1）；"main" = 主会话 */
	kind: "main" | "sub";
	/** web-research 子 agent 引导开关（PI_SUB_WEB）。独立于 kind：触发条件与原实现逐条相等 */
	web: boolean;
	/** 交互式收尾路径（PI_WATCHDOG 注入）；false = pi -p 批处理回退路径 */
	watchdog: boolean;
	/** 自检失败时写非 0 exit 的目标文件（PI_SUB_EXIT_FILE） */
	exitFile?: string;
	/** 自检失败时发完成信号的 wait-for 频道（PI_SUB_DONE） */
	done?: string;
}

/** 解析当前进程角色。纯函数：index.ts 在 factory 顶部调用一次，向下传值。 */
export function resolveProcessRole(): ProcessRole {
	const env = process.env;
	return {
		kind: env[ENV_SUBAGENT] === "1" ? "sub" : "main",
		web: !!env[ENV_SUB_WEB]?.trim(),
		watchdog: !!env[ENV_WATCHDOG],
		exitFile: env[ENV_SUB_EXIT_FILE],
		done: env[ENV_SUB_DONE],
	};
}
