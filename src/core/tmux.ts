/**
 * tmux 子进程原语：专用 socket 上的命令执行与 shell 引用包装。
 * core/ 是依赖链的最底层：不依赖项目内其他模块，其他一切依赖 core/。
 */
import { spawn } from "node:child_process";

/** 专用 tmux socket：子 agent 的所有会话都跑在这上面，与用户自己的 tmux server 隔离 */
export const SOCKET = "pi-sub";

/** shell 单引号安全包装：内联进 tmux run-shell 等命令串时防注入/断词 */
export function shQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 通用进程运行器：收集 stdout/stderr。onSpawn 可拿到子进程引用（用于超时后 kill，如 wait-for 客户端） */
export function run(
	cmd: string,
	args: string[],
	onSpawn?: (proc: import("node:child_process").ChildProcess) => void,
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const proc = spawn(cmd, args, {
			env: { ...process.env, TMUX: "" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		onSpawn?.(proc);
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		const readOutput = () => ({
			stdout: Buffer.concat(stdout).toString(),
			stderr: Buffer.concat(stderr).toString(),
		});
		proc.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		proc.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		proc.on("close", (code) => resolve({ code: code ?? 1, ...readOutput() }));
		proc.on("error", (err) => {
			const output = readOutput();
			resolve({ code: 1, ...output, stderr: output.stderr || String(err) });
		});
	});
}

/** 运行 tmux 命令。TMUX= 清空避免嵌套告警（等价 shell 里的 TMUX= 前缀）。 */
export function runTmux(
	args: string[],
	onSpawn?: (proc: import("node:child_process").ChildProcess) => void,
): Promise<{ code: number; stdout: string; stderr: string }> {
	return run("tmux", ["-L", SOCKET, ...args], onSpawn);
}

/**
 * 列出当前主会话所属的存活子 agent 会话。
 *
 * pi-sub 是跨主会话共享的专用 socket，因此不能把 list-sessions 的结果直接
 * 当成当前对话的子 agent。启动时会把主会话 ID写入 tmux session option，
 * 这里用同一字段过滤；没有归属标记的旧会话也不会误显示。
 */
export async function listSubagentSessions(parentSessionId: string): Promise<string[]> {
	if (!parentSessionId) return [];
	const r = await runTmux(["list-sessions", "-F", "#{session_name}\t#{@pi-sub-parent-session}"]);
	if (r.code !== 0) return [];
	return r.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			// owner 恒为格式串的最后一个字段；session 名若含 tab，其余段要 join 回去，
			// 否则 owner 会取到名字碎片，该会话会被永久漏掉。
			const parts = line.split("\t");
			const owner = parts.pop();
			return { session: parts.join("\t").trim(), owner };
		})
		.filter(({ owner }) => owner === parentSessionId)
		.map(({ session }) => session)
		.filter(Boolean);
}

/**
 * 抓取某个会话 pane 的当前可见屏幕。`-p` 输出纯文本（不带 ANSI 属性），
 * 与人工 `tmux -L pi-sub attach` 看到的是同一屏。会话已结束时 code !== 0。
 * /attach 的选择列表用它取每个会话的最后一行作预览。
 */
export function captureSubagentPane(session: string): Promise<{ code: number; stdout: string; stderr: string }> {
	return runTmux(["capture-pane", "-p", "-t", session]);
}

/** tmux 键名（C-b / M-a / F12 / C-M-x）→ 人类可读文案（Ctrl-b / Alt-a / F12 / Ctrl-Alt-x）。 */
export function formatPrefixKey(raw: string): string {
	let s = raw.trim();
	if (!s) return "Ctrl-b";
	const mods: string[] = [];
	for (;;) {
		if (s.startsWith("C-")) {
			mods.push("Ctrl");
			s = s.slice(2);
		} else if (s.startsWith("M-")) {
			mods.push("Alt");
			s = s.slice(2);
		} else if (s.startsWith("S-")) {
			mods.push("Shift");
			s = s.slice(2);
		} else break;
	}
	if (mods.length === 0) return s;
	return [...mods, s].join("-");
}

/**
 * pi-sub server 的前缀键可读文案（用户可自定义 prefix，默认 Ctrl-b）。
 * 子 agent 围观浮层里的退出提示用它，避免把 Ctrl-b 写死——用户改了 prefix 后提示会失真。
 * 用 -qv 取纯值（`show-options -g prefix` 的输出是 `prefix C-b` 两段，-v 只给 `C-b`）。
 */
export async function subagentPrefixHint(): Promise<string> {
	const r = await runTmux(["show-options", "-gqv", "prefix"]);
	return formatPrefixKey(r.code === 0 ? r.stdout : "");
}

/**
 * 给围观者一套一眼可辨的 tmux 外观：紫色 status 栏 +「子 agent 围观」标签 + 常驻退出提示，
 * 与用户自己的 tmux 明确区分（子会话继承用户 tmux.conf，默认长相和主 tmux 一模一样）。
 *
 * 只改 display：capture-pane 抓不到 status 行，不影响 captureSubagentPane / 主会话数据通路。
 * 纯装饰——任一 set-option 失败也只是「没有染色」，调用方应忽略返回值，绝不影响子 agent 启动。
 */
export async function styleSubagentSession(session: string): Promise<void> {
	const hint = await subagentPrefixHint();
	// status-* 是会话选项，window-status-* 是窗口选项（-w），故分两组
	const sessionOpts: Array<[string, string]> = [
		["status", "on"],
		["status-style", "bg=colour53,fg=colour231"],
		["status-left-length", "30"],
		["status-left", " #[bg=colour53,fg=colour231,bold] 子 agent 围观 "],
		["status-right-length", "40"],
		["status-right", ` #[bg=colour213,fg=colour16,bold] 浮层内 ${hint} d 退出 `],
		["window-status-separator", "#[bg=colour53,fg=colour240]│"],
	];
	const windowOpts: Array<[string, string]> = [
		["window-status-style", "bg=colour53,fg=colour245"],
		["window-status-current-style", "bg=colour213,fg=colour16,bold"],
		["window-status-format", " #[fg=colour245]#W "],
		["window-status-current-format", " #[fg=colour16,bold]#W "],
	];
	const args: string[] = [];
	const push = (extra: string[], opt: string, value: string) => {
		if (args.length > 0) args.push(";");
		args.push("set-option", ...extra, "-t", session, opt, value);
	};
	for (const [opt, value] of sessionOpts) push([], opt, value);
	for (const [opt, value] of windowOpts) push(["-w"], opt, value);
	await runTmux(args);
}
