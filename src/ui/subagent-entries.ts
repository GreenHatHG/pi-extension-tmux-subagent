/**
 * 子 agent 简报/回复的 TUI 纯显示层（主会话）：三个工具（spawn_sub / advisor /
 * web_research）共用。简报在工具启动成功后立刻 appendEntry；回复由事件驱动的
 * watcher 等子 agent 完成后 appendEntry。两者都只进 TUI，不进 LLM 上下文，
 * 不改变主会话模型「wait-for + read result.md」的等待/读取协议。
 *
 * 依赖方向：ui → core（tmux 原语），另只从 modes/types 取类型（SubagentDisplay）。
 * 不 import launch/ 或 tools/，运行结果的字段用本地结构最小集描述（与 tools/shared.ts
 * 同样的做法）。
 */
import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, MouseRegion, Text } from "@earendil-works/pi-tui";
import { runTmux } from "../core/tmux";
import type { SubagentDisplay } from "../modes/types";

/** 新写入的 entry 类型名（三个模式共用，语义与 advisor 无关）。 */
export const SUBAGENT_BRIEF_ENTRY = "pi-subagent-brief";
export const SUBAGENT_REPLY_ENTRY = "pi-subagent-reply";

/**
 * 旧类型名：advisor-only 时期写入的历史 jsonl 用的是这两个。只注册渲染器让旧会话
 * 恢复后仍能显示，不再写入新数据（新数据一律用上面的通用名）。
 * 未注册的 customType 在 pi 里渲染为空——不保留这些别名旧 entry 会彻底隐形。
 */
const LEGACY_ENTRY_TYPES = ["pi-advisor-brief", "pi-advisor-reply"];

/** LaunchResult 的显示相关字段（结构最小集，避免 ui → launch 的反向依赖）。 */
export interface SubagentLaunchInfo {
	/** 子 agent 简报原文（appendEntry 纯显示用） */
	brief?: string;
	session?: string;
	artifactPath?: string;
	exitFile?: string;
	done?: string;
	logPath?: string;
}

interface SubagentEntryData {
	label: string;
	body: string;
	note?: string;
}

type EntryTheme = Parameters<Parameters<ExtensionAPI["registerEntryRenderer"]>[1]>[2];

/** 折叠/展开两种形态的内容构建（点击与 ctrl+o 共用同一套字符串）。 */
function buildSubagentEntryContent(
	d: Partial<SubagentEntryData>,
	fallback: string,
	expanded: boolean,
	theme: EntryTheme,
): Component {
	const body = d.body ?? "";
	if (!expanded) {
		const lines = body ? body.split("\n") : [];
		const note = d.note ? ` · ${d.note}` : "";
		return new Text(
			theme.fg("muted", `▸ ${d.label ?? fallback}（${lines.length} 行${note}，点击或 ctrl+o 展开）`),
			1,
			0,
		);
	}
	const c = new Container();
	c.addChild(new Text(theme.fg("toolTitle", theme.bold(`▾ ${d.label ?? fallback}（点击收起）`)), 1, 0));
	if (d.note) c.addChild(new Text(theme.fg("muted", d.note), 1, 0));
	c.addChild(new Markdown(body || "（空）", 1, 0, getMarkdownTheme()));
	return c;
}

/**
 * 简报/回复的 entry 渲染器：默认折叠为一行摘要，ctrl+o（app.tools.expand）全局
 * 展开为完整 Markdown；fullscreen 模式下左键单击也能就地展开/收起。
 *
 * 点击态是 per-entry 本地状态：全局 ctrl+o 会重建 entry 组件并重置它（与 pi 原生
 * ToolExecution / thinking block 语义一致），不是缺陷。数据经 pi.appendEntry 写入
 * （不参与 LLM 上下文），会话恢复后也能重渲染。
 */
function renderSubagentEntry(
	entry: { data?: unknown; customType?: string },
	options: { expanded: boolean },
	theme: EntryTheme,
) {
	const d = (entry.data ?? {}) as Partial<SubagentEntryData>;
	// 旧 advisor entry 的 fallback 文案保持 "advisor"（仅 label 缺失的吐形 entry 可见）
	const fallback = entry.customType && LEGACY_ENTRY_TYPES.includes(entry.customType) ? "advisor" : "subagent";
	let expanded = options.expanded;
	let cache: { width: number; expanded: boolean; lines: string[] } | undefined;
	// MouseRegion.child 只读，故用「读闭包最新 expanded」的 content 组件：点击只翻转状态 +
	// 清缓存，下一次 render 即产出新内容（点击返回 handled 会触发重绘）。
	const content: Component = {
		render(width) {
			if (!cache || cache.width !== width || cache.expanded !== expanded) {
				cache = { width, expanded, lines: buildSubagentEntryContent(d, fallback, expanded, theme).render(width) };
			}
			return cache.lines;
		},
		invalidate() {
			cache = undefined;
		},
	};
	return new MouseRegion(content, (event) => {
		if (event.type !== "click" || event.button !== "left") return undefined;
		// 同一词上的双击/三击交给 pi 的词/行选择，不切换展开态（重绘以清掉选择高亮）。
		if (event.clickCount !== undefined && event.clickCount > 1) return { handled: true };
		expanded = !expanded;
		cache = undefined;
		return { handled: true };
	});
}

/**
 * 注册简报/回复的 entry 渲染器。与工具注册无耦合，在主会话分支调一次即可
 * （子 agent pane 不注册：那里永远不会 appendEntry）。
 */
export function registerSubagentEntryRenderers(pi: ExtensionAPI): void {
	pi.registerEntryRenderer(SUBAGENT_BRIEF_ENTRY, renderSubagentEntry);
	pi.registerEntryRenderer(SUBAGENT_REPLY_ENTRY, renderSubagentEntry);
	for (const legacy of LEGACY_ENTRY_TYPES) pi.registerEntryRenderer(legacy, renderSubagentEntry);
}

/** 简报打进 TUI（appendEntry，不进 LLM 上下文）。启动失败/回退路径无 brief 时跳过。 */
export function showSubagentBrief(pi: ExtensionAPI, r: SubagentLaunchInfo, display: SubagentDisplay): void {
	if (r.brief) pi.appendEntry(SUBAGENT_BRIEF_ENTRY, { label: display.briefLabel, body: r.brief });
}

/** 启动 TUI watcher 等子 agent 完成并打进回复。字段不全（如 hook 注册失败的回退结果）时跳过。 */
export function watchSubagentReply(pi: ExtensionAPI, r: SubagentLaunchInfo, display: SubagentDisplay): void {
	if (r.session && r.artifactPath && r.exitFile && r.done) {
		void watchSubagentResult(pi, {
			session: r.session,
			artifactPath: r.artifactPath,
			exitFile: r.exitFile,
			done: r.done,
			logPath: r.logPath ?? "",
			label: display.replyLabel,
		}).catch(() => {}); // readFileSync TOCTOU 等异常：watcher 是纯显示增强，静默失败
	}
}

/** 失败时把 stderr log 尾部暴露给用户（空回复 entry 不能再是空：根因就在这里）。
 * watchdog 路径 pi 的 stderr 重定向到 log（见 completion/profile.ts）；批处理路径
 * log 是 stdout+stderr。读不到（旧格式/未生成）给明确提示。 */
function failureLog(logPath: string): string {
	if (!logPath || !existsSync(logPath)) return "（无 stderr log——旧版本 pane 命令未重定向 stderr）";
	const lines = readFileSync(logPath, "utf8").split("\n");
	return ["## 子 agent stderr（末 30 行）", "```", ...lines.slice(-30), "```"].join("\n");
}

/**
 * 事件驱动等待子 agent 完成，把 result.md 内容以纯显示 entry 打进 TUI。
 * 协议与主 agent 拿结论的说明（mainAgentNote）同构：exit 文件已存在 → 直接判读；
 * 否则阻塞 wait-for（零 token），与每轮 600s 兜底 race——超时后 kill 掉挂着的
 * tmux client，再 has-session 判读：会话还在 = 没跑完，继续下一轮 wait-for；
 * 会话已消失 = 已结束但信号被错过（如 pane-died hook 注册失败时的崩溃），读
 * exit 判读。总量上限 6h，防止 hook 全部失效时无限等。不改变等待/读取协议：
 * 主会话模型仍按 mainAgentNote 自行 wait-for + read；这里只是让用户在 TUI
 * 里直接看到子 agent 的回复。
 *
 * 已知边界（均为可接受的最坏情况）：
 * - 信号在「循环头检查 exit」与「wait-for 建立等待」之间的空窗被错过（信号对
 *   后来者不重放）：该轮睡满 600s 后由 has-session 分支判读，报告最多迟到一轮；
 * - 用户退出会话：本 watcher 的 JS 逻辑随之静默终止（不阻塞进程退出），tmux
 *   client 进程成为孤儿，正常完成时被信号唤醒自行退出。
 */
const WATCH_ROUND_TIMEOUT = 600_000;
const WATCH_TOTAL_LIMIT = 6 * 3600_000;
async function watchSubagentResult(
	pi: ExtensionAPI,
	opts: {
		session: string;
		artifactPath: string;
		exitFile: string;
		done: string;
		logPath: string;
		/** 回复 entry 的 label（data.label，渲染时显示） */
		label: string;
	},
): Promise<void> {
	const { session, artifactPath, exitFile, done, logPath, label } = opts;
	const started = Date.now();
	while (Date.now() - started < WATCH_TOTAL_LIMIT) {
		if (existsSync(exitFile)) break;
		// wait-for 阻塞等待。wait-for 的信号会唤醒同一频道上所有等待者，
		// 与主 agent 的 bash wait-for 互不干扰。
		let waiter: import("node:child_process").ChildProcess | undefined;
		const signal = runTmux(["wait-for", done], (proc) => {
			waiter = proc;
			// 全部句柄 unref：proc.unref 压不住 stdio 管道句柄（它们是独立的
			// ref'd handle），必须逐个 unref，否则用户退出会话时主进程会被
			// 挂着的 wait-for 管道拖住。代价：会话退出后该 tmux client 会成为
			// 孤儿进程（挂到信号或 server 死亡才退出，正常完成路径会被唤醒收掉）。
			proc.unref?.();
			// stdio 为 pipe 时 stdout/stderr 实际是 net.Socket，有 unref
			(proc.stdout as import("node:net").Socket | null)?.unref?.();
			(proc.stderr as import("node:net").Socket | null)?.unref?.();
		});
		let fired = false;
		const timeout = new Promise<undefined>((resolve) => {
			const t = setTimeout(() => {
				fired = true;
				resolve(undefined);
			}, WATCH_ROUND_TIMEOUT);
			t.unref?.();
		});
		// 注意：tmux server 死掉时 wait-for 会以 code 0 静默醒来（像收到信号一样），
		// 随后 exit 文件仍缺失、下一轮 wait-for 立刻报错——code≠0 也导向判读分支，
		// 否则会空转死循环到 6h 上限。
		const r = await Promise.race([signal, timeout]);
		if (!fired && r && r.code === 0) continue; // 信号先到：回循环头读 exit 判读
		waiter?.kill(); // 超时或 wait-for 异常退出：收掉挂着的 client
		const has = await runTmux(["has-session", "-t", session]);
		if (has.code === 0) continue; // 会话还在 = 没跑完，再等一轮
		// 会话已消失 = 已结束但信号被错过：exit 缺失视为异常终止
		if (!existsSync(exitFile)) {
			pi.appendEntry(SUBAGENT_REPLY_ENTRY, {
				label,
				body: existsSync(artifactPath) ? readFileSync(artifactPath, "utf8") : failureLog(logPath),
				note: `会话已结束但 exit 缺失（异常终止/被强杀，或 tmux server 不可用），回复可能不完整 · ${artifactPath}`,
			});
			return;
		}
	}
	// 跳出循环 = exit 文件已出现（正常路径），或总量超限（hook 全部失效的挂死场景）
	if (existsSync(exitFile)) {
		const code = readFileSync(exitFile, "utf8").trim();
		const ok = code === "0";
		pi.appendEntry(SUBAGENT_REPLY_ENTRY, {
			label,
			body: existsSync(artifactPath) && ok ? readFileSync(artifactPath, "utf8") : failureLog(logPath),
			note: ok ? `exit 0 · ${artifactPath}` : `exit ${code || "缺失"}（异常终止）· ${artifactPath}`,
		});
		return;
	}
	pi.appendEntry(SUBAGENT_REPLY_ENTRY, {
		label,
		body: "",
		note: `等待超时（6 小时未结束），未产出回复。交付物路径：${artifactPath}`,
	});
}
