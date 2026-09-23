import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

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

// ---------- advisor 工具注册 ----------

/**
 * 拉起 advisor 子 agent 的回调：由 index.ts 注入（包一层 launchSub，负责补
 * --model 预设）。advisor.ts 不接触 tmux 与 shell 细节。
 */
export type AdvisorLaunch = (
	question: string,
	context: string | undefined,
) => Promise<{ ok: boolean; text: string; ops?: string }>;

/**
 * 注册 advisor 工具（resolveAdvisor().enabled 时由 index.ts 调用）。
 * 模型/thinking 预设由 index.ts 的 launch 回调负责；这里只管工具定义。
 */
export function setupAdvisor(pi: ExtensionAPI, launch: AdvisorLaunch): void {
	pi.registerTool({
		name: "advisor",
		label: "咨询 advisor",
		description:
			"Escalate to a stronger advisor model to review your plan, claim, or completed work before you act. The advisor has zero memory " +
			"of this conversation — it only sees `question` and `context`, which must be self-contained (file paths, conclusions so far, " +
			"constraints, URLs). Returns a plan, a correction, or a stop signal; full advice is written to /tmp/pi-sub-<name>/result.md.",
		promptSnippet:
			"advisor — get a second opinion on approach/claims/done-ness; call before substantive work, when stuck, or before declaring done",
		// 取材 rpiv-advisor 的规则，按本项目「context 需自包含」的调用方式改写。
		promptGuidelines: [
			"Call `advisor` BEFORE substantive work — before writing, before committing to an interpretation, before building on an assumption. Orientation (finding files, fetching a source, seeing what's there) is not substantive work; writing, editing, and declaring an answer are.",
			"Also call `advisor` when stuck — errors recurring, approach not converging, results that don't fit — or when considering a change of approach.",
			"Also call `advisor` when you believe the task is complete. Make the deliverable durable FIRST (write the file, save the result): the advisor call takes time, and a durable result survives a session that ends during the call.",
			"The context parameter must be self-contained — the advisor has zero memory of this conversation and only sees your summary (file paths, conclusions so far, constraints). Every file path in it MUST be absolute; resolve relative paths against your cwd before calling.",
			"Give the advisor's advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim, surface the conflict in one more `advisor` call instead of silently switching branches.",
			"After each `advisor` result, put the advisor's key guidance into your next visible reply to the user before continuing — the user often cannot see collapsed tool results.",
			"Not for trivial lookups where the next action is dictated by tool output you just read — the advisor adds latency and pays off on judgment calls.",
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
