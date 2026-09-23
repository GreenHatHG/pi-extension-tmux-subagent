/**
 * 子 agent 启动编排：探测完成路径 → 准备简报与运行目录 → tmux 拉起 pane →
 * 注册完成信号 hook → 组装主会话侧的返回与运维文案。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { advisorPresetFlags, buildAdvisorBrief } from "./advisor";
import { buildBrief } from "./brief";
import {
	baseEnvArgs,
	buildPaneCommand,
	type CompletionProfile,
	isWatchdogAvailable,
	registerPaneDiedHook,
	resolveCompletion,
} from "./completion";
import { kebab, resolvePaths, type SubagentPaths, shortId } from "./paths";
import { runTmux, SOCKET } from "./tmux";

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
	return `需要结论时在 bash 执行 tmux -L ${SOCKET} wait-for ${paths.done}，必须用 bash 的 timeout 参数限时（建议 600s，阻塞等待零 token）。timeout 命中后重发本命令继续等即可（tmux 会记住已发的信号，不会永久阻塞）。若连续 2-3 次 timeout 且 \`TMUX= tmux -L ${SOCKET} has-session -t ${paths.session}\` 显示会话仍在：执行 \`tmux -L ${SOCKET} capture-pane -t ${paths.session} -p | tail -30\` 看现场——子 agent 可能没调 stop_watchdog 或已挂死，酌情继续等、kill-session 后按失败处理。返回后 read ${paths.artifactPath}。${exitNote}`;
}

/** 启动成功的结果组装：速查表只给用户（放 details，经 renderResult 渲染，不进 LLM 上下文），等待说明进 LLM 上下文 */
function startedResult(paths: SubagentPaths, completion: CompletionProfile): LaunchResult {
	return {
		ok: true,
		text: `已启动子 agent（交付物：${paths.artifactPath}）。${buildMainAgentNote(paths, completion.exitNote)}`,
		ops: opsCheatsheet(paths.session, paths.artifactPath, paths.exitFile, paths.done),
		session: paths.session,
		artifactPath: paths.artifactPath,
		exitFile: paths.exitFile,
		done: paths.done,
		logPath: paths.logPath,
	};
}

export interface LaunchOpts {
	/** "advisor" 用咨询简报模板 + 限制工具集 + 换系统提示词；缺省 = 任务模式 */
	mode?: "advisor";
	/**
	 * 追加到预设之后的子 agent pi CLI 参数（已 shQuote）。pi 的单值 flag
	 * （--model/--tools/--system-prompt）是后值覆盖前值，可覆盖模式预设。
	 */
	extraArgs?: string[];
}

export interface LaunchResult {
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

/**
 * 启动一个隔离的 pi 子 agent：默认任务模式；mode: "advisor" 时用咨询简报模板 +
 * 限制工具集 + 换系统提示词（额外 flag 由调用方经 extraArgs 注入，如 --model 预设，
 * 见 index.ts 的 advisor 接线）。
 */
export async function launchSub(
	pi: ExtensionAPI,
	question: string,
	context: string | undefined,
	opts?: LaunchOpts,
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

	const brief =
		opts?.mode === "advisor"
			? buildAdvisorBrief(question, context, paths.artifactPath, useWatchdog)
			: buildBrief(question, context, paths.artifactPath, useWatchdog);
	prepareRunDir(paths, brief);

	// 模式预设 flag 在前（advisor 模式限制工具集、换 advisor 人格提示词，见 advisor.ts
	// 的 advisorPresetFlags），调用方的 extraArgs 在后：pi 的参数解析对
	// --model/--tools/--system-prompt 这类单值 flag 是后值覆盖前值，后者可覆盖前者的同名 flag。
	const flags: string[] = [
		...(opts?.mode === "advisor" ? advisorPresetFlags(useWatchdog) : []),
		...(opts?.extraArgs ?? []),
	];

	// 注意：-e 是 new-session 命令的参数，必须跟在 new-session 后面；
	// 放在 tmux 全局选项位置会报 "unknown option -- e"
	const launch = await runTmux([
		"new-session",
		...baseEnvArgs(paths),
		...completion.extraEnvArgs,
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

	return startedResult(paths, completion);
}
