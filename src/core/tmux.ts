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
 * 列出 pi-sub socket 上所有存活会话名（只读镜像面板用，tmux 是唯一真相源：
 * 存活会话 = 正在运行的子 agent）。server 未起 / 无会话时返回空数组。
 */
export async function listSubagentSessions(): Promise<string[]> {
	const r = await runTmux(["list-sessions", "-F", "#{session_name}"]);
	if (r.code !== 0) return [];
	return r.stdout
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * 抓取某个会话 pane 的当前可见屏幕。`-p` 输出纯文本（不带 ANSI 属性），
 * 与人工 `tmux -L pi-sub attach` 看到的是同一屏。会话已结束时 code !== 0。
 */
export function captureSubagentPane(session: string): Promise<{ code: number; stdout: string; stderr: string }> {
	return runTmux(["capture-pane", "-p", "-t", session]);
}
