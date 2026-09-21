/**
 * subagent 扩展 — 提供 spawn_sub 工具，把多步或上下文很重的任务委派给一个隔离的 pi 子 agent。
 *
 * 心智模型：一个子 agent 就是在 tmux 里另开的一个 pi 进程。它收到一份任务简报
 * （brief.md），把最终结论写到 result.md，结束时发一个信号通知主会话。
 * 除此之外的细节（watchdog、钩子、退出码、socket）都是实现手段。
 *
 * 运行时靠文件传递真相（LLM 只声明意图，shell 命令负责确定性的动作）：
 *   /tmp/pi-sub-<name>/
 *     ├── brief.md    主会话启动前生成：任务目标 + 从主会话蒸馏出的背景 + 工具使用策略
 *     │               + 交付物要求 + 行为边界
 *     ├── result.md   子 agent 写的交付物。文件存在且退出码为 0，才算这次委派成功
 *     ├── exit        子 agent 的退出码，由 pane 里的 shell 写入：0 = 正常收尾；
 *     │               非 0 = 失败；文件不存在 = 进程被强杀或崩溃
 *     └── log         子 agent 的 stdout（wait 模式下批量运行 pi 的输出日志）
 *
 * 启动与收尾流程（全部用 tmux 自带功能，扩展本身不做额外魔法）：
 *   ① 用 tmux 新开一个后台 session 运行子 agent：
 *        TMUX= tmux -L pi-sub -e PI_WATCHDOG=… [-e PI_WATCHDOG_ON_STOP=…] new-session -d
 *        'pi "Read the brief at …" ; echo $? > exit'
 *      wait:false 时子 agent 用交互式 pi 启动，任务做完不会自己退出进程，所以额外注入
 *      ON_STOP 钩子：子 agent 调用 stop_watchdog 停止监控时，由扩展本地直接把退出码 0
 *      写进 exit 文件，再用 wait-for 发完成信号。这样不需要子 agent 再跑一轮 bash 命令
 *      （之前试过，遇到 API 429 故障时等待方会永久挂起，踩过坑）。
 *      wait:true 时子 agent 用 pi -p 非交互式运行：跑完这一个回合进程就退出，所以不需要
 *      ON_STOP 钩子，pi 退出本身就触发完成信号；提前发会和 shell 写 exit 文件产生竞态。
 *   ② 再注册一个 pane-died 钩子兜底：子 agent 进程异常退出（崩溃/被杀）时也发完成信号。
 *      等待方发现 exit 文件缺失，就能识别出这是异常终止。
 *   ③ 主会话用 tmux wait-for 阻塞等待完成信号（零 token 消耗），完成后 read result.md。
 *
 * 安装：文件位于 ~/.pi/agent/extensions/（自动发现），/reload 后生效。
 * 子 agent 自己也会加载本扩展，所以 spawn_sub 对子 agent 同样可用（未限制嵌套深度，
 * 谨慎 fan-out）。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SOCKET = "pi-sub";
/** wait 模式最长阻塞时间，超时后返回"仍在运行"而不是永久挂起 */
const MAX_WAIT_MS = 20 * 60 * 1000;

function kebab(s: string): string {
	return (
		s
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "task"
	);
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

/** 阻塞等待子 agent 的 wait-for 信号；abort/超时安全退出（不杀子 agent） */
function waitForSignal(done: string, signal: AbortSignal): Promise<"done" | "timeout" | "aborted"> {
	return new Promise((resolve) => {
		const proc = spawn("tmux", ["-L", SOCKET, "wait-for", done], {
			env: { ...process.env, TMUX: "" },
			stdio: "ignore",
		});
		let settled = false;
		const finish = (r: "done" | "timeout" | "aborted") => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			resolve(r);
		};
		const timer = setTimeout(() => {
			proc.kill("SIGKILL");
			finish("timeout");
		}, MAX_WAIT_MS);
		const onAbort = () => {
			proc.kill("SIGKILL");
			finish("aborted");
		};
		signal.addEventListener("abort", onAbort, { once: true });
		proc.on("close", (code) => finish(code === 0 ? "done" : "aborted"));
		proc.on("error", () => finish("aborted"));
	});
}

function buildBrief(
	question: string,
	context: string | undefined,
	artifactPath: string,
	done: string,
	wait: boolean,
): string {
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
${
	wait
		? "（本任务为 batch 模式：pi 进程退出时主会话侧会自动收到通知）"
		: "（stop_watchdog 即发信号；即使进程异常退出，启动器的 pane-died hook 也会代发信号，等待方以无产物/无退出码识别失败）"
}

## 边界
- 不要修改项目文件；临时产物一律放在 /tmp
- 不要再委派新子 agent（spawn_sub）：你自己在执行 brief，委派只属于主会话
- tmux 命令永远带 -L ${SOCKET}（专用 socket）；禁止对默认 tmux server 执行任何 kill 操作`;
}

interface LaunchResult {
	ok: boolean;
	/** 模型可读的完整说明（含运维速查或失败原因） */
	text: string;
	session?: string;
	artifactPath?: string;
	exitFile?: string;
	done?: string;
	logPath?: string;
}

async function launchSub(
	question: string,
	context: string | undefined,
	wait: boolean,
	signal: AbortSignal | undefined,
): Promise<LaunchResult> {
	if (!question.trim()) {
		return { ok: false, text: "缺少任务描述（question）。" };
	}
	const name = kebab(question);
	const session = name;
	const done = `${session}-done`;
	const dir = join("/tmp", `pi-sub-${name}`);
	const briefPath = join(dir, "brief.md");
	const artifactPath = join(dir, "result.md");
	const exitFile = join(dir, "exit");
	const logPath = join(dir, "log");

	// 同名会话已存在 → 不重复拉起，报告现状让用户决定
	const has = await runTmux(["has-session", "-t", session]);
	if (has.code === 0) {
		const ls = await runTmux(["ls"]);
		return {
			ok: false,
			text: `会话 ${session} 已存在，未重复启动。\n当前 ${SOCKET} socket 上的会话：\n${ls.stdout || ls.stderr}`,
		};
	}

	mkdirSync(dir, { recursive: true });
	writeFileSync(briefPath, buildBrief(question, context, artifactPath, done, wait), { mode: 0o600 });
	// 上次同名任务残留的退出码会污染本次成败判定，启动前清掉
	try {
		rmSync(exitFile, { force: true });
	} catch {
		/* ignore */
	}

	// 子 agent 的启动 prompt 只剩一个位置参数（普通 prompt 路径，交互与批处理模式都完整 await）。
	// 位置参数保证批处理模式完整等待回合结束（命令处理器里的 sendUserMessage 是
	// fire-and-forget，-p 模式会在后台回合开始前退出——已踩坑）。
	const briefTask = shQuote(`Read the brief at ${briefPath} and execute it fully.`);
	// 完成信号由 watchdog 的 PI_WATCHDOG_ON_STOP 钩子在 AI 调用 stop_watchdog 时发出
	//（不经 LLM 再跑一轮 bash，无 API 故障风险）；pane 进程异常退出（崩溃/被杀）时
	// 由 pane-died hook 兜底发信号。pane shell 在 pi 退出后把真实退出码写入 exit 文件；
	// pi 被信号硬杀时 shell 一并死掉，exit 缺失 → 等待方识别为异常终止。
	// pane 内不加 timeout：macOS 无此命令（GNU coreutils 专属，zsh: command not found，
	// exit 127 秒死——踩过）。挂死防护交给 watchdog 的 max 上限与人工围观。
	const inner = wait
		? `pi -p --no-session ${briefTask} > ${logPath} 2>&1; echo $? > ${exitFile}`
		: `pi ${briefTask}; echo $? > ${exitFile}`;

	// watchdog 经 tmux -e 注入会话环境：pane 里的 pi 能读到，不出现在启动命令字符串里。
	// interactive 模式额外注入完成钩子：AI 调用 stop_watchdog 停止监控时，由扩展本地经
	// sh -c 先把 0 写入 exit 文件（pi 此刻仍在运行，pane shell 要到会话结束才写退出码；
	// 先写 0 让等待方在信号时刻读到「正常完成」，不会把 exit 缺失误判为崩溃），
	// 再发完成信号。batch 模式 pi -p 退出即信号，不注入钩子：提前发信号会让等待方与
	// pane shell 的 exit 写入产生竞态。
	const envArgs = [
		"-e",
		"PI_SUBAGENT=1",
		"-e",
		"PI_WATCHDOG=timeout=5 max=50 mode=keep",
		...(wait ? [] : ["-e", `PI_WATCHDOG_ON_STOP=echo 0 > ${exitFile} && TMUX= tmux -L ${SOCKET} wait-for -S ${done}`]),
	];
	// 注意：-e 是 new-session 命令的参数，必须跟在 new-session 后面；
	// 放在 tmux 全局选项位置会报 "unknown option -- e"
	const launch = await runTmux(["new-session", ...envArgs, "-d", "-s", session, "-x", "220", "-y", "50", inner]);
	if (launch.code !== 0) {
		return { ok: false, text: `tmux 启动失败：${launch.stderr || launch.stdout}` };
	}

	// pane 进程退出（正常收尾/崩溃/被杀）时自动发完成信号——不依赖子 agent 的 LLM，
	// 主会话因此无需轮询即可感知失败。done 频道名经 kebab() 只含字母数字与连字符，
	// 单引号内联安全；hook 挂在 session 名上随 server 存活，同名会话复用同一 hook。
	const hook = await runTmux([
		"set-hook",
		"-t",
		session,
		"pane-died",
		`run-shell -b 'TMUX= tmux -L ${SOCKET} wait-for -S ${done}'`,
	]);
	if (hook.code !== 0 && wait) {
		// batch 模式的 brief 不要求 LLM 发信号，hook 缺失 = 信号无来源，必须回滚
		await runTmux(["kill-session", "-t", session]);
		return {
			ok: false,
			text: `注册 pane-died hook 失败（${(hook.stderr || hook.stdout).trim()}），已回收会话；完成信号无法保证送达，未启动子 agent。`,
		};
	}
	// 交互模式 hook 注册失败不回滚：brief 仍要求 LLM 完成时发信号，只是失去崩溃兜底

	if (wait) {
		const result = await waitForSignal(done, signal ?? new AbortController().signal);
		if (result === "done") {
			// exit 文件由 pane shell 在发信号之前写好（先写码 → pi 退出 → shell 退出 →
			// hook 触发），读到的是确定值；缺失即 pi 与 shell 一并被硬杀/崩溃
			const raw = (() => {
				try {
					return readFileSync(exitFile, "utf-8").trim();
				} catch {
					return "";
				}
			})();
			const code = /^\d+$/.test(raw) ? parseInt(raw, 10) : null;
			if (code === 0) {
				// 退出码 0 ≠ 成功：交付物缺失或 stdout 空（batch 模式必有最终总结）说明回合
				// 被静默截断（偶发，未复现，疑似 provider 侧），不能报「正常完成」让等待方
				// 去 read 一个不存在的文件
				const hasArtifact = existsSync(artifactPath);
				const logEmpty = (() => {
					try {
						return readFileSync(logPath, "utf-8").trim().length === 0;
					} catch {
						return false; // 日志读不到不据此判异常
					}
				})();
				if (hasArtifact && !(wait && logEmpty)) {
					return {
						ok: true,
						text: `子 agent 已正常完成（exit 0）。交付物在 ${artifactPath}，需要结论时 read 该文件。（stdout 日志：${logPath}）`,
						session,
						artifactPath,
						exitFile,
						done,
						logPath,
					};
				}
				return {
					ok: false,
					text: [
						`子 agent 退出码为 0 但${hasArtifact ? " stdout 日志为空" : `未留下交付物 ${artifactPath}`}（异常终止：回合疑似被静默截断，退出码不可信）。`,
						`日志：${logPath}。排查后可重新 spawn_sub 重试。`,
					].join("\n"),
					session,
					artifactPath,
					exitFile,
					done,
					logPath,
				};
			}
			if (code === null) {
				return {
					ok: true,
					text: `子 agent 进程已结束但未留下退出码（被强杀或崩溃，非正常收尾）。交付物可能缺失或不完整：${artifactPath}；日志：${logPath}。`,
					session,
					artifactPath,
					exitFile,
					done,
					logPath,
				};
			}
			// 124/137 = pi 进程被外部 SIGKILL/SIGTERM 硬杀（如用户手动 kill；pane 内无 timeout 命令，
			// macOS 没有 GNU coreutils）。exit 文件有值说明 pane shell 存活到了 pi 退出，仍算有结论可看
			if (code === 124 || code === 137) {
				return {
					ok: true,
					text: `子 agent 进程被外部硬杀（exit ${code}，如手动 kill）。看 log 尾部定位卡点：${logPath}；交付物可能不完整：${artifactPath}。`,
					session,
					artifactPath,
					exitFile,
					done,
					logPath,
				};
			}
			return {
				ok: true,
				text: `子 agent 失败退出（exit ${code}）。日志：${logPath}。排查后可重新 spawn_sub。`,
				session,
				artifactPath,
				exitFile,
				done,
				logPath,
			};
		}
		if (result === "timeout") {
			return {
				ok: true,
				text: `等待超过 ${MAX_WAIT_MS / 60000} 分钟仍未完成，子 agent 仍在 tmux 会话 ${session} 中运行。可稍后用 bash 执行 tmux -L ${SOCKET} wait-for ${done} 继续等，或 read 交付物文件看已有进展。`,
				session,
				artifactPath,
				exitFile,
				done,
				logPath,
			};
		}
		return {
			ok: true,
			text: `等待被中止，但子 agent 仍在后台运行（tmux 会话 ${session}）。可稍后 tmux -L ${SOCKET} wait-for ${done} 继续等。`,
			session,
			artifactPath,
			exitFile,
			done,
			logPath,
		};
	}

	// 常用运维命令（用户可直接复制到终端粘贴执行）
	const ops = opsCheatsheet(session, artifactPath, exitFile, done);

	const mainAgentNote = [
		"给主会话模型的说明：不要轮询进度。需要结论时在 bash 执行 " +
			`tmux -L ${SOCKET} wait-for ${done}` +
			"（阻塞等待，零 token；子 agent 完成发信号或进程退出时 hook 自动发信号），",
		`返回后 read ${artifactPath}。同目录 exit 文件为 0 = 正常收尾；非 0 或缺失 = 失败/异常终止。`,
	].join("");

	return {
		ok: true,
		text: [
			`已启动子 agent（交付物：${artifactPath}）`,
			"",
			"常用操作（在任意终端直接复制粘贴）：",
			"```bash",
			ops,
			"```",
			mainAgentNote,
		].join("\n"),
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
			"With spawn_sub wait:true (default false), the call blocks up to 20 minutes until the deliverable at /tmp/pi-sub-<name>/result.md is ready; with wait:false, poll later via the returned wait-for command instead of guessing progress.",
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
			wait: Type.Optional(
				Type.Boolean({
					description:
						"true = block until the sub-agent finishes (up to 20 minutes); default false = return immediately, read the deliverable later",
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			return {
				content: [
					{ type: "text", text: (await launchSub(params.question, params.context, params.wait ?? false, signal)).text },
				],
				details: {},
			};
		},
	});
}
