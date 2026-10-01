/**
 * 子 agent 进度面板（主会话 TUI，只读镜像）。
 *
 * 设计要点：直接复用 tmux 自带机制，不引入任何子 agent 侧埋点 / 环境变量 / 新文件协议。
 * `tmux -L pi-sub list-sessions` 是存活会话的真相源；`capture-pane -p` 抓回的就是
 * 人工 `tmux -L pi-sub attach` 连上去看到的同一屏（纯文本、无 ANSI）。面板只是把它
 * 渲染成编辑器上方的一个常驻 widget，默认折叠；`/subagents` 切换展开。
 *
 * 本文件运行在主会话 pi 进程内（index.ts 在 `setupSelfCheck` 提前 return 之后调用）。
 * 轮询/渲染全部 `try/catch`，作为纯显示增强，任何异常都不得影响主会话。
 */
import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { resolvePaths } from "../core/paths";
import { captureSubagentPane, listSubagentSessions } from "../core/tmux";
import { onEvent } from "../registry";

const WIDGET_KEY = "subagents";
/** 轮询间隔：无存活会话时只剩一次 list-sessions，开销可忽略 */
const POLL_MS = 1000;
/** 会话从有到无后，终态行（✓/✗）保留时长，让用户看到结果再消失 */
const LINGER_MS = 5000;
/** 折叠态最多展示的会话行数，超出折叠成「还有 N 个」 */
const COLLAPSED_MAX = 8;
/** 展开态每个会话展示的内容行数 / 面板总行数上限 */
const EXPANDED_PER_AGENT = 8;
const EXPANDED_MAX = 40;

interface AgentView {
	session: string;
	/** 去掉 pi TUI chrome（边框/页脚/指标）后的内容行，末行最新 */
	content: string[];
	/** content 的最后一行 = 当前活动摘要（折叠态的一行） */
	activity: string;
	/** 会话结束后读 exit 得到的终态；缺失 = 异常终止 */
	terminal?: { ok: boolean; note: string; at: number };
}

let ctxRef: ExtensionContext | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let liveTui: TUI | undefined;
let installed = false;
let busy = false;
let expanded = false;
let lastSig = "";
let lastStatus = "";
const views = new Map<string, AgentView>();

/**
 * 判断一行是否 pi TUI 的固定 chrome。pi 的页脚结构（自下而上）大约是：
 * 状态行（🛡/⏱）→ token 统计 + 模型行（含 ↑↓）→ cwd 行 → 编辑器（两条横线夹一个空行）。
 * 每轮助手消息后还会多一条 `[metrics]`。这些都不是「当前活动」，过滤掉。
 */
function isChrome(line: string): boolean {
	const t = line.trim();
	if (!t) return true;
	if (/^[─━═╌┄┈╭╮╰╯│┃┌┐└┘├┤┬┴┼]+$/.test(t)) return true; // 纯边框 / 编辑器横线
	if (t.startsWith("[metrics]")) return true; // 每轮性能指标
	if (t.includes("↑") && t.includes("↓")) return true; // token 统计 + 模型行
	if (/^↳\s*~?[\d.]+\s*tokens/.test(t)) return true; // 单条 usage 回显
	if (/[🛡⏱]/u.test(t) && t.length < 80) return true; // 页脚状态行
	if (/^(\/|~)\S*\s*\(\S+\)$/.test(t)) return true; // 页脚 cwd (branch)
	return false;
}

function toContent(raw: string): string[] {
	return raw
		.split("\n")
		.map((l) => l.replace(/\s+$/, ""))
		.filter((l) => !isChrome(l));
}

/** 会话消失后读 exit 判读成败（沿用 completion 的约定：0=正常，非 0=失败，缺失=异常终止） */
function terminalStatus(session: string): { ok: boolean; note: string; at: number } {
	try {
		const raw = readFileSync(resolvePaths(session).exitFile, "utf8").trim();
		if (raw === "0") return { ok: true, note: "完成", at: Date.now() };
		return { ok: false, note: raw ? `exit ${raw}` : "失败", at: Date.now() };
	} catch {
		return { ok: false, note: "异常终止", at: Date.now() };
	}
}

async function tick(): Promise<void> {
	if (busy) return;
	busy = true;
	try {
		const live = await listSubagentSessions();
		const liveSet = new Set(live);

		for (const session of live) {
			const cap = await captureSubagentPane(session);
			// list 与 capture 之间会话可能结束：跳过，下一 tick 走终态分支
			if (cap.code !== 0) continue;
			const content = toContent(cap.stdout);
			views.set(session, { session, content, activity: content[content.length - 1] ?? "" });
		}

		for (const [session, v] of views) {
			if (!liveSet.has(session) && !v.terminal) v.terminal = terminalStatus(session);
		}

		const now = Date.now();
		for (const [session, v] of views) {
			if (v.terminal && now - v.terminal.at > LINGER_MS) views.delete(session);
		}

		refresh();
	} catch {
		/* 纯显示增强：任何异常都不得逃逸到主会话 */
	} finally {
		busy = false;
	}
}

function refresh(): void {
	const ctx = ctxRef;
	if (!ctx) return;

	const list = [...views.values()];
	if (list.length === 0) {
		if (installed) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			ctx.ui.setStatus(WIDGET_KEY, undefined);
			installed = false;
			liveTui = undefined;
		}
		lastSig = "";
		lastStatus = "";
		return;
	}

	if (!installed) {
		// 只安装一次：setWidget 对同 key 会先 dispose 旧组件再重建，
		// 之后只更新模块级快照 + tui.requestRender()，不再调 setWidget。
		ctx.ui.setWidget(WIDGET_KEY, (tui) => {
			liveTui = tui;
			return {
				render: (width: number) => renderLines(width),
				invalidate: () => {},
				dispose: () => {
					liveTui = undefined;
				},
			};
		});
		installed = true;
	}

	const running = list.filter((v) => !v.terminal).length;
	const done = list.filter((v) => v.terminal?.ok).length;
	const failed = list.filter((v) => v.terminal && !v.terminal.ok).length;
	const status = [running ? `▶${running}` : "", done ? `✓${done}` : "", failed ? `✗${failed}` : ""]
		.filter(Boolean)
		.join(" ");
	if (status !== lastStatus) {
		lastStatus = status;
		ctx.ui.setStatus(WIDGET_KEY, ctx.ui.theme.fg("accent", status));
	}

	const sig = list.map((v) => `${v.session}:${v.terminal ? v.terminal.note : v.activity}`).join("\n");
	if (sig !== lastSig) {
		lastSig = sig;
		liveTui?.requestRender();
	}
}

function renderLines(width: number): string[] {
	const theme = ctxRef?.ui.theme;
	if (!theme) return [];

	const list = [...views.values()];
	const running = list.filter((v) => !v.terminal).length;
	const done = list.filter((v) => v.terminal?.ok).length;
	const failed = list.filter((v) => v.terminal && !v.terminal.ok).length;
	const counts = [`${running} 运行`, done ? `${done} 完成` : "", failed ? `${failed} 失败` : ""]
		.filter(Boolean)
		.join(" · ");

	const out: string[] = [];
	out.push(
		theme.fg(
			"accent",
			truncateToWidth(expanded ? `▾ 子 agent · ${counts}` : `▸ 子 agent · ${counts}    /subagents 展开`, width),
		),
	);

	if (!expanded) {
		for (const v of list.slice(0, COLLAPSED_MAX)) {
			const icon = v.terminal
				? theme.fg(v.terminal.ok ? "success" : "error", v.terminal.ok ? "✓" : "✗")
				: theme.fg("accent", "⏳");
			const tail = v.terminal ? v.terminal.note : v.activity || "启动中…";
			out.push(
				truncateToWidth(
					`  ${icon} ${theme.fg("text", v.session)} ${theme.fg("dim", "│")} ${theme.fg("muted", tail)}`,
					width,
				),
			);
		}
		if (list.length > COLLAPSED_MAX) {
			out.push(theme.fg("muted", `  … 还有 ${list.length - COLLAPSED_MAX} 个`));
		}
		return out;
	}

	for (const v of list) {
		if (out.length >= EXPANDED_MAX) break;
		const icon = v.terminal
			? theme.fg(v.terminal.ok ? "success" : "error", v.terminal.ok ? "✓" : "✗")
			: theme.fg("accent", "⏳");
		const suffix = v.terminal ? theme.fg("dim", ` · ${v.terminal.note}`) : "";
		out.push(truncateToWidth(`  ${icon} ${theme.fg("text", v.session)}${suffix}`, width));
		const tail = v.content.slice(-EXPANDED_PER_AGENT);
		const lines = tail.length > 0 ? tail : ["（暂无内容）"];
		for (const l of lines) {
			if (out.length >= EXPANDED_MAX) break;
			out.push(truncateToWidth(`    ${theme.fg("muted", l)}`, width));
		}
	}
	if (out.length >= EXPANDED_MAX) {
		out.push(theme.fg("muted", "  … 完整画面请用 tmux -L pi-sub attach -t <会话名>"));
	}
	return out;
}

/** 主会话侧安装面板：session_start 起轮询，session_shutdown 收尾 */
export function setupSubagentPad(pi: ExtensionAPI): void {
	onEvent(
		pi,
		"session_start",
		{
			where: "ui/subagent-pad.ts:面板启动",
			note: "主会话 TUI（ctx.hasUI）里起 1s 轮询：tmux list-sessions + capture-pane 镜像所有子 agent 画面",
		},
		(_event: unknown, ctx: ExtensionContext) => {
			if (!ctx.hasUI) return;
			ctxRef = ctx;
			views.clear();
			lastSig = "";
			lastStatus = "";
			if (!timer) timer = setInterval(() => void tick(), POLL_MS);
			void tick();
		},
	);

	onEvent(
		pi,
		"session_shutdown",
		{
			where: "ui/subagent-pad.ts:面板收尾",
			note: "会话结束：停止轮询并卸载 widget / 页脚状态，避免残留",
		},
		(_event: unknown) => {
			if (timer) {
				clearInterval(timer);
				timer = undefined;
			}
			if (ctxRef && installed) {
				ctxRef.ui.setWidget(WIDGET_KEY, undefined);
				ctxRef.ui.setStatus(WIDGET_KEY, undefined);
			}
			installed = false;
			liveTui = undefined;
			views.clear();
			ctxRef = undefined;
		},
	);

	pi.registerCommand("subagents", {
		description: "切换子 agent 进度面板的折叠/展开",
		handler: async () => {
			expanded = !expanded;
			liveTui?.requestRender();
		},
	});
}
