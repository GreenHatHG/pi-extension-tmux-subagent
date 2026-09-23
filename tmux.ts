/**
 * tmux 子进程原语：专用 socket 上的命令执行与 shell 引用包装。
 * 本模块不依赖项目内其他模块，是依赖链的最底层。
 */
import { spawn } from "node:child_process";

/** 专用 tmux socket：子 agent 的所有会话都跑在这上面，与用户自己的 tmux server 隔离 */
export const SOCKET = "pi-sub";

/** shell 单引号安全包装：内联进 tmux run-shell 等命令串时防注入/断词 */
export function shQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 通用进程运行器：收集 stdout/stderr */
export function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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
export function runTmux(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return run("tmux", ["-L", SOCKET, ...args]);
}
