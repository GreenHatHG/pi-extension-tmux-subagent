/**
 * 子 agent pane 内的门禁与自检。这段代码运行在子 agent 的 pi 进程里（主会话经
 * tmux -e 注入 PI_SUBAGENT=1），与 index.ts 的其余接线（主会话进程）分属两个
 * 执行上下文，单独成文件把这个边界表达出来。
 */
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isWatchdogAvailable } from "./completion";
import { SOCKET, shQuote } from "./tmux";

/**
 * 子 agent 门禁 + 自检。返回 true = 当前是子 agent pane，调用方应立即 return
 * （不注册任何工具）。
 *
 * 门禁（无条件，先于自检判断）：子 agent pane 内不再注册 spawn_sub，从机制上禁止
 * 嵌套委派，替代原先的 promptGuidelines 软约束。pi -p 回退路径不注入 PI_WATCHDOG
 * 但同样注入 PI_SUBAGENT=1，所以门禁不能折叠进自检条件。
 *
 * 自检（仅交互式路径，注入了 PI_WATCHDOG 时注册）：放到 session_start——此时各扩展
 * 已加载完，/watchdog 的注册时序不再有假阴性。注入了 PI_WATCHDOG 却找不到 watchdog
 * 扩展 = 交互式收尾机制缺位：任务做完 pi 不会退出、不发完成信号，tmux 会话将永久
 * 残留。此时尽快失败暴露：写非 0 exit 并直接发完成信号，让等待方立刻读到明确失败
 * （宁可误判失败，不要静默挂死）。pi -p 回退路径不注入 PI_WATCHDOG，天然不触发
 * 本分支。
 */
export function setupSelfCheck(pi: ExtensionAPI): boolean {
	if (process.env.PI_SUBAGENT !== "1") return false;

	if (process.env.PI_WATCHDOG) {
		pi.on("session_start", async (_event, ctx) => {
			if (isWatchdogAvailable(pi)) return;
			ctx.ui.notify(
				"子 agent 异常：注入了 PI_WATCHDOG 但 watchdog 扩展未加载，无法自动收尾。已标记本次委派失败（exit=97）并通知等待方，建议主会话改用 -p 回退路径重试",
				"warning",
			);
			// 97 = 子 agent 自检失败（watchdog 缺位）。等待方读 result.md 缺失 + exit 非 0 → 快速失败。
			if (process.env.PI_SUB_EXIT_FILE) {
				try {
					writeFileSync(process.env.PI_SUB_EXIT_FILE, "97\n");
				} catch {
					/* ignore */
				}
			}
			if (process.env.PI_SUB_DONE) {
				// detached：session_start 阻塞无意义，发完即走；wait-for -S 立即返回，
				// 信号被 server 记住，晚到的等待方也能拿到
				pi.exec("sh", ["-c", `TMUX= tmux -L ${SOCKET} wait-for -S ${shQuote(process.env.PI_SUB_DONE)}`]).catch(
					() => {},
				);
			}
		});
	}

	return true;
}
