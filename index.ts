import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	ADVISOR_SYSTEM_PROMPT,
	ADVISOR_TOOLS,
	buildAdvisorBrief,
	notifyAdvisorMissingModel,
	resolveAdvisor,
	setupAdvisor,
} from "./advisor";

const SOCKET = "pi-sub";

function kebab(s: string): string {
	return (
		s
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "task"
	);
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** 4 位 base36 随机后缀（约 168 万组合）：保证并发任务不撞会话/频道/目录名 */
function shortId(): string {
	let id = "";
	for (let i = 0; i < 4; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
	return id;
}

function shQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 通用进程运行器：收集 stdout/stderr */
function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const proc = spawn(cmd, args, {
			env: { ...process.env, TMUX: "" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d) => (stdout += d.toString()));
		proc.stderr.on("data", (d) => (stderr += d.toString()));
		proc.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
		proc.on("error", (err) => resolve({ code: 1, stdout, stderr: stderr || String(err) }));
	});
}

/** 运行 tmux 命令。TMUX= 清空避免嵌套告警（等价 shell 里的 TMUX= 前缀）。 */
function runTmux(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return run("tmux", ["-L", SOCKET, ...args]);
}

/** useWatchdog = 收尾走 stop_watchdog（false 时改为 pi -p，跑完自动退出，无需收尾动作）。
 * done = wait-for 完成频道名，收尾文案里告知 AI 信号来源。 */
function buildBrief(question: string, context: string | undefined, artifactPath: string, useWatchdog: boolean): string {
	const completion = useWatchdog
		? `
## 收尾
- 全部完成后（交付物已写完、无其他内容要输出时）把 stop_watchdog 作为最后一个动作调用
`
		: "";
	return `# 任务简报

## 目标
${question}

## 已知背景（来自主会话，本简报是你唯一的上下文来源）
${context?.trim() || "（无）"}

## 交付物
- 交付物写入 ${artifactPath}：结论优先，克制篇幅，每条附来源 URL（如适用），标注未核实的内容
${completion}
## 边界
- 不要再委派新子 agent（spawn_sub）：你自己在执行 brief，委派只属于主会话
- tmux 命令永远带 -L ${SOCKET}（专用 socket）；禁止对默认 tmux server 执行任何 kill 操作`;
}

interface LaunchOpts {
	/** "advisor" 用咨询简报模板 + 限制工具集 + 换系统提示词；缺省 = 任务模式 */
	mode?: "advisor";
	/**
	 * 追加到预设之后的子 agent pi CLI 参数（已 shQuote）。pi 的单值 flag
	 * （--model/--tools/--system-prompt）是后值覆盖前值，可覆盖模式预设。
	 */
	extraArgs?: string[];
}

interface LaunchResult {
	ok: boolean;
	/** 给主会话模型的说明（进入 LLM 上下文；应尽量短） */
	text: string;
	/** 给用户的运维速查（只在 TUI 渲染，不进 LLM 上下文） */
	ops?: string;
	session?: string;
	artifactPath?: string;
	exitFile?: string;
	done?: string;
	logPath?: string;
}

async function launchSub(
	pi: ExtensionAPI,
	question: string,
	context: string | undefined,
	opts?: LaunchOpts,
): Promise<LaunchResult> {
	if (!question.trim()) {
		return { ok: false, text: "缺少任务描述（question）。" };
	}
	// watchdog 收尾路径是否可用：/watchdog 命令由 pi-watchdog 无条件注册，代表扩展已
	// 加载（是否运行无关紧要——子 agent 的开启由本扩展注入 PI_WATCHDOG 决定，加载即
	// 开启）。主会话与子 agent 共享同一份扩展配置（全局 packages + 同 cwd），主会话
	// 探测到 = 子 agent 里也有。探测放在 spawn/advisor 调用时而非扩展加载时：加载期
	// 各扩展的注册时序不保证。按 source === "extension" 匹配，避免同名 skill/prompt
	// 模板误判。未加载时回退 pi -p 批处理路径（见 inner 的组装说明）。
	const useWatchdog = pi.getCommands().some((c) => c.name === "watchdog" && c.source === "extension");
	const session = `${kebab(question)}-${shortId()}`;
	const name = session;
	const done = `${session}-done`;
	const dir = join("/tmp", `pi-sub-${name}`);
	const briefPath = join(dir, "brief.md");
	const artifactPath = join(dir, "result.md");
	const exitFile = join(dir, "exit");
	const logPath = join(dir, "log");

	// 会话名带随机后缀，正常情况下不会命中；兜底场景
	// 仍不重复拉起，报告现状让用户决定
	const has = await runTmux(["has-session", "-t", session]);
	if (has.code === 0) {
		const ls = await runTmux(["ls"]);
		return {
			ok: false,
			text: `会话 ${session} 已存在，未重复启动。\n当前 ${SOCKET} socket 上的会话：\n${ls.stdout || ls.stderr}`,
		};
	}

	mkdirSync(dir, { recursive: true });
	const brief =
		opts?.mode === "advisor"
			? buildAdvisorBrief(question, context, artifactPath, useWatchdog)
			: buildBrief(question, context, artifactPath, useWatchdog);
	writeFileSync(briefPath, brief, { mode: 0o600 });
	// 上次同名任务残留的退出码会污染本次成败判定，启动前清掉
	try {
		rmSync(exitFile, { force: true });
	} catch {
		/* ignore */
	}

	// 子 agent 的启动 prompt 只剩一个位置参数（普通 prompt 路径，完整 await）。
	// 位置参数保证 -p 模式完整等待回合结束（命令处理器里的 sendUserMessage 是
	// fire-and-forget，-p 会在后台回合开始前退出——已踩坑）。
	const briefTask = shQuote(`Read the brief at ${briefPath} and execute it fully.`);
	// 完成协议按 watchdog 是否加载分两路：
	// - watchdog 路径（默认）：交互式 pi + mode=keep 常驻监控。AI 调用 stop_watchdog
	//   停止监控时，由 ON_STOP 钩子（不经 LLM 再跑一轮 bash，无 API 故障风险）先把 0
	//   写入 exit 文件（pi 此刻仍在运行，先写 0 让等待方在信号时刻读到「正常完成」，
	//   不会把 exit 缺失误判为崩溃），发完成信号，然后关闭 tmux 会话：pi 收到 SIGHUP
	//   走优雅退出；pane shell 与 pi 同进程组、默认死于 SIGHUP，抢不到机会把真实
	//   退出码写进 exit 覆盖预写的 0（且 pi 优雅退出码本就是 0，双保险）。sleep 0.3
	//   给 pi 收尾余量；即使 ON_STOP 中途失败，pane-died hook 仍兜底发信号。
	// - pi -p 回退（watchdog 未加载，如未安装/被禁用）：跑完一个回合进程即退出，
	//   真实退出码由 pane shell 写入 exit 文件，输出重定向到 log；不注入 watchdog
	//   环境变量。pi 会话默认保存（不加 --no-session），pane 命令链结束后会话随
	//   之自动关闭，回看执行过程读会话 jsonl。pane 内不加 timeout：macOS 无此命令
	//   （GNU coreutils 专属，exit 127 秒死——踩过）。挂死防护交给人工围观。
	// 两条路都靠 pane-died hook 兜底：崩溃/被杀时信号照发，exit 缺失 → 等待方
	// 识别为异常终止。主进程不等待：new-session -d 创建会话即返回；等待发生在
	// 后台 pane 内，主进程靠 wait-for done 事件驱动感知完成，再读 exit 判成败。
	// wait-for 语义（实测 0.85.1 自带 tmux）：-S 发出的信号会被 server 记住，稍后的
	// wait-for 立即返回，不存在「信号在等待空窗期被丢弃后重发永久阻塞」的问题。
	// timeout 命中后可以直接重发 wait-for 继续等。但等待必须有界：信号可能根本不会来
	// （子 agent LLM 未调 stop_watchdog、watchdog max 催促耗尽后直接 teardown 不发
	// ON_STOP、watchdog 未接管等），连续多次 timeout 且会话仍在时 capture-pane 看现场
	// 再决定等还是处置——等待方挂起比等待方超时更糟。
	// 模式预设 flag 在前（advisor 模式限制工具集、换 advisor 人格提示词），
	// 调用方的 extraArgs 在后：pi 的参数解析对 --model/--tools/--system-prompt
	// 这类单值 flag 是后值覆盖前值，后者可覆盖前者的同名 flag。
	// -p 回退下 stop_watchdog 不存在（未注入 PI_WATCHDOG），从 advisor 工具集中
	// 滤掉；即使忘了滤，--tools 对未知工具名也会忽略，无害。
	const advisorTools = useWatchdog ? ADVISOR_TOOLS : ADVISOR_TOOLS.filter((t) => t !== "stop_watchdog");
	const flags: string[] =
		opts?.mode === "advisor"
			? ["--tools", shQuote(advisorTools.join(",")), "--system-prompt", shQuote(ADVISOR_SYSTEM_PROMPT)]
			: [];
	if (opts?.extraArgs?.length) flags.push(...opts.extraArgs);
	const piCmd = useWatchdog
		? `pi ${flags.join(" ")} ${briefTask}`
		: `pi -p ${flags.join(" ")} ${briefTask} > ${logPath} 2>&1`;
	const inner = `${piCmd}; echo $? > ${exitFile}`;

	// watchdog 经 tmux -e 注入会话环境：pane 里的 pi 能读到，不出现在启动命令字符串里。
	// PI_SUBAGENT 两条路都注入：子 agent 内禁注册 spawn_sub（防嵌套）。
	const envArgs = [
		"-e",
		"PI_SUBAGENT=1",
		// 两条路都注入：子 agent 自检失败时（watchdog 缺位）写 exit 并发完成信号，
		// 让等待方快速失败而不是静默挂死
		"-e",
		`PI_SUB_EXIT_FILE=${exitFile}`,
		"-e",
		`PI_SUB_DONE=${done}`,
		...(useWatchdog
			? [
					"-e",
					"PI_WATCHDOG=timeout=5 max=50 mode=keep",
					"-e",
					`PI_WATCHDOG_ON_STOP=echo 0 > ${exitFile} && TMUX= tmux -L ${SOCKET} wait-for -S ${done} && sleep 0.3 && TMUX= tmux -L ${SOCKET} kill-session -t ${session}`,
				]
			: []),
	];
	// 注意：-e 是 new-session 命令的参数，必须跟在 new-session 后面；
	// 放在 tmux 全局选项位置会报 "unknown option -- e"
	const launch = await runTmux(["new-session", ...envArgs, "-d", "-s", session, "-x", "220", "-y", "50", inner]);
	if (launch.code !== 0) {
		return { ok: false, text: `tmux 启动失败：${launch.stderr || launch.stdout}` };
	}

	// pane 进程退出（正常收尾/崩溃/被杀）时自动发完成信号——不依赖子 agent 的 LLM，
	// 主会话因此无需轮询即可感知失败。会话名含随机后缀，并发任务各占独立 done 频道，
	// 不会互相串信号；done 频道名只含字母数字与连字符，单引号内联安全。
	const hook = await runTmux([
		"set-hook",
		"-t",
		session,
		"pane-died",
		`run-shell -b 'TMUX= tmux -L ${SOCKET} wait-for -S ${done}'`,
	]);
	if (hook.code !== 0) {
		if (!useWatchdog) {
			// -p 回退唯一信号来源是 pane-died hook（brief 不要求 LLM 发信号），缺失必须回滚
			await runTmux(["kill-session", "-t", session]);
			return {
				ok: false,
				text: `注册 pane-died hook 失败（${(hook.stderr || hook.stdout).trim()}），已回收会话；完成信号无法保证送达，未启动子 agent。`,
			};
		}
		// watchdog 路径不回滚：ON_STOP 钩子仍会发信号，只是失去崩溃兜底
		return {
			ok: true,
			text: `已启动子 agent，但注册 pane-died hook 失败（${(hook.stderr || hook.stdout).trim()}）：进程崩溃时不再自动发完成信号，需人工围观或超时排查。交付物：${artifactPath}`,
			session,
			artifactPath,
			exitFile,
			done,
			logPath,
		};
	}

	// 速查表只给用户：放 details，经 renderResult 渲染，不进 LLM 上下文
	const ops = opsCheatsheet(session, artifactPath, exitFile, done);

	// LLM 只需要等待/读取结论的最小说明：等待命令带 timeout 防挂死；timeout 命中后
	// 重发即可（信号会被记住，见上方 wait-for 语义注释）；连续多次 timeout 且会话仍在
	// 时 capture-pane 看现场，有界重试——覆盖「LLM 忘调 stop_watchdog / watchdog max
	// 催促耗尽 / watchdog 未接管」等信号永不来的场景。
	const exitNote = useWatchdog
		? "exit 文件为 0 = 正常收尾；非 0 或缺失 = 失败/异常终止。"
		: "子 agent 为 pi -p 批处理模式：exit 文件 0 = 成功，非 0 = 失败，缺失 = 崩溃/被杀。";
	const mainAgentNote = [
		"需要结论时在 bash 执行 " +
			`tmux -L ${SOCKET} wait-for ${done}` +
			"，必须用 bash 的 timeout 参数限时（建议 600s，阻塞等待零 token）",
		"。timeout 命中后重发本命令继续等即可（tmux 会记住已发的信号，不会永久阻塞）。" +
			"若连续 2-3 次 timeout 且 `TMUX= tmux -L " +
			SOCKET +
			" has-session -t " +
			`${session}` +
			"` 显示会话仍在：执行 `tmux -L " +
			SOCKET +
			" capture-pane -t " +
			`${session}` +
			" -p | tail -30` 看现场——子 agent 可能没调 stop_watchdog 或已挂死，酌情继续等、kill-session 后按失败处理",
		`。返回后 read ${artifactPath}。${exitNote}`,
	].join("");

	return {
		ok: true,
		text: `已启动子 agent（交付物：${artifactPath}）。${mainAgentNote}`,
		ops,
		session,
		artifactPath,
		exitFile,
		done,
		logPath,
	};
}

/** 常用运维命令速查：attach 围观 / 看进度 / 读交付物 / 等完成 / 杀会话，全部可直接复制粘贴 */
function opsCheatsheet(session: string, artifactPath: string, exitFile: string, done: string): string {
	return `# 围观子 agent（实时画面，Ctrl-b d 退出；任务完成后会话自动关闭，回看执行过程读 pi 会话历史 jsonl）
tmux -L pi-sub attach -t ${session}

# 看当前进度（不进入，只抓最后一屏）
tmux -L pi-sub capture-pane -t ${session} -p | tail -30

# 看所有运行中的子 agent
tmux -L pi-sub ls

# 读交付物（写完后）
cat ${artifactPath}

# 阻塞等它完成（子 agent 完成发信号或进程退出时自动发信号，无论成败；命令随即返回）
# 建议用工具 timeout 限时跑（如 600s）：tmux 会记住已发的信号，timeout 命中后
# 直接重发本命令继续等即可（不会永久阻塞）；若连续多次 timeout 且
# tmux -L pi-sub has-session -t <会名> 显示会话仍在，用上面的 capture-pane
# 看现场——子 agent 可能没调 stop_watchdog 或已挂死，酌情继续等或 kill-session
# 按失败处理
tmux -L pi-sub wait-for ${done}

# 退出码（0=正常收尾；非 0=失败；文件缺失=被强杀/崩溃）
cat ${exitFile}

# 只杀这一个子 agent
tmux -L pi-sub kill-session -t ${session}

# 全部结束后的收尾（清掉专用 socket 上所有残留，不影响你自己的 tmux）
tmux -L pi-sub kill-server`;
}

export default async function (pi: ExtensionAPI) {
	// 子 agent pane 内（启动时经 tmux -e 注入 PI_SUBAGENT=1）不再注册 spawn_sub，
	// 从机制上禁止嵌套委派，替代原先的 promptGuidelines 软约束。
	if (process.env.PI_SUBAGENT === "1") {
		// 自检（放到 session_start：此时各扩展已加载完，/watchdog 的注册时序不再有假阴性；
		// 与 launchSub 的探测一样按 source === "extension" 匹配）。
		// 注入了 PI_WATCHDOG 却找不到 watchdog 扩展 = 交互式收尾机制缺位：任务做完 pi
		// 不会退出、不发完成信号，tmux 会话将永久残留。此时尽快失败暴露：写非 0 exit
		// 并直接发完成信号，让等待方立刻读到明确失败（宁可误判失败，不要静默挂死）。
		// pi -p 回退路径不注入 PI_WATCHDOG，天然不触发本分支。
		if (process.env.PI_WATCHDOG) {
			pi.on("session_start", async (_event, ctx) => {
				if (pi.getCommands().some((c) => c.name === "watchdog" && c.source === "extension")) return;
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
		return;
	}

	// ---------- advisor（可选功能）----------
	// 默认不注册：未配置时主模型看不到这个工具，promptGuidelines 也不会注入（零开销）。
	// 开关与工具定义见 advisor.ts；这里只负责把 launchSub 包成 AdvisorLaunch 回调，
	// 并补 --model 预设（advisor 模型/thinking 完全由配置决定，模型不可干预）。
	const advisor = resolveAdvisor();
	if (advisor.enabled && advisor.model) {
		const advisorModel = advisor.model;
		// enabled 蕴含 model 非空（resolveAdvisor 保证）：沿用默认模型就没有 advisor 的意义
		setupAdvisor(pi, (question, context) =>
			launchSub(pi, question, context, { mode: "advisor", extraArgs: [`--model ${shQuote(advisorModel)}`] }),
		);
		// 显式提示：开启时让用户在会话里能直接看到 advisor 已注册及其模型/思考档位，
		// 不用靠问模型或触发调用来确认。模型串格式为 pi --model 的 "provider/id:thinking"，
		// ":" 后是思考档位（如 max/high），没有 ":" 就只展示模型。
		pi.on("session_start", (_event, ctx) => {
			const colon = advisorModel.lastIndexOf(":");
			const model = colon > 0 ? advisorModel.slice(0, colon) : advisorModel;
			const thinking = colon > 0 ? advisorModel.slice(colon + 1) : undefined;
			ctx.ui.notify(`advisor 已注册（模型：${model}${thinking ? `，思考档位：${thinking}` : ""}）`, "info");
		});
	} else if (advisor.missingModel) {
		// 配了 enabled: true 但没配模型：不开启，直接在会话里提示用户补配置
		notifyAdvisorMissingModel(pi);
	}

	// ---------- spawn_sub ----------
	pi.registerTool({
		name: "spawn_sub",
		label: "子 agent 委派",
		description: "Delegate a task to an isolated pi sub-agent; deliverable written to /tmp/pi-sub-<name>/result.md",
		promptSnippet: "spawn_sub — delegate multi-step or context-heavy tasks to an isolated tmux sub-agent",
		// 只写调用前的决策信息（何时用、context 要自包含）。
		// 调用后怎么拿结论（wait-for 频道名、exit 文件判读）依赖运行时才知道的值，
		// 只能写在工具返回的 mainAgentNote 里，这里不放。
		promptGuidelines: [
			"Use spawn_sub when a task needs many steps, heavy exploration, or lots of tokens; keep single-step work in the main session.",
			"Before calling spawn_sub, distill everything the sub-agent needs into the context parameter (file paths, conclusions, URLs, constraints) — it has zero memory of this conversation.",
		],
		parameters: Type.Object({
			question: Type.String({
				description:
					"Task goal, stated precisely; define what a good deliverable looks like (depth, language, acceptance criteria). Do not include the deliverable path — the directory is fixed at /tmp/pi-sub-<name>/result.md and the brief carries it",
			}),
			context: Type.Optional(
				Type.String({
					description:
						"Session context relevant to the task: file paths, conclusions so far, URLs, user preferences or constraints. The sub-agent has zero memory of this conversation — anything not written here is unknown to it",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const r = await launchSub(pi, params.question, params.context);
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
			return new Text(theme.fg("muted", `已启动。常用操作（复制到任意终端）：\n${ops}`), 0, 0);
		},
	});
}
