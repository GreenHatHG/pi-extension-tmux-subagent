/**
 * advisor 工具（主会话，可选功能：resolveAdvisor().enabled 时由 index.ts 注册）。
 * 职责：工具定义、简报/回复的 TUI entry 渲染、advisor 完成的 TUI watcher、
 * 配置提示。advisor 的配置解析在 core/config.ts，简报模板与预设 flag 在 modes/，
 * 本文件只管「主会话侧如何呈现与注册」。
 */
import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { runTmux } from "../core/tmux";
import { onEvent } from "../registry";
import { type LaunchFn, renderResultWithOps, startedToolResult } from "./shared";

// ---------- 顾问内容的纯显示输出（appendEntry：不进 LLM 上下文） ----------

interface AdvisorEntryData {
	label: string;
	body: string;
	note?: string;
}

/**
 * advisor 简报/回复的 entry 渲染器：默认折叠为一行摘要，ctrl+o（app.tools.expand）
 * 展开为完整 Markdown。数据经 pi.appendEntry 写入（不参与 LLM 上下文），
 * 会话恢复后也能重渲染。
 */
function renderAdvisorEntry(
	entry: { data?: unknown },
	options: { expanded: boolean },
	theme: Parameters<Parameters<ExtensionAPI["registerEntryRenderer"]>[1]>[2],
) {
	const d = (entry.data ?? {}) as Partial<AdvisorEntryData>;
	const body = d.body ?? "";
	const lines = body ? body.split("\n") : [];
	if (!options.expanded) {
		const note = d.note ? ` · ${d.note}` : "";
		return new Text(theme.fg("muted", `▸ ${d.label ?? "advisor"}（${lines.length} 行${note}，ctrl+o 展开）`), 1, 0);
	}
	const c = new Container();
	c.addChild(new Text(theme.fg("toolTitle", theme.bold(`▾ ${d.label ?? "advisor"}`)), 1, 0));
	if (d.note) c.addChild(new Text(theme.fg("muted", d.note), 1, 0));
	c.addChild(new Markdown(body || "（空）", 1, 0, getMarkdownTheme()));
	return c;
}

// ---------- TUI watcher：事件驱动等待 advisor 完成 ----------

/**
 * 事件驱动等待 advisor 完成，把 result.md 内容以纯显示 entry 打进 TUI。
 * 协议与主 agent 拿结论的说明（mainAgentNote）同构：exit 文件已存在 → 直接判读；
 * 否则阻塞 wait-for（零 token），与每轮 600s 兜底 race——超时后 kill 掉挂着的
 * tmux client，再 has-session 判读：会话还在 = 没跑完，继续下一轮 wait-for；
 * 会话已消失 = 已结束但信号被错过（如 pane-died hook 注册失败时的崩溃），读
 * exit 判读。总量上限 6h，防止 hook 全部失效时无限等。不改变等待/读取协议：
 * 主会话模型仍按 mainAgentNote 自行 wait-for + read；这里只是让用户在 TUI
 * 里直接看到 advisor 的回复。
 *
 * 已知边界（均为可接受的最坏情况）：
 * - 信号在「循环头检查 exit」与「wait-for 建立等待」之间的空窗被错过（信号对
 *   后来者不重放）：该轮睡满 600s 后由 has-session 分支判读，报告最多迟到一轮；
 * - 用户退出会话：本 watcher 的 JS 逻辑随之静默终止（不阻塞进程退出），tmux
 *   client 进程成为孤儿，正常完成时被信号唤醒自行退出。
 */
const WATCH_ROUND_TIMEOUT = 600_000;
const WATCH_TOTAL_LIMIT = 6 * 3600_000;
async function watchAdvisorResult(
	pi: ExtensionAPI,
	session: string,
	artifactPath: string,
	exitFile: string,
	done: string,
): Promise<void> {
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
			pi.appendEntry("pi-advisor-reply", {
				label: "advisor 回复",
				body: existsSync(artifactPath) ? readFileSync(artifactPath, "utf8") : "",
				note: `会话已结束但 exit 缺失（异常终止/被强杀，或 tmux server 不可用），回复可能不完整 · ${artifactPath}`,
			});
			return;
		}
	}
	// 跳出循环 = exit 文件已出现（正常路径），或总量超限（hook 全部失效的挂死场景）
	if (existsSync(exitFile)) {
		const code = readFileSync(exitFile, "utf8").trim();
		const ok = code === "0";
		pi.appendEntry("pi-advisor-reply", {
			label: "advisor 回复",
			body: existsSync(artifactPath) ? readFileSync(artifactPath, "utf8") : "",
			note: ok ? `exit 0 · ${artifactPath}` : `exit ${code || "缺失"}（异常终止），回复可能不完整 · ${artifactPath}`,
		});
		return;
	}
	pi.appendEntry("pi-advisor-reply", {
		label: "advisor 回复",
		body: "",
		note: `等待超时（6 小时未结束），未产出回复。交付物路径：${artifactPath}`,
	});
}

// ---------- 工具注册 ----------

/**
 * 注册 advisor 工具。模型/thinking 预设由 index.ts 的 launch 回调负责（补 --model
 * 预设；advisor 模式/thinking 完全由配置决定，模型不可干预）；这里管工具定义与 TUI 呈现。
 *
 * @param advisorModel pi --model 格式串（"provider/id:thinking"），仅用于 session_start 提示
 * @param launch       index.ts 注入的启动回调（包一层 launchSub，mode = advisorMode）
 */
export function setupAdvisor(pi: ExtensionAPI, advisorModel: string, launch: LaunchFn): void {
	pi.registerEntryRenderer("pi-advisor-brief", renderAdvisorEntry);
	pi.registerEntryRenderer("pi-advisor-reply", renderAdvisorEntry);

	// 显式提示：开启时让用户在会话里能直接看到 advisor 已注册及其模型/思考档位，
	// 不用靠问模型或触发调用来确认。模型串格式为 pi --model 的 "provider/id:thinking"，
	// ":" 后是思考档位（如 max/high），没有 ":" 就只展示模型。
	onEvent(
		pi,
		"session_start",
		{
			where: "tools/advisor.ts:开启提示",
			note: "advisor 已注册时：session_start 提示模型与思考档位（解析 pi --model 格式串）",
		},
		(_event: unknown, ctx: { ui: { notify(text: string, level: string): void } }) => {
			const colon = advisorModel.lastIndexOf(":");
			const model = colon > 0 ? advisorModel.slice(0, colon) : advisorModel;
			const thinking = colon > 0 ? advisorModel.slice(colon + 1) : undefined;
			ctx.ui.notify(`advisor 已注册（模型：${model}${thinking ? `，思考档位：${thinking}` : ""}）`, "info");
		},
	);

	pi.registerTool({
		name: "advisor",
		label: "咨询 advisor",
		description:
			"Escalate to a stronger advisor model to review your plan, claim, or completed work before you act. The advisor has zero memory " +
			"of this conversation — it only sees `question` and `context`, which must be self-contained (file paths, conclusions so far, " +
			"constraints, URLs). Returns a plan, a correction, or a stop signal. The full advice is written to a system-generated " +
			"path (/tmp/pi-sub-<session>/result.md), whose exact value is given in the tool response. " +
			"Do not put the deliverable path in `question` — the brief the advisor receives already carries it",
		promptSnippet:
			"get a second opinion on approach/claims/done-ness; call before substantive work, when stuck, or before declaring done",
		// 取材 rpiv-advisor 的规则，按本项目「context 需自包含」的调用方式改写。
		promptGuidelines: [
			"advisor: call BEFORE substantive work — before writing, before committing to an interpretation, before building on an assumption; orientation (finding files, fetching a source, seeing what's there) is not substantive work.",
			"advisor: also call when stuck (errors recurring, approach not converging, results that don't fit) or when considering a change of approach.",
			"advisor: call when you believe the task is complete — make the deliverable durable FIRST (write the file, save the result), because the advisor call takes time and a durable result survives a session that ends mid-call.",
			"advisor: every file path inside the context parameter MUST be absolute — resolve relative paths against your cwd before calling.",
			"advisor: give its advice serious weight — if a step fails empirically or evidence contradicts a specific claim, surface the conflict in another advisor call instead of silently switching branches.",
			"advisor: after each result, restate its key guidance in your next visible reply to the user — they often cannot see collapsed tool results. The full advice lives in the result.md path given in the tool response: wait for completion as instructed there, read the file, then restate what it actually says.",
			"advisor: not for trivial lookups where the next action is dictated by tool output you just read — it adds latency and pays off on judgment calls.",
		],
		parameters: Type.Object({
			question: Type.String({
				description:
					"The decision you need help with, stated precisely. This is judgment on a plan/approach/claim, not task delegation — do not paste the whole task; state what you intend to do and what you're unsure about",
			}),
			context: Type.Optional(
				Type.String({
					description:
						"Self-contained context the advisor needs: file paths, function/line references, conclusions so far, constraints, URLs. " +
						"File paths MUST be absolute (e.g. /Users/you/Projects/app/src/index.ts), never relative — the advisor cannot resolve them against your cwd. " +
						"The advisor has zero memory of this conversation — anything not written here is unknown to it",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			// advisor 也走完整的 spawn 流程（watchdog、pane-died 钩子、exit 文件、
			// wait-for 协议），只是换了 brief 模板和子 agent 的工具/提示词。
			const r = await launch(params.question, params.context);
			if (r.ok) {
				// 简报打进 TUI（appendEntry，不进 LLM 上下文）；回复等子 agent
				// 完成后由 watcher 打进 TUI。等待/读取协议不受影响。
				if (r.brief) {
					pi.appendEntry("pi-advisor-brief", { label: "advisor 咨询简报", body: r.brief });
				}
				if (r.artifactPath && r.exitFile && r.session && r.done) {
					void watchAdvisorResult(pi, r.session, r.artifactPath, r.exitFile, r.done).catch(() => {}); // readFileSync TOCTOU 等异常：watcher 是纯显示增强，静默失败
				}
			}
			return startedToolResult(r.text, r.ops);
		},
		renderResult(result, _options, theme, _context) {
			return renderResultWithOps(result, "已启动 advisor（复制到任意终端围观）：", theme);
		},
	});
}

/** enabled: true 而没配 model 时，在会话里提示用户补配置 */
export function notifyAdvisorMissingModel(pi: ExtensionAPI): void {
	onEvent(
		pi,
		"session_start",
		{
			where: "tools/advisor.ts:缺模型提示",
			note: "advisor.enabled: true 但没配 advisor.model 时：提示用户补配置（此时 advisor 未注册）",
		},
		(_event: unknown, ctx: { ui: { notify(text: string, level: string): void } }) => {
			ctx.ui.notify(
				"advisor 未开启：subagent_advisor.json 配了 advisor.enabled: true 但没有 advisor.model。请在 subagent_advisor.json 配置 advisor.model 或设置环境变量 PI_ADVISOR_MODEL",
				"warning",
			);
		},
	);
}
