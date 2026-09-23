/**
 * 子 agent 的会话命名与 /tmp 运行目录布局。
 */
import { randomInt } from "node:crypto";
import { join } from "node:path";

export function kebab(s: string): string {
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
export function shortId(): string {
	let id = "";
	for (let i = 0; i < 4; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
	return id;
}

/** 子 agent 的会话名与运行时文件布局：/tmp/pi-sub-<session>/ 下 brief、交付物、exit、log */
export interface SubagentPaths {
	/** tmux 会话名（kebab 化任务名 + 随机后缀），也是 done 频道与运行目录的前缀 */
	session: string;
	/** wait-for 完成信号频道名 */
	done: string;
	dir: string;
	briefPath: string;
	artifactPath: string;
	exitFile: string;
	logPath: string;
}

export function resolvePaths(session: string): SubagentPaths {
	const dir = join("/tmp", `pi-sub-${session}`);
	return {
		session,
		done: `${session}-done`,
		dir,
		briefPath: join(dir, "brief.md"),
		artifactPath: join(dir, "result.md"),
		exitFile: join(dir, "exit"),
		logPath: join(dir, "log"),
	};
}
