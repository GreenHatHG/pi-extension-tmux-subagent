/**
 * Tests for the sub-agent flight recorder: env-gated installation, signal capture ordering
 * (prepend = before pi's own graceful-shutdown handlers), and sync append to the log file.
 * Signals are delivered via child.kill() on a real subprocess, so the test exercises the real
 * dispatch rather than monkey-patched handlers.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let script: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "flyrec-"));
	// A real script file: the recorder module path is resolved relative to this test file, and
	// bun runs the file directly (no node-style -e flags needed).
	script = join(dir, "victim.ts");
	writeFileSync(
		script,
		`import { setupFlightRecorder } from "${import.meta.dir}/../src/core/flight-recorder.ts";
setupFlightRecorder();
setInterval(() => {}, 10_000);
`,
	);
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Run the victim script with PI_SUBAGENT_DEBUG set, signal it, wait for exit, return the log. */
function runAndSignal(log: string, signal: NodeJS.Signals, env: Record<string, string> = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		const child: ChildProcess = spawn("bun", [script], {
			env: { ...process.env, PI_SUBAGENT_DEBUG: log, ...env },
			stdio: "ignore",
		});
		setTimeout(() => child.kill(signal), 500);
		const deadline = Date.now() + 5000;
		const poll = setInterval(() => {
			if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
				clearInterval(poll);
				resolve(existsSync(log) ? readFileSync(log, "utf8") : "");
			}
		}, 100);
		child.on("error", reject);
	});
}

describe("flight recorder", () => {
	test("records an external SIGTERM; with no other handler, the fallback exits 143", async () => {
		// Bare process (no pi): our listener is the only one, so the recorded fallback must fire
		// — otherwise registering a handler would cancel the default terminate and hang forever.
		const log = await runAndSignal(join(dir, "sigterm.log"), "SIGTERM");
		expect(log).toContain("recorder installed");
		expect(log).toContain("signal SIGTERM received");
		expect(log).toContain("no handler terminated the process after SIGTERM");
		expect(log).toContain("process exit code=143");
		// Signal line comes before the exit line.
		expect(log.indexOf("signal SIGTERM")).toBeLessThan(log.indexOf("process exit"));
	});

	test("pi-style handler wins: it exits 0, the fallback never fires", async () => {
		// pi registers its own SIGTERM handler (graceful shutdown, exit 0) AFTER the recorder's
		// prepended listener. The fallback must stand down and let it produce code=0.
		const script2 = join(dir, "victim-pi.ts");
		writeFileSync(
			script2,
			`import { setupFlightRecorder } from "${import.meta.dir}/../src/core/flight-recorder.ts";
process.on("SIGTERM", () => { /* pi's graceful shutdown */ process.exit(0); });
setupFlightRecorder();
setInterval(() => {}, 10_000);
`,
		);
		const log = join(dir, "sigterm-pi.log");
		await new Promise<string>((resolve, reject) => {
			const child: ChildProcess = spawn("bun", [script2], {
				env: { ...process.env, PI_SUBAGENT_DEBUG: log },
				stdio: "ignore",
			});
			setTimeout(() => child.kill("SIGTERM"), 500);
			const deadline = Date.now() + 5000;
			const poll = setInterval(() => {
				if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
					clearInterval(poll);
					resolve(existsSync(log) ? readFileSync(log, "utf8") : "");
				}
			}, 100);
			child.on("error", reject);
		});
		expect(log ? readFileSync(log, "utf8") : "").toContain("process exit code=0");
		expect(readFileSync(log, "utf8")).not.toContain("no handler terminated");
	});

	test("SIGKILL is uncatchable: the log shows no signal line", async () => {
		// Exactly how the recorder distinguishes kill -9 from a graceful signal death.
		const log = await runAndSignal(join(dir, "sigkill.log"), "SIGKILL");
		expect(log).toContain("recorder installed");
		expect(log).not.toContain("signal");
	});

	test("does nothing when PI_SUBAGENT_DEBUG is unset", async () => {
		const log = join(dir, "off.log");
		await runAndSignal(log, "SIGTERM", { PI_SUBAGENT_DEBUG: "" });
		expect(existsSync(log)).toBe(false);
	});
});
