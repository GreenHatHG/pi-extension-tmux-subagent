/**
 * Main-session shell call to `pi-vcc compact`: pre-generates the main session's compressed summary
 * for advisor. compact only writes to stdout, so this module redirects it to disk with the shell;
 * we don't use --write (that would modify the main session jsonl). Optional boost before advisor
 * starts: any failure returns ok:false, nothing blocks, and the brief falls back.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { shQuote } from "../core/tmux";

const execAsync = promisify(exec);

export interface VccSummary {
	/** Absolute path to the summary file (only meaningful when ok). */
	path: string;
	ok: boolean;
	/** Reason when ok=false (used by the brief's fallback text). */
	error?: string;
}

/** compact is a synchronous delay on the launch path, so give it a generous cap. */
const COMPACT_TIMEOUT_MS = 180_000;
/** 32MB cap in case the compact output blows up unexpectedly. */
const COMPACT_MAX_BUFFER = 32 * 1024 * 1024;

export async function runVccCompact(vccCli: string, sessionFile: string, outPath: string): Promise<VccSummary> {
	const cmd = `${vccCli} compact ${shQuote(sessionFile)} > ${shQuote(outPath)}`;
	try {
		await execAsync(cmd, { timeout: COMPACT_TIMEOUT_MS, maxBuffer: COMPACT_MAX_BUFFER });
		return { path: outPath, ok: true };
	} catch (e) {
		const err = e as { stderr?: string; message?: string; killed?: boolean };
		const reason = err.killed
			? `compact timed out (>${COMPACT_TIMEOUT_MS / 1000}s)`
			: (err.stderr?.trim() || err.message || "unknown error").split("\n")[0];
		return { path: outPath, ok: false, error: reason };
	}
}
