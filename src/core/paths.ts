/**
 * Names and run-dir layout for sub-agents (under /tmp). Lowest layer in core/, no project deps.
 */
import { randomInt } from "node:crypto";
import { join } from "node:path";

/** Task name -> session name: keep only lowercase letters, digits and dashes, max 40 chars. */
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

/** 4 random chars so parallel tasks never share a session/channel/dir name. */
export function shortId(): string {
	return Array.from({ length: 4 }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join("");
}

/** Session name and runtime file layout for one sub-agent. */
export interface SubagentPaths {
	/** tmux session name (kebab task name + random suffix). */
	session: string;
	/** wait-for channel for the done signal. */
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
