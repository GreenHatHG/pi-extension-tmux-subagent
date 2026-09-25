/**
 * 主会话与子 agent 进程之间共享的环境变量名。两边（launch/ 经 tmux -e 注入，
 * session/ 在子 agent 进程内读取）必须引用同一份定义，改名只动这里。
 */
/** 子 agent pane 门禁标记：main 会话经 tmux -e 注入，session/gate.ts 读取 */
export const ENV_SUBAGENT = "PI_SUBAGENT";

/** 子 agent 自检失败时写非 0 exit 的目标文件（tmux -e 注入） */
export const ENV_SUB_EXIT_FILE = "PI_SUB_EXIT_FILE";

/** 子 agent 自检失败时发完成信号的 wait-for 频道名（tmux -e 注入） */
export const ENV_SUB_DONE = "PI_SUB_DONE";

/** watchdog 专用环境变量：主会话探测到 watchdog 扩展时注入子 agent（PI_SUBAGENT 门禁之外的收尾开关） */
export const ENV_WATCHDOG = "PI_WATCHDOG";

/** web-research 子 agent 引导标记：存在即表示本进程是 web-research 子 agent */
export const ENV_SUB_WEB = "PI_SUB_WEB";
