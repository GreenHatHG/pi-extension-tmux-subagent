/**
 * 子 agent 启动编排：探测完成路径 → 选模式（SubagentMode）→ 准备简报与运行目录 →
 * tmux 拉起 pane → 注册完成信号 hook → 组装主会话侧的返回与运维文案。
 *
 * 主体不出现任何按模式 if-else：brief/presetFlags/extraEnvArgs 全部来自 SubagentMode
 * （modes/types.ts），收尾协议差异全部来自 CompletionProfile（completion/profile.ts）。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	baseEnvArgs,
	buildPaneCommand,
	type CompletionProfile,
	isWatchdogAvailable,
	registerPaneDiedHook,
	resolveCompletion,
} from "../completion/profile";
import { kebab, resolvePaths, type SubagentPaths, shortId } from "../core/paths";
import { runTmux, SOCKET } from "../core/tmux";
import { type SubagentMode, taskMode } from "../modes/types";
import { runVccCompact, type VccSummary } from "../modes/vcc";

/**
 * 同名会话兜底检查：会话名带随机后缀，正常情况下不会命中；兜底场景仍不重复拉起，
 * 报告现状让用户决定。返回错误文案（命中）；undefined = 可以启动。
 */
async function existingSessionReport(session: string): Promise<string | undefined> {
	const has = await runTmux(["has-session", "-t", session]);
	if (has.code !== 0) return undefined;
	const ls = await runTmux(["ls"]);
	return `会话 ${session} 已存在，未重复启动。\n当前 ${SOCKET} socket 上的会话：\n${ls.stdout || ls.stderr}`;
}

/**
 * 建运行目录并写简报（权限仅属主可读）。上次同名任务残留的退出码会污染本次成败
 * 判定，启动前清掉。
 */
function prepareRunDir(paths: SubagentPaths, brief: string): void {
	mkdirSync(paths.dir, { recursive: true });
	writeFileSync(paths.briefPath, brief, { mode: 0o600 });
	try {
		rmSync(paths.exitFile, { force: true });
	} catch {
		/* ignore */
	}
}

/**
 * 给主会话 LLM 的等待/读取结论说明。等待命令带 timeout 防挂死；timeout 命中后
 * 重发即可（信号会被记住，见 wait-for 语义）；连续多次 timeout 且会话仍在时
 * capture-pane 看现场，有界重试——覆盖「LLM 忘调 stop_watchdog / watchdog max
 * 催促耗尽 / watchdog 未接管」等信号永不来的场景。
 *
 * wait-for 语义（实测 0.85.1 自带 tmux）：-S 发出的信号会被 server 记住，稍后的
 * wait-for 立即返回，不存在「信号在等待空窗期被丢弃后重发永久阻塞」的问题。
 * timeout 命中后可以直接重发 wait-for 继续等。但等待必须有界：信号可能根本不会来
 * （子 agent LLM 未调 stop_watchdog、watchdog max 催促耗尽后直接 teardown 不发
 * ON_STOP、watchdog 未接管等），连续多次 timeout 且会话仍在时 capture-pane 看现场
 * 再决定等还是处置——等待方挂起比等待方超时更糟。
 */
function buildMainAgentNote(paths: SubagentPaths, exitNote: string): string {
	return `需要结论时在 bash 执行 tmux -L ${SOCKET} wait-for ${paths.done}。等待必须有限制：用 bash 工具自带的 timeout 参数限时（建议 600s；是工具调用的参数，不要在命令里加 shell 的 timeout 前缀）。阻塞等待零 token。timeout 命中后重发本命令继续等即可（tmux 会记住已发的信号，不会永久阻塞）。若连续 2-3 次 timeout 且 \`TMUX= tmux -L ${SOCKET} has-session -t ${paths.session}\` 显示会话仍在：执行 \`tmux -L ${SOCKET} capture-pane -t ${paths.session} -p | tail -30\` 看现场——子 agent 可能没调 stop_watchdog 或已挂死，酌情继续等、kill-session 后按失败处理。返回后 read ${paths.artifactPath}。若 exit 非 0 或回复为空，read ${paths.logPath} 看子 agent 的 stderr 找根因。${exitNote}`;
}

export interface LaunchResult {
	ok: boolean;
	/** 给主会话模型的说明（进入 LLM 上下文；应尽量短） */
	text: string;
	/** 给用户的运维速查（只在 TUI 渲染，不进 LLM 上下文） */
	ops?: string;
	/** 简报原文（advisor 模式下 appendEntry 打进 TUI，不进 LLM 上下文） */
	brief?: string;
	session?: string;
	artifactPath?: string;
	exitFile?: string;
	done?: string;
	logPath?: string;
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

/** 启动成功的结果组装：速查表只给用户（放 details，经 renderResult 渲染，不进 LLM 上下文），等待说明进 LLM 上下文 */
function startedResult(paths: SubagentPaths, completion: CompletionProfile, brief: string): LaunchResult {
	return {
		ok: true,
		text: `已启动子 agent（交付物：${paths.artifactPath}）。${buildMainAgentNote(paths, completion.exitNote)}`,
		ops: opsCheatsheet(paths.session, paths.artifactPath, paths.exitFile, paths.done),
		session: paths.session,
		artifactPath: paths.artifactPath,
		exitFile: paths.exitFile,
		done: paths.done,
		logPath: paths.logPath,
		brief,
	};
}

/**
 * 启动一个隔离的 pi 子 agent。默认任务模式（taskMode）：
 * - advisor 模式：咨询简报 + 限制工具集 + 换系统提示词（--model 预设由调用方经
 *   extraArgs 注入，见 tools/advisor.ts 的接线）
 * - web-research 模式：联网调研简报 + 预设 flag + 注入引导环境变量（子 agent 进程内
 *   动态激活 pi-web-access，见 session/web-bootstrap.ts）
 */
export async function launchSub(
	pi: ExtensionAPI,
	question: string,
	context: string | undefined,
	mode: SubagentMode = taskMode,
	extraArgs: string[] = [],
	opts?: {
		/** advisor 取证：主会话 jsonl 路径与 pi-vcc CLI 调用命令，透传给简报的取证栏目 */
		sessionFile?: string;
		vccCli?: string;
	},
): Promise<LaunchResult> {
	if (!question.trim()) {
		return { ok: false, text: "缺少任务描述（question）。" };
	}

	const useWatchdog = isWatchdogAvailable(pi);
	const paths = resolvePaths(`${kebab(question)}-${shortId()}`);
	const completion = resolveCompletion(useWatchdog, paths);

	const clash = await existingSessionReport(paths.session);
	if (clash) {
		return { ok: false, text: clash };
	}

	// advisor 取证第一级：vcc 压缩摘要预生成（目录先建；失败不阻塞，简报降级为 recall-only）
	let vccSummary: VccSummary | undefined;
	if (opts?.sessionFile && opts?.vccCli) {
		mkdirSync(paths.dir, { recursive: true });
		vccSummary = await runVccCompact(opts.vccCli, opts.sessionFile, join(paths.dir, "vcc-summary.md"));
	}

	const brief = mode.brief(question, context, paths.artifactPath, useWatchdog, {
		sessionFile: opts?.sessionFile,
		vccCli: opts?.vccCli,
		vccSummary,
	});
	prepareRunDir(paths, brief);

	// 模式预设 flag 在前（可被覆盖的单值 flag 见 SubagentMode.presetFlags 注释），
	// 调用方的 extraArgs 在后：pi 的参数解析对 --model/--tools/--system-prompt 这类
	// 单值 flag 是后值覆盖前值，后者可覆盖前者的同名 flag。
	const flags: string[] = [...mode.presetFlags(useWatchdog), ...extraArgs];

	// 注意：-e 是 new-session 命令的参数，必须跟在 new-session 后面；
	// 放在 tmux 全局选项位置会报 "unknown option -- e"
	const launch = await runTmux([
		"new-session",
		...baseEnvArgs(paths),
		...completion.extraEnvArgs,
		...mode.extraEnvArgs(),
		"-d",
		"-s",
		paths.session,
		"-x",
		"220",
		"-y",
		"50",
		buildPaneCommand(completion, flags, paths),
	]);
	if (launch.code !== 0) {
		return { ok: false, text: `tmux 启动失败：${launch.stderr || launch.stdout}` };
	}

	const hookError = await registerPaneDiedHook(paths);
	if (hookError) {
		if (completion.rollbackOnHookFailure) {
			// -p 回退唯一信号来源是 pane-died hook（brief 不要求 LLM 发信号），缺失必须回滚
			await runTmux(["kill-session", "-t", paths.session]);
			return {
				ok: false,
				text: `注册 pane-died hook 失败（${hookError}），已回收会话；完成信号无法保证送达，未启动子 agent。`,
			};
		}
		// watchdog 路径不回滚：ON_STOP 钩子仍会发信号，只是失去崩溃兜底
		return {
			ok: true,
			text: `已启动子 agent，但注册 pane-died hook 失败（${hookError}）：进程崩溃时不再自动发完成信号，需人工围观或超时排查。交付物：${paths.artifactPath}`,
			session: paths.session,
			artifactPath: paths.artifactPath,
			exitFile: paths.exitFile,
			done: paths.done,
			logPath: paths.logPath,
		};
	}

	return startedResult(paths, completion, brief);
}
