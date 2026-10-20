/**
 * Sub-agent flight recorder (diagnostic, env-gated). When PI_SUBAGENT_DEBUG points at a log file,
 * every process-death event is appended there synchronously (appendFileSync), so the "why" of a
 * mysterious exit survives: the three graceful paths (signal, user quit, empty event loop) are
 * otherwise indistinguishable in the artifacts a dead sub-agent leaves behind (exit=0, empty
 * stderr, session jsonl ending at a toolUse batch).
 *
 * Wait — "user quit" can't happen here: sub-agent panes run headless (no /quit keystrokes reach
 * pi, and Ctrl+C in an attached popup is explicitly not a quit). The real suspects are external
 * signals and empty-loop exits, both exit 0, both silent.
 *
 * Sync writes matter: a dying process gets no more event-loop turns after "exit", so an async
 * append would be lost. The signal handlers use prependListener so they run BEFORE pi's own
 * handlers (pi gracefully exits on SIGTERM/SIGHUP — that's the suspect path — and would swallow
 * the signal otherwise).
 *
 * Off by default: no env var, no listeners, zero overhead (a real sub-agent only).
 */
import { appendFileSync } from "node:fs";
import { ENV_SUB_DEBUG } from "./env";

/** Log file path from the env var; undefined when unset/empty (recorder off). */
function logPath(): string | undefined {
	const p = process.env[ENV_SUB_DEBUG]?.trim();
	return p || undefined;
}

/** One line per event, synchronous so it survives a dying process. */
function record(line: string): void {
	const path = logPath();
	if (!path) return;
	try {
		appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
	} catch {
		/* diagnostics must never break the sub-agent */
	}
}

/**
 * Install the recorder. Registered only when PI_SUBAGENT_DEBUG is set — i.e. inside sub-agent
 * panes whose launch injected it (baseEnvArgs). Safe to call anywhere in the extension factory.
 */
export function setupFlightRecorder(): void {
	const path = logPath();
	if (!path) return;

	// External signals: the #1 suspect for silent exit=0 deaths. prepend = run before pi's own
	// SIGTERM/SIGHUP graceful-shutdown handler, which would otherwise exit(0) with no trace.
	// Registering a listener cancels the default terminate-on-signal behavior, so if no other
	// handler exits (pi missing/already dead), the process would hang forever — force the
	// default outcome ourselves, one macrotask later so earlier-prepended handlers run first.
	for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
		process.prependListener(signal, () => {
			record(`signal ${signal} received`);
			// Our listener is prepended (runs FIRST); pi's handler, if any, is registered after
			// ours, so it runs later in the same dispatch and will exit(0) itself. Only exit here
			// if nobody else will: setTimeout(0) runs after all other listeners of this dispatch.
			setTimeout(() => {
				record(`no handler terminated the process after ${signal}; exiting with the default code`);
				process.exit(process.exitCode ?? (signal === "SIGINT" ? 130 : 143));
			}, 0);
		});
	}

	// Normal/batch exit: last thing that runs. reason="normal" with no signal line above it in the
	// log = the event loop drained on its own (or pi quit by itself) — the other graceful path.
	process.on("exit", (code) => {
		record(`process exit code=${code}`);
	});

	// Crash paths, for completeness: these write exit=1/129 (not the confusing 0), but the log
	// line tells the why immediately instead of requiring a jsonl dig.
	process.on("uncaughtException", (err) => {
		record(`uncaughtException: ${err?.message ?? err}`);
	});
	process.on("unhandledRejection", (reason) => {
		record(`unhandledRejection: ${reason}`);
	});

	// Startup marker: distinguishes "recorder was on" from "log missing for other reasons".
	record("recorder installed");
}
