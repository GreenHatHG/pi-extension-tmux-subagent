import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

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

function buildBrief(question: string, context: string | undefined, artifactPath: string, done: string): string {
	return `# 任务简报

## 目标
${question}

## 已知背景（来自主会话，本简报是你唯一的上下文来源）
${context?.trim() || "（无）"}

## 工具策略
本会话是标准 pi 环境，工具与主会话一致（read/bash/edit/write 及已安装扩展注册的工具等），
工具自带的 description 就是完整用法，按需使用即可。
需要联网时用 web_search / fetch_content，不要尝试其他联网手段

## 交付物
- 交付物写入 ${artifactPath}：结论优先，每条附来源 URL（如适用），标注未核实的内容
- 全部完成后（交付物已写完、无其他内容要输出时）把 stop_watchdog 作为最后一个动作调用，
  停止自动继续监控——完成信号（${done}）会由
  watchdog 的 PI_WATCHDOG_ON_STOP 钩子自动发送，调用后回合同步结束，之后不能再有任何输出
（stop_watchdog 即发信号；即使进程异常退出，启动器的 pane-died hook 也会代发信号，等待方以无产物/无退出码识别失败）

## 边界
- 不要修改项目文件；临时产物一律放在 /tmp
- 不要再委派新子 agent（spawn_sub）：你自己在执行 brief，委派只属于主会话
- tmux 命令永远带 -L ${SOCKET}（专用 socket）；禁止对默认 tmux server 执行任何 kill 操作`;
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

async function launchSub(question: string, context: string | undefined): Promise<LaunchResult> {
	if (!question.trim()) {
		return { ok: false, text: "缺少任务描述（question）。" };
	}
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
	writeFileSync(briefPath, buildBrief(question, context, artifactPath, done), { mode: 0o600 });
	// 上次同名任务残留的退出码会污染本次成败判定，启动前清掉
	try {
		rmSync(exitFile, { force: true });
	} catch {
		/* ignore */
	}

	// 子 agent 的启动 prompt 只剩一个位置参数（普通 prompt 路径，完整 await）。
	// 位置参数保证完整等待回合结束（命令处理器里的 sendUserMessage 是 fire-and-forget）。
	const briefTask = shQuote(`Read the brief at ${briefPath} and execute it fully.`);
	// 完成信号由 watchdog 的 PI_WATCHDOG_ON_STOP 钩子在 AI 调用 stop_watchdog 时发出
	//（不经 LLM 再跑一轮 bash，无 API 故障风险）；pane 进程异常退出（崩溃/被杀）时
	// 由 pane-died hook 兜底发信号。pane shell 在 pi 退出后把真实退出码写入 exit 文件；
	// pi 被信号硬杀时 shell 一并死掉，exit 缺失 → 等待方识别为异常终止。
	// pane 内不加 timeout：macOS 无此命令（GNU coreutils 专属，zsh: command not found，
	// exit 127 秒死——踩过）。挂死防护交给 watchdog 的 max 上限与人工围观。
	// 主进程不等待：new-session -d 创建会话即返回（连 pi 是否完全启动都不保证）；
	// $? 是上一条命令的退出码，pane shell 等 pi 结束后把它写入 exit 文件。
	// 等待发生在后台 pane 内，主进程靠 wait-for done 事件驱动感知完成，
	// 再读 exit 文件判定成败（0 = stop_watchdog 发出的正常完成）。
	const inner = `pi ${briefTask}; echo $? > ${exitFile}`;

	// watchdog 经 tmux -e 注入会话环境：pane 里的 pi 能读到，不出现在启动命令字符串里。
	// 注入完成钩子：AI 调用 stop_watchdog 停止监控时，由扩展本地经 sh -c 先把 0 写入
	// exit 文件（pi 此刻仍在运行，pane shell 要到会话结束才写退出码；先写 0 让等待方
	// 在信号时刻读到「正常完成」，不会把 exit 缺失误判为崩溃），再发完成信号。
	const envArgs = [
		"-e",
		"PI_SUBAGENT=1",
		"-e",
		"PI_WATCHDOG=timeout=5 max=50 mode=keep",
		"-e",
		`PI_WATCHDOG_ON_STOP=echo 0 > ${exitFile} && TMUX= tmux -L ${SOCKET} wait-for -S ${done}`,
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
		// 不回滚：brief 仍要求 LLM 完成时发信号，只是失去崩溃兜底
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

	// LLM 只需要等待/读取结论的最小说明
	const mainAgentNote = [
		"不要轮询进度。需要结论时在 bash 执行 " +
			`tmux -L ${SOCKET} wait-for ${done}` +
			"（阻塞等待，零 token；子 agent 完成发信号或进程退出时 hook 自动发信号），",
		`返回后 read ${artifactPath}。同目录 exit 文件为 0 = 正常收尾；非 0 或缺失 = 失败/异常终止。`,
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
	return `# 围观子 agent（实时画面，Ctrl-b d 退出回到你的终端）
tmux -L pi-sub attach -t ${session}

# 看当前进度（不进入，只抓最后一屏）
tmux -L pi-sub capture-pane -t ${session} -p | tail -30

# 看所有运行中的子 agent
tmux -L pi-sub ls

# 读交付物（写完后）
cat ${artifactPath}

# 阻塞等它完成（子 agent 完成发信号或进程退出时自动发信号，无论成败；命令随即返回）
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
	if (process.env.PI_SUBAGENT === "1") return;
	pi.registerTool({
		name: "spawn_sub",
		label: "子 agent 委派",
		description: "Delegate a task to an isolated pi sub-agent; deliverable written to /tmp/pi-sub-<name>/result.md",
		promptSnippet: "spawn_sub — delegate multi-step or context-heavy tasks to an isolated tmux sub-agent",
		promptGuidelines: [
			"Use spawn_sub when a task needs many steps, heavy exploration, or lots of tokens; keep single-step work in the main session.",
			"Before calling spawn_sub, distill everything the sub-agent needs into the context parameter (file paths, conclusions, URLs, constraints) — it has zero memory of this conversation.",
			"After spawn_sub returns, do not poll progress; when you need the conclusion run `tmux -L pi-sub wait-for <done>` in bash (blocking, zero tokens), then read /tmp/pi-sub-<name>/result.md.",
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
			const r = await launchSub(params.question, params.context);
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
