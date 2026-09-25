/**
 * 完成协议：子 agent 两条收尾路径（watchdog 交互式 / pi -p 批处理回退）的差异收敛，
 * 以及主会话侧感知完成所依赖的 tmux hook 与命令链。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ENV_SUB_DONE, ENV_SUB_EXIT_FILE, ENV_SUBAGENT } from "../core/env";
import type { SubagentPaths } from "../core/paths";
import { runTmux, SOCKET, shQuote } from "../core/tmux";

/**
 * watchdog 收尾路径是否可用：/watchdog 命令由 pi-watchdog 无条件注册，代表扩展已
 * 加载（是否运行无关紧要——子 agent 的开启由本扩展注入 PI_WATCHDOG 决定，加载即
 * 开启）。主会话与子 agent 共享同一份扩展配置（全局 packages + 同 cwd），主会话
 * 探测到 = 子 agent 里也有。探测放在 spawn/advisor 调用时而非扩展加载时：加载期
 * 各扩展的注册时序不保证。按 source === "extension" 匹配，避免同名 skill/prompt
 * 模板误判。未加载时回退 pi -p 批处理路径（见 resolveCompletion 的说明）。
 */
export function isWatchdogAvailable(pi: ExtensionAPI): boolean {
	return pi.getCommands().some((c) => c.name === "watchdog" && c.source === "extension");
}

/**
 * 收尾路径画像：把 launchSub 里所有按 watchdog 是否加载而分支的差异点收敛成一份
 * 记录，launchSub 主体只读字段、不再散布三元判断。
 *
 * 完成协议按 watchdog 是否加载分两路：
 * - watchdog 路径（默认）：交互式 pi + mode=keep 常驻监控。AI 调用 stop_watchdog
 *   停止监控时，由 ON_STOP 钩子（不经 LLM 再跑一轮 bash，无 API 故障风险）先把 0
 *   写入 exit 文件（pi 此刻仍在运行，先写 0 让等待方在信号时刻读到「正常完成」，
 *   不会把 exit 缺失误判为崩溃），发完成信号，然后关闭 tmux 会话：pi 收到 SIGHUP
 *   走优雅退出；pane shell 与 pi 同进程组、默认死于 SIGHUP，抢不到机会把真实
 *   退出码写进 exit 覆盖预写的 0（且 pi 优雅退出码本就是 0，双保险）。sleep 0.3
 *   给 pi 收尾余量；即使 ON_STOP 中途失败，pane-died hook 仍兜底发信号。
 * - pi -p 回退（watchdog 未加载，如未安装/被禁用）：跑完一个回合进程即退出，
 *   真实退出码由 pane shell 写入 exit 文件，输出重定向到 log；不注入 watchdog
 *   环境变量。pi 会话默认保存（不加 --no-session），pane 命令链结束后会话随
 *   之自动关闭，回看执行过程读会话 jsonl。pane 内不加 timeout：macOS 无此命令
 *   （GNU coreutils 专属，exit 127 秒死——踩过）。挂死防护交给人工围观。
 * 两条路都靠 pane-died hook 兜底：崩溃/被杀时信号照发，exit 缺失 → 等待方
 * 识别为异常终止。主进程不等待：new-session -d 创建会话即返回；等待发生在
 * 后台 pane 内，主进程靠 wait-for done 事件驱动感知完成，再读 exit 判成败。
 */
export interface CompletionProfile {
	/** "watchdog" = 交互式 pi + stop_watchdog 收尾；"batch" = pi -p 批处理回退 */
	kind: "watchdog" | "batch";
	/** pi 启动命令前缀（不含 flags 与任务 prompt）：交互式为 "pi"，批处理为 "pi -p" */
	piCommandPrefix: "pi" | "pi -p";
	/** 追加在任务 prompt 之后的输出重定向（批处理 stdout+stderr → log；交互式仅 stderr → log，stdout 留在 pane） */
	outputRedirect: string;
	/** watchdog 专属的 tmux -e 环境注入（已插值；批处理路径为空数组） */
	extraEnvArgs: string[];
	/** pane-died hook 注册失败时是否回收会话并按失败返回（批处理唯一信号来源是该 hook，必须回滚） */
	rollbackOnHookFailure: boolean;
	/** exit 文件判读说明（进 LLM 上下文） */
	exitNote: string;
}

export function resolveCompletion(useWatchdog: boolean, paths: SubagentPaths): CompletionProfile {
	if (useWatchdog) {
		return {
			kind: "watchdog",
			piCommandPrefix: "pi",
			// stderr 落盘：交互式 pi 的 stdout 必须留在 pane（用户围观），但启动期报错
			// （如 --model 配置错、扩展加载失败）走 stderr 且进程立即退出，不留栈就没了
			// ——表现为 exit=1 + 空回复 entry，根因无处可查。重定向 stderr 不影响 TUI。
			outputRedirect: ` 2> ${paths.logPath}`,
			extraEnvArgs: [
				"-e",
				"PI_WATCHDOG=timeout=5 max=50 mode=keep",
				// ON_STOP 钩子是一条完整 shell 命令链：写 0 → 发完成信号 → 稍候关会话
				"-e",
				`PI_WATCHDOG_ON_STOP=echo 0 > ${paths.exitFile} && TMUX= tmux -L ${SOCKET} wait-for -S ${paths.done} && sleep 0.3 && TMUX= tmux -L ${SOCKET} kill-session -t ${paths.session}`,
			],
			rollbackOnHookFailure: false,
			exitNote: "exit 文件为 0 = 正常收尾；非 0 或缺失 = 失败/异常终止。",
		};
	}
	return {
		kind: "batch",
		piCommandPrefix: "pi -p",
		outputRedirect: ` > ${paths.logPath} 2>&1`,
		extraEnvArgs: [],
		rollbackOnHookFailure: true,
		exitNote: "子 agent 为 pi -p 批处理模式：exit 文件 0 = 成功，非 0 = 失败，缺失 = 崩溃/被杀。",
	};
}

/**
 * 两条收尾路径共用的 tmux -e 环境注入（watchdog 专属的见 resolveCompletion）。
 * 经 tmux -e 注入会话环境：pane 里的 pi 能读到，不出现在启动命令字符串里。
 */
export function baseEnvArgs(paths: SubagentPaths): string[] {
	return [
		// 两条路都注入：子 agent 内禁注册 spawn_sub（防嵌套）。
		"-e",
		`${ENV_SUBAGENT}=1`,
		// 两条路都注入：子 agent 自检失败时（watchdog 缺位）写 exit 并发完成信号，
		// 让等待方快速失败而不是静默挂死
		"-e",
		`${ENV_SUB_EXIT_FILE}=${paths.exitFile}`,
		"-e",
		`${ENV_SUB_DONE}=${paths.done}`,
	];
}

/**
 * pane 内执行的完整命令链。子 agent 的启动 prompt 只剩一个位置参数（普通 prompt
 * 路径，完整 await）；位置参数保证 -p 模式完整等待回合结束（命令处理器里的
 * sendUserMessage 是 fire-and-forget，-p 会在后台回合开始前退出——已踩坑）。
 */
export function buildPaneCommand(completion: CompletionProfile, flags: string[], paths: SubagentPaths): string {
	const briefTask = shQuote(`Read the brief at ${paths.briefPath} and execute it fully.`);
	const piCommand = `${completion.piCommandPrefix} ${flags.join(" ")} ${briefTask}${completion.outputRedirect}`;
	return `${piCommand}; echo $? > ${paths.exitFile}`;
}

/**
 * pane 进程退出（正常收尾/崩溃/被杀）时自动发完成信号——不依赖子 agent 的 LLM，
 * 主会话因此无需轮询即可感知失败。会话名含随机后缀，并发任务各占独立 done 频道，
 * 不会互相串信号；done 频道名只含字母数字与连字符，单引号内联安全。
 * 返回失败原因（已 trim），注册成功返回 undefined。
 */
export async function registerPaneDiedHook(paths: SubagentPaths): Promise<string | undefined> {
	const hook = await runTmux([
		"set-hook",
		"-t",
		paths.session,
		"pane-died",
		`run-shell -b 'TMUX= tmux -L ${SOCKET} wait-for -S ${paths.done}'`,
	]);
	if (hook.code === 0) return undefined;
	return (hook.stderr || hook.stdout).trim();
}
