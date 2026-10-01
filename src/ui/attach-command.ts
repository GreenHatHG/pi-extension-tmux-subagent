/**
 * /attach 命令：在主会话所在的用户 tmux 上开一个 display-popup 浮层，attach 到子 agent 会话围观。
 *
 * 主会话侧查看子 agent 执行过程的唯一入口：浮层里跑一个嵌套 tmux client，连接 pi-sub socket
 * 上子 agent 的 pane。与「新开窗口」方案不同，popup 的按键直接进内层 tmux（外层 key table 不参与），
 * 所以内层前缀生效：Ctrl-b d 只 detach 这个 attach，attach 退出后 popup 由 -E 自动关闭，
 * 回到原界面；子 agent 不受影响。
 *
 * 普通（可写）attach：滚轮 / Ctrl-b [ 可回看历史（copy-mode）。注意这也能杀会话——误按
 * Ctrl-b x / & / : 会真的杀掉子 agent，键盘输入也会打进 pane；要防误杀可改回 attach -r
 * （只读，但只读模式下 copy-mode 被禁，无法滚动）。
 *
 * 机制（实测 tmux 3.6a）：从 $TMUX 解析用户 server socket，在其上
 * `display-popup -E ... "TMUX= tmux -L pi-sub attach -t <会话>"`。display-popup -E 会阻塞到
 * popup 关闭，故此命令必须 fire-and-forget（spawn + unref），不能 await。依赖 tmux ≥ 3.2。
 */
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { captureSubagentPane, listSubagentSessions, run, SOCKET, shQuote } from "../core/tmux";

/**
 * 解析 /attach 所在 client 的 tty：popup 是 per-client 的，多终端时必须开在正确的终端上。
 * 优先按 $TMUX 的 session id 匹配（最确定；注意 $TMUX 第二段是 server pid，不是 client pid），
 * 拿不到再退回「最近活跃的 client」。
 */
async function resolveClientTty(socketPath: string): Promise<string | undefined> {
	const sid = process.env.TMUX?.split(",")[2]?.trim();
	const want = sid ? (sid.startsWith("$") ? sid : `$${sid}`) : undefined;
	const clients = await run("tmux", [
		"-S",
		socketPath,
		"list-clients",
		"-F",
		"#{client_tty}\t#{client_session}\t#{client_activity}",
	]);
	if (clients.code !== 0) return undefined;
	const rows = clients.stdout
		.split("\n")
		.filter(Boolean)
		.map((l) => l.split("\t"));
	if (want) {
		const sessions = await run("tmux", ["-S", socketPath, "list-sessions", "-F", "#{session_id}\t#{session_name}"]);
		const name = sessions.stdout
			.split("\n")
			.filter(Boolean)
			.map((l) => l.split("\t"))
			.find(([id]) => id === want)?.[1];
		const matching = rows.filter(([, s]) => s === name);
		if (matching.length > 0) {
			matching.sort((a, b) => Number(b[2]) - Number(a[2]));
			return matching[0][0];
		}
	}
	rows.sort((a, b) => Number(b[2]) - Number(a[2]));
	return rows[0]?.[0];
}

/** 打开一个附着在子 agent 会话上的浮层。返回错误文案；undefined = 成功。 */
async function openAttach(session: string): Promise<string | undefined> {
	const socketPath = process.env.TMUX?.split(",")[0];
	if (!socketPath) return "未在 tmux 内（$TMUX 为空），无法开浮层。";

	const tty = await resolveClientTty(socketPath);
	// 保留 TMUX=：popup 命令由外层 server 执行，若 server 环境里带 TMUX，attach 会报嵌套告警
	const popupCmd = `TMUX= tmux -L ${SOCKET} attach -t ${shQuote(session)}`;
	const args = ["-S", socketPath, "display-popup"];
	if (tty) args.push("-c", tty);
	args.push("-E", "-w", "90%", "-h", "90%", "-T", `子 agent ${session}（围观）`, popupCmd);

	// display-popup -E 会阻塞调用进程直到浮层关闭：必须 fire-and-forget，不能 await run()。
	// 短暂等 spawn/早退：spawn 失败、或 display-popup 立即报错（如 tmux < 3.2）时给出明确错误。
	const child = spawn("tmux", args, { env: { ...process.env, TMUX: "" }, stdio: "ignore", detached: true });
	const error = await new Promise<string | undefined>((resolve) => {
		const timer = setTimeout(() => resolve(undefined), 700);
		child.once("error", () => {
			clearTimeout(timer);
			resolve("无法启动 tmux 浮层（spawn tmux 失败）。");
		});
		child.once("exit", (code) => {
			if (code !== 0) {
				clearTimeout(timer);
				resolve(`tmux display-popup 失败（exit ${code}）——需要 tmux ≥ 3.2。`);
			}
		});
	});
	child.on("error", () => {
		/* 已 spawn 后再报错（罕见）静默吞掉，别打挂 TUI */
	});
	child.unref();
	return error;
}

function popupMsg(name: string): string {
	return `已在浮层中 attach 到 ${name}（Ctrl-b d 或 Ctrl-c 退出，不影响子 agent）。滚轮 / Ctrl-b [ 可回看历史；注意这是普通 attach：Ctrl-b x / & / : 会真的杀会话，键盘也会打进 pane。`;
}

async function listLine(session: string): Promise<string> {
	const cap = await captureSubagentPane(session);
	const last = cap.code === 0 ? (cap.stdout.trim().split("\n").filter(Boolean).pop() ?? "") : "";
	return `${session}${last ? `  │ ${last}` : "（暂无内容）"}`;
}

/** 无参数时：用可滚动选择器列出运行中的子 agent，选中即开浮层 attach。避免 console.log 弄脏 TUI 渲染 */
async function pickSession(ctx: ExtensionCommandContext): Promise<void> {
	const sessions = await listSubagentSessions();
	if (sessions.length === 0) {
		ctx.ui.notify("当前没有运行中的子 agent", "info");
		return;
	}
	const items = await Promise.all(sessions.map((s) => listLine(s)));
	const chosen = await ctx.ui.select("运行中的子 agent（选择即围观）", items);
	if (!chosen) return;
	const name = chosen.split(/\s/)[0];
	const err = await openAttach(name);
	if (err) ctx.ui.notify(err, "error");
	else ctx.ui.notify(popupMsg(name), "info");
}

export function setupAttachCommand(pi: ExtensionAPI): void {
	pi.registerCommand("attach", {
		description: "在浮层里围观某个子 agent（真实画面，Ctrl-b d / Ctrl-c 退出）；无参数弹出运行中的列表选择",
		getArgumentCompletions: async () => {
			const sessions = await listSubagentSessions();
			return sessions.map((value) => ({ value, label: value, description: "围观该子 agent" }));
		},
		handler: async (args, ctx) => {
			// 降级：非 TUI 或不在用户 tmux 内 → 只提示手动命令。注意不能用 ctx.hasUI
			// 判断：rpc 模式 hasUI 也可能为 true，但那时没有用户终端可开浮层。
			const socketPath = process.env.TMUX?.split(",")[0];
			if (ctx.mode !== "tui" || !socketPath) {
				const name = args.trim();
				const cmd = name ? `tmux -L ${SOCKET} attach -t ${name}` : `tmux -L ${SOCKET} attach -t <会话名>`;
				ctx.ui.notify(`当前模式无法开浮层，请手动执行：${cmd}`, "info");
				return;
			}

			const name = args.trim();
			if (!name) {
				await pickSession(ctx);
				return;
			}

			const sessions = await listSubagentSessions();
			if (!sessions.includes(name)) {
				ctx.ui.notify(`会话 ${name} 不存在或已结束。运行中：${sessions.join(", ") || "(无)"}`, "warning");
				return;
			}

			const err = await openAttach(name);
			if (err) {
				ctx.ui.notify(err, "error");
				return;
			}
			ctx.ui.notify(popupMsg(name), "info");
		},
	});
}
