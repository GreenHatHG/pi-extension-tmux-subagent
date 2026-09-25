/**
 * pi-vcc compact 的主会话侧 shell 调用：为 advisor 预生成主会话的压缩摘要。
 *
 * pi-vcc CLI 的 compact 子命令只输出到 stdout（无输出文件参数；--write 是往主会话
 * jsonl 追加 compaction entry，不是写摘要文件，且会改动会话文件——不用）。落盘由
 * 本模块用 shell 重定向完成：`<vccCli> compact <sessionFile> > <outPath>`。
 *
 * 定位：advisor 启动前的可选增强。任何失败（bun 缺失、消息太少、超时）都返回
 * ok:false 而不抛——compact 失败绝不能阻塞 advisor 启动，简报里降级声明即可。
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { shQuote } from "../core/tmux";

const execAsync = promisify(exec);

export interface VccSummary {
	/** 摘要文件的绝对路径（ok 时才有意义） */
	path: string;
	ok: boolean;
	/** ok=false 时的原因（简报降级文案用） */
	error?: string;
}

/** compact 是启动路径上的同步延迟：给足上限但必须兜底 */
const COMPACT_TIMEOUT_MS = 180_000;
/** compact 产物是压缩摘要，通常几 KB～几十 KB；32MB 是防炸缓冲 */
const COMPACT_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * 跑 `<vccCli> compact <sessionFile>` 并把 stdout 重定向落盘到 outPath。
 * 不用 --write（不碰主会话 jsonl，纯只读 stdout）。
 */
export async function runVccCompact(vccCli: string, sessionFile: string, outPath: string): Promise<VccSummary> {
	const cmd = `${vccCli} compact ${shQuote(sessionFile)} > ${shQuote(outPath)}`;
	try {
		await execAsync(cmd, { timeout: COMPACT_TIMEOUT_MS, maxBuffer: COMPACT_MAX_BUFFER });
		return { path: outPath, ok: true };
	} catch (e) {
		const err = e as { stderr?: string; message?: string; killed?: boolean };
		const reason = err.killed
			? `compact 超时（>${COMPACT_TIMEOUT_MS / 1000}s）`
			: (err.stderr?.trim() || err.message || "未知错误").split("\n")[0];
		return { path: outPath, ok: false, error: reason };
	}
}
