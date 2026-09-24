import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { runTmux, shQuote } from "./tmux";

// ---------- advisor 配置（可选功能：默认关闭，显式配置才注册工具） ----------

interface Config {
	advisor?: { enabled?: boolean; model?: string };
}

/** 读 ~/.pi/agent/subagent_advisor.json（PI_CODING_AGENT_DIR 可重定向）；不存在/损坏 = 空配置 */
function loadConfig(): Config {
	const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	const path = join(dir, "subagent_advisor.json");
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Config;
	} catch {
		return {};
	}
}

export interface AdvisorSettings {
	enabled: boolean;
	/** advisor 模型（pi --model 格式，如 "provider/id:high"）；undefined 不会沿用默认模型，而是不开 advisor（enabled: true 时提示补配置） */
	model?: string;
	/** 配了 enabled: true 但没配模型：不开，由 session_start 提示用户补配置 */
	missingModel?: boolean;
}

/**
 * advisor 是可选功能：默认不注册（零开销，主模型看不到这个工具）。开关即配置：
 * - 环境变量 PI_ADVISOR_MODEL 非空 → 开，且用该模型
 * - 配置文件 advisor.model 非空 → 开（配了模型即视为要用 advisor）
 * - 配置文件 advisor.enabled === true 但没配 model → 不开（advisor 的意义在更强的模型，
 *   沿用默认模型没有意义），由 session_start 里的 notify 提示用户补配置
 * - 其余情况（含 advisor.enabled === false、无配置）→ 关，不提示
 */
export function resolveAdvisor(): AdvisorSettings {
	const env = process.env.PI_ADVISOR_MODEL?.trim();
	if (env) return { enabled: true, model: env };
	const a = loadConfig().advisor;
	if (!a || a.enabled === false) return { enabled: false };
	if (a.model?.trim()) return { enabled: true, model: a.model.trim() };
	if (a.enabled === true) return { enabled: false, missingModel: true };
	return { enabled: false };
}

// ---------- advisor 模式下子 agent 的预设（brief / 工具集 / 系统提示词） ----------

/** advisor 模式允许的子 agent 工具集：判断型最小集，交付靠 write（+ watchdog 收尾时的 stop_watchdog，无 watchdog 时由调用方滤掉） */
export const ADVISOR_TOOLS = ["read", "write", "stop_watchdog"];

/**
 * advisor 模式下子 agent 的系统提示词（pi --system-prompt 替换默认提示词）。
 * 取材 rpiv-advisor，按本项目的执行环境改写：advisor 有 read/write（watchdog 收尾时
 * 另有 stop_watchdog）三个工具，交付协议与任务模式一致（写 result.md；收尾方式
 * 由 brief 按运行模式交代，不写死在这里）。
 */
export const ADVISOR_SYSTEM_PROMPT = `You are an advisor model in an advisor-strategy pattern. An executor agent running a real task consults you with a question plus a self-contained context summary; you answer with judgment, not exploration.

Your reply is ONE of:
- a plan: concrete next steps the executor should take, in order;
- a correction: the executor is going down a wrong path — redirect it, and say why;
- a stop signal: the executor should halt and escalate to the user.

Rules:
- Read files only when needed to verify a claim in the context summary. NEVER modify anything: write is for the deliverable only.
- Context file paths are absolute; read them as given. If a path looks relative, do not guess its base — state that the path is unusable and ask for an absolute one.
- Ground advice in the given context. Name files, functions, and line numbers where possible.
- Be concise and directive. No preamble, no apologies, no meta-commentary — just the guidance.
- Deliverable protocol (from your brief): write your full guidance to the result.md path given there.`;

/**
 * advisor 模式下子 agent pi 的预设 flag（放在启动参数最前面）：限制工具集 + 换 advisor
 * 人格系统提示词。-p 回退路径下 stop_watchdog 不存在（未注入 PI_WATCHDOG），从工具集
 * 中滤掉；即使忘了滤，--tools 对未知工具名也会忽略，无害。
 */
export function advisorPresetFlags(useWatchdog: boolean): string[] {
	const tools = useWatchdog ? ADVISOR_TOOLS : ADVISOR_TOOLS.filter((t) => t !== "stop_watchdog");
	return ["--tools", shQuote(tools.join(",")), "--system-prompt", shQuote(ADVISOR_SYSTEM_PROMPT)];
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

// ---------- advisor 工具注册 ----------

/**
 * 拉起 advisor 子 agent 的回调：由 index.ts 注入（包一层 launchSub，负责补
 * --model 预设）。advisor.ts 不接触 tmux 与 shell 细节。
 */
export type AdvisorLaunch = (
	question: string,
	context: string | undefined,
) => Promise<{
	ok: boolean;
	text: string;
	ops?: string;
	/** 咨询简报原文（appendEntry 纯显示用，不进 LLM 上下文） */
	brief?: string;
	artifactPath?: string;
	exitFile?: string;
	/** done 频道名与 tmux 会话名：TUI watcher 事件驱动等待用（见 watchAdvisorResult） */
	session?: string;
	done?: string;
}>;
/**
 * 注册 advisor 工具（resolveAdvisor().enabled 时由 index.ts 调用）。
 * 模型/thinking 预设由 index.ts 的 launch 回调负责；这里只管工具定义。
 */
export function setupAdvisor(pi: ExtensionAPI, launch: AdvisorLaunch): void {
	pi.registerEntryRenderer("pi-advisor-brief", renderAdvisorEntry);
	pi.registerEntryRenderer("pi-advisor-reply", renderAdvisorEntry);
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
			return {
				content: [{ type: "text", text: r.text }],
				details: { ops: r.ops },
			};
		},
		renderResult(result, _options, theme, _context) {
			const ops = (result.details as { ops?: string } | undefined)?.ops;
			if (!ops) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}
			return new Text(theme.fg("muted", `已启动 advisor（复制到任意终端围观）：\n${ops}`), 0, 0);
		},
	});
}

/** enabled: true 而没配 model 时，在会话里提示用户补配置 */
export function notifyAdvisorMissingModel(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.notify(
			"advisor 未开启：subagent_advisor.json 配了 advisor.enabled: true 但没有 advisor.model。请在 subagent_advisor.json 配置 advisor.model 或设置环境变量 PI_ADVISOR_MODEL",
			"warning",
		);
	});
}
