/**
 * 子 agent pane 内的自检。这段代码运行在子 agent 的 pi 进程里（主会话经 tmux -e 注入
 * PI_SUBAGENT=1），与主会话侧的其余接线（index.ts、launch/、tools/）分属两个执行
 * 上下文——session/ 目录专门表达这个边界。
 *
 * 门禁（子 agent 内不注册任何工具）已上移到 index.ts 的 role.kind 分支；本模块只做
 * 自检，进程角色由调用方传入（见 core/env.ts 的 ProcessRole）。
 */
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isWatchdogAvailable } from "../completion/profile";
import type { ProcessRole } from "../core/env";
import { SOCKET, shQuote } from "../core/tmux";
import { onEvent } from "../registry";

/**
 * 子 agent 自检（仅交互式路径，role.watchdog = 注入了 PI_WATCHDOG 时注册）：放到
 * session_start——此时各扩展已加载完，/watchdog 的注册时序不再有假阴性。注入了
 * PI_WATCHDOG 却找不到 watchdog 扩展 = 交互式收尾机制缺位：任务做完 pi 不会退出、
 * 不发完成信号，tmux 会话将永久残留。此时尽快失败暴露：写非 0 exit 并直接发完成
 * 信号，让等待方立刻读到明确失败（宁可误判失败，不要静默挂死）。pi -p 回退路径
 * 不注入 PI_WATCHDOG（role.watchdog 为 false），天然不触发本分支。
 */
export function setupSubagentSelfCheck(pi: ExtensionAPI, role: ProcessRole): void {
	if (!role.watchdog) return;

	onEvent(
		pi,
		"session_start",
		{
			where: "session/gate.ts:watchdog 自检",
			note: "子 agent pane 内注入了 PI_WATCHDOG 却找不到 watchdog 扩展时：写 exit=97 并发完成信号，快速失败而非静默挂死",
		},
		async (_event: unknown, ctx: { ui: { notify(text: string, level: string): void } }) => {
			if (isWatchdogAvailable(pi)) return;
			ctx.ui.notify(
				"子 agent 异常：注入了 PI_WATCHDOG 但 watchdog 扩展未加载，无法自动收尾。已标记本次委派失败（exit=97）并通知等待方，建议主会话改用 -p 回退路径重试",
				"warning",
			);
			// 97 = 子 agent 自检失败（watchdog 缺位）。等待方读 result.md 缺失 + exit 非 0 → 快速失败。
			if (role.exitFile) {
				try {
					writeFileSync(role.exitFile, "97\n");
				} catch {
					/* ignore */
				}
			}
			if (role.done) {
				// detached：session_start 阻塞无意义，发完即走；wait-for -S 立即返回，
				// 信号被 server 记住，晚到的等待方也能拿到
				pi.exec("sh", ["-c", `TMUX= tmux -L ${SOCKET} wait-for -S ${shQuote(role.done)}`]).catch(() => {});
			}
		},
	);
}
