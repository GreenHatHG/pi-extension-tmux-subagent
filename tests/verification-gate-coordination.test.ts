/**
 * Coordination tests for the verification gate's watchdog handshake: the gate must only demand
 * verification on a completion settle (right after the watchdog's ai-stop done signal), stay
 * silent on mid-task settles while a watchdog drives, and fall back to settling when no
 * watchdog is present or it has stopped. The pi.events bus is mocked: pi.on (lifecycle) and
 * pi.events (bus) are separate transports, and the gate listens on the bus.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setupVerificationGate, type VerificationGate } from "../src/session/verification-gate";

let tmpDirs: string[] = [];
const oldEnvDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(() => {
	// Fresh config per test: gate on, one changed file is enough, one nudge allowed.
	const dir = mkdtempSync(join(tmpdir(), "vgate-"));
	tmpDirs.push(dir);
	writeFileSync(
		join(dir, "subagent_advisor.json"),
		JSON.stringify({ verification: { enabled: true, minChangedFiles: 1, nudgeLimit: 1 } }),
	);
	process.env.PI_CODING_AGENT_DIR = dir;
});

afterEach(() => {
	if (oldEnvDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = oldEnvDir;
	for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
	tmpDirs = [];
});

/** Minimal pi mock: separate pi.on (lifecycle) and pi.events (bus) transports, like the real thing. */
function mockPi() {
	const lifecycle = new Map<string, ((...a: unknown[]) => unknown)[]>();
	const bus = new Map<string, ((...a: unknown[]) => unknown)[]>();
	const sent: { text: string; opts?: unknown }[] = [];
	const warnings: string[] = [];
	// Ledger entries the gate persists, so replay can be exercised for real
	const entries: unknown[] = [];
	const subscribe = (m: Map<string, ((...a: unknown[]) => unknown)[]>, ch: string, h: (...a: unknown[]) => unknown) => {
		const l = m.get(ch) ?? [];
		l.push(h);
		m.set(ch, l);
	};
	const fire = async (m: Map<string, ((...a: unknown[]) => unknown)[]>, ch: string, ...a: unknown[]) => {
		for (const h of m.get(ch) ?? []) await h(...a);
	};
	const pi = {
		on: (ch: string, h: (...a: unknown[]) => unknown) => subscribe(lifecycle, ch, h),
		events: {
			on: (ch: string, h: (...a: unknown[]) => unknown) => subscribe(bus, ch, h),
			emit: (ch: string, data: unknown) => {
				for (const h of bus.get(ch) ?? []) h(data);
			},
		},
		appendEntry: (type: string, data: unknown) => {
			entries.push({ type: "custom", customType: type, data });
		},
		sendUserMessage: (text: string, opts?: unknown) => {
			sent.push({ text, opts });
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		ui: {
			notify: (_m: string, level?: string) => {
				if (level === "warning") warnings.push(_m);
			},
		},
		isIdle: () => true,
		sessionManager: { getEntries: () => entries },
	} as unknown as ExtensionContext;
	return {
		pi,
		ctx,
		sent,
		warnings,
		entries,
		/** Fire the lifecycle handler the gate registered for agent_settled. */
		settle: () => fire(lifecycle, "agent_settled", {}, ctx),
		/** Fire session_start: the gate replays its ledger from the persisted entries. */
		start: () => fire(lifecycle, "session_start", {}, ctx),
		/** Record one successful write tool result against a real temp file (mtime is stat'd for real). */
		async change(path?: string) {
			const p = path ?? join(tmpDirs[0], `changed-${Math.random().toString(36).slice(2)}.ts`);
			writeFileSync(p, "// touched");
			await fire(lifecycle, "tool_result", { toolName: "write", isError: false, input: { path: p } });
			return p;
		},
	};
}

describe("verification gate × watchdog coordination", () => {
	test("while the watchdog runs, a mid-task settle stays silent", async () => {
		const rt = mockPi();
		setupVerificationGate(rt.pi);
		await rt.change();
		rt.pi.events.emit("watchdog:state", { running: true });
		await rt.settle();
		expect(rt.sent).toHaveLength(0);
	});

	test("the settle right after the ai-stop done signal demands verification", async () => {
		const rt = mockPi();
		setupVerificationGate(rt.pi);
		await rt.change();
		rt.pi.events.emit("watchdog:state", { running: true });
		rt.pi.events.emit("watchdog:stopped", { reason: "ai-stop", suspended: false });
		await rt.settle();
		expect(rt.sent).toHaveLength(1);
		expect(rt.sent[0].text).toContain("[verification gate]");
		expect(rt.sent[0].text).toContain("Run the verification tool now");
	});

	test("the done signal is consumed by one settle only", async () => {
		const rt = mockPi();
		setupVerificationGate(rt.pi);
		await rt.change();
		rt.pi.events.emit("watchdog:state", { running: true });
		rt.pi.events.emit("watchdog:stopped", { reason: "ai-stop", suspended: false });
		await rt.settle();
		// A second settle (e.g. the verification turn itself ending) must not re-nudge.
		await rt.settle();
		expect(rt.sent).toHaveLength(1);
	});

	test("a keep-mode nap's done (suspended=true) still triggers, and resume settles don't re-demand", async () => {
		const rt = mockPi();
		setupVerificationGate(rt.pi);
		await rt.change();
		rt.pi.events.emit("watchdog:state", { running: true });
		rt.pi.events.emit("watchdog:stopped", { reason: "ai-stop", suspended: true });
		await rt.settle();
		expect(rt.sent).toHaveLength(1);
		// User comes back, watchdog resumes (running: true): mid-task settles stay silent again.
		rt.pi.events.emit("watchdog:state", { running: true });
		await rt.settle();
		expect(rt.sent).toHaveLength(1);
	});

	test("no watchdog at all: the settle itself is the completion signal (fallback)", async () => {
		const rt = mockPi();
		setupVerificationGate(rt.pi);
		await rt.change();
		await rt.settle();
		expect(rt.sent).toHaveLength(1);
	});

	test("after the watchdog stops (running=false state first), settles fall back to demanding", async () => {
		const rt = mockPi();
		setupVerificationGate(rt.pi);
		await rt.change();
		// Nudge cap path: teardown broadcasts running:false, then publishStopped("max-reached").
		rt.pi.events.emit("watchdog:state", { running: true });
		rt.pi.events.emit("watchdog:state", { running: false });
		rt.pi.events.emit("watchdog:stopped", { reason: "max-reached", suspended: false });
		await rt.settle();
		expect(rt.sent).toHaveLength(1);
	});

	test("at the nudge limit the gate escalates to the user instead of nudging", async () => {
		const rt = mockPi();
		setupVerificationGate(rt.pi);
		await rt.change();
		await rt.settle(); // nudge 1/1 (nudgeLimit = 1)
		expect(rt.sent).toHaveLength(1);
		await rt.settle(); // over the limit: warn, don't nudge
		expect(rt.sent).toHaveLength(1);
		expect(rt.warnings.some((w) => w.includes("still unverified"))).toBe(true);
	});
});

/** Run one verifier round: register the artifact, then hand the gate a report carrying this verdict. */
function recordRound(gate: VerificationGate, verdict: "PASS" | "FAIL" | "PARTIAL"): void {
	const artifact = join(tmpDirs[0], `report-${Math.random().toString(36).slice(2)}.md`);
	gate.recordVerifierStarted(artifact);
	writeFileSync(artifact, `# report\n\n## Observations (non-blocking)\nnone\n\nVERDICT: ${verdict}\n`);
	gate.recordVerdictFromReport();
}

describe("verification gate × loop brakes", () => {
	test("a PASS freezes the covered file: the next edit warns exactly once", async () => {
		const rt = mockPi();
		const gate = setupVerificationGate(rt.pi);
		const file = await rt.change();
		recordRound(gate, "PASS");
		expect(gate.state.frozen.has(file)).toBe(true);

		const before = rt.sent.length;
		await rt.change(file); // the classic "one more nit" edit right after a PASS
		expect(rt.sent).toHaveLength(before + 1);
		expect(rt.sent.at(-1)?.text).toContain("was covered by a PASS/PARTIAL verdict");

		await rt.change(file); // same file, same PASS: no second warning
		expect(rt.sent).toHaveLength(before + 1);
	});

	test("a FAIL round freezes nothing, so the normal fix loop stays quiet", async () => {
		const rt = mockPi();
		const gate = setupVerificationGate(rt.pi);
		const file = await rt.change();
		recordRound(gate, "FAIL");
		const before = rt.sent.length;
		await rt.change(file);
		expect(rt.sent).toHaveLength(before);
	});

	test("the soft FAIL limit adds a triage note to the nudge", async () => {
		const rt = mockPi();
		const gate = setupVerificationGate(rt.pi);
		await rt.change();
		recordRound(gate, "FAIL");
		recordRound(gate, "FAIL"); // failStreak = 2 = default soft limit
		expect(gate.state.failStreak).toBe(2);
		await rt.settle();
		expect(rt.sent.at(-1)?.text).toContain("Triage before fixing again");
	});

	test("the hard FAIL limit stops the loop and tells the model to report to the user", async () => {
		writeFileSync(
			join(tmpDirs[0], "subagent_advisor.json"),
			JSON.stringify({
				verification: { enabled: true, minChangedFiles: 1, nudgeLimit: 9, failSoftLimit: 1, failHardLimit: 1 },
			}),
		);
		const rt = mockPi();
		const gate = setupVerificationGate(rt.pi);
		await rt.change();
		recordRound(gate, "FAIL");
		await rt.settle();
		expect(rt.sent.at(-1)?.text).toContain("Stop fixing");
		expect(rt.warnings.some((w) => w.includes("FAILED in a row"))).toBe(true);

		// Same streak, later settle: the escalation already happened, so no repeat spam.
		const sent = rt.sent.length;
		await rt.settle();
		expect(rt.sent).toHaveLength(sent);
	});

	test("one file spelled relatively and absolutely is still one pending change", async () => {
		const rt = mockPi();
		const gate = setupVerificationGate(rt.pi);
		const abs = await rt.change();
		recordRound(gate, "PASS");

		// The model writes the same file with a relative path this time
		const before = rt.sent.length;
		await rt.change(relative(process.cwd(), abs));
		expect(rt.sent).toHaveLength(before + 1); // the freeze warning still fires
		expect(gate.state.pending.map((c) => c.path)).toEqual([abs]); // and there is one entry, absolute
	});

	test("replay is idempotent: a second session_start does not double the ledger", async () => {
		const rt = mockPi();
		const gate = setupVerificationGate(rt.pi);
		await rt.change();
		recordRound(gate, "FAIL");
		recordRound(gate, "FAIL");

		await rt.start();
		expect(gate.state.failStreak).toBe(2);
		expect(gate.state.pending).toHaveLength(1);

		await rt.start(); // same entries again: must not accumulate
		expect(gate.state.failStreak).toBe(2);
		expect(gate.state.pending).toHaveLength(1);
	});
});
