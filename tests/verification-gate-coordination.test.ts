/**
 * Wiring tests for the verification gate: when the one settle message goes out, and what the
 * tool_call refusals answer. The incident behind the shape: five per-file "just changed" messages
 * queued behind one voided verdict and took over the conversation for 23 minutes, and two of them
 * started verification rounds on an unchanged tree.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ROUND_LIMIT } from "../src/core/config";
import { setupVerificationGate, type VerificationGate } from "../src/session/verification-gate";
import { type GateEnv, useGateEnv, writeGateConfig } from "./gate-env";

let env: GateEnv;

beforeEach(() => {
	env = useGateEnv();
});

afterEach(() => {
	env.restore();
});

/** Minimal pi mock: separate pi.on (lifecycle) and pi.events (bus) transports, like the real thing. */
function mockPi() {
	const lifecycle = new Map<string, ((...a: unknown[]) => unknown)[]>();
	const bus = new Map<string, ((...a: unknown[]) => unknown)[]>();
	const sent: { text: string; opts?: unknown }[] = [];
	const warnings: string[] = [];
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
			notify: (m: string, level?: string) => {
				if (level === "warning") warnings.push(m);
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
		settle: () => fire(lifecycle, "agent_settled", {}, ctx),
		start: () => fire(lifecycle, "session_start", {}, ctx),
		input: (source: string) => fire(lifecycle, "input", { type: "input", source }, ctx),
		/** Fire the tool_call handlers and return the refusal, if any handler produced one. */
		async callTool(toolName: string, input: Record<string, unknown> = {}) {
			let out: { block?: boolean; reason?: string } | undefined;
			for (const h of lifecycle.get("tool_call") ?? []) {
				const r = (await h({ toolName, input }, ctx)) as { block?: boolean; reason?: string } | undefined;
				if (r) out = r;
			}
			return out;
		},
		/** One successful write tool result against a real temp file (mtime is stat'd for real). */
		async change(path?: string) {
			const p = path ?? join(env.dir, `changed-${Math.random().toString(36).slice(2)}.ts`);
			writeFileSync(p, "// touched");
			await fire(lifecycle, "tool_result", { toolName: "write", isError: false, input: { path: p } });
			return p;
		},
	};
}

/** Run one verifier round the way the tool does: register the artifact, then read the verdict. */
function round(gate: VerificationGate, verdict: "PASS" | "FAIL" | "PARTIAL", file?: string): void {
	const artifact = join(env.dir, `report-${Math.random().toString(36).slice(2)}.md`);
	if (file) writeFileSync(file, `// touched again ${Math.random()}`);
	gate.recordVerifierStarted(artifact);
	writeFileSync(artifact, `# report\n\nVERDICT: ${verdict}\n`);
	gate.recordVerdictFromReport();
}

describe("verification gate × settle message", () => {
	test("five edits produce ONE message, not five", async () => {
		const rt = mockPi();
		setupVerificationGate(rt.pi);
		for (let i = 0; i < 5; i++) await rt.change();
		await rt.settle();
		expect(rt.sent).toHaveLength(1);
		expect(rt.sent[0].text).toContain("unverified");
	});

	test("the message is sent once per burst, however often the session settles", async () => {
		const rt = mockPi();
		setupVerificationGate(rt.pi);
		await rt.change();
		await rt.settle();
		await rt.settle();
		expect(rt.sent).toHaveLength(1);
	});

	test("a human reply opens a new burst and the gate speaks again", async () => {
		const rt = mockPi();
		setupVerificationGate(rt.pi);
		await rt.change();
		await rt.settle();
		await rt.input("interactive");
		await rt.change();
		await rt.settle();
		expect(rt.sent).toHaveLength(2);
	});

	test("an extension-injected message is not a new burst", async () => {
		const rt = mockPi();
		setupVerificationGate(rt.pi);
		await rt.change();
		await rt.settle();
		await rt.input("extension"); // the watchdog, goal-mode, this gate's own message
		await rt.change();
		await rt.settle();
		expect(rt.sent).toHaveLength(1);
	});

	test("a verified, untouched tree stays quiet", async () => {
		const rt = mockPi();
		const gate = setupVerificationGate(rt.pi);
		const file = await rt.change();
		round(gate, "PASS", file);
		await rt.settle();
		expect(rt.sent).toHaveLength(0);
	});

	test("while a watchdog drives, a mid-task settle stays silent; its done settle speaks", async () => {
		const rt = mockPi();
		setupVerificationGate(rt.pi);
		await rt.change();
		rt.pi.events.emit("watchdog:state", { running: true });
		await rt.settle();
		expect(rt.sent).toHaveLength(0);
		rt.pi.events.emit("watchdog:stopped", { reason: "ai-stop", suspended: false });
		await rt.settle();
		expect(rt.sent).toHaveLength(1);
	});

	test("an explicit enabled:false turns the messages off", async () => {
		writeGateConfig(env, { verification: { enabled: false } });
		const rt = mockPi();
		setupVerificationGate(rt.pi);
		await rt.change();
		await rt.settle();
		expect(rt.sent).toHaveLength(0);
	});
});

describe("verification gate × refusals", () => {
	test("done is refused while unverified files exist, then allowed after a verdict", async () => {
		const rt = mockPi();
		const gate = setupVerificationGate(rt.pi);
		const file = await rt.change();
		const refused = await rt.callTool("watchdog_decide", { decision: "done" });
		expect(refused?.block).toBe(true);
		expect(refused?.reason).toContain(file);

		round(gate, "PASS", file);
		expect(await rt.callTool("watchdog_decide", { decision: "done" })).toBeUndefined();
	});

	test("re-verifying an unchanged tree is refused instead of spawning a verifier", async () => {
		const rt = mockPi();
		const gate = setupVerificationGate(rt.pi);
		const file = await rt.change();
		round(gate, "PASS", file);
		const refused = await rt.callTool("verification");
		expect(refused?.block).toBe(true);
		expect(refused?.reason).toContain("No file changed");
	});

	test("after the last round both editing and verifying are refused, and the user is told once", async () => {
		const rt = mockPi();
		const gate = setupVerificationGate(rt.pi);
		const file = await rt.change();
		for (let i = 0; i < ROUND_LIMIT; i++) round(gate, "PASS", file);

		expect((await rt.callTool("edit", { path: file }))?.block).toBe(true);
		expect((await rt.callTool("write", { path: file }))?.block).toBe(true);
		expect((await rt.callTool("verification"))?.block).toBe(true);
		expect(rt.warnings).toHaveLength(1);

		// A human reply refills the budget: editing works again
		await rt.input("interactive");
		expect(await rt.callTool("edit", { path: file })).toBeUndefined();
	});

	test("when the budget is spent the wrap-up is allowed, but the user is told what stays unverified", async () => {
		const rt = mockPi();
		const gate = setupVerificationGate(rt.pi);
		const file = await rt.change();
		for (let i = 0; i < ROUND_LIMIT; i++) round(gate, "FAIL", file);

		expect(await rt.callTool("watchdog_decide", { decision: "done" })).toBeUndefined();
		expect(rt.warnings).toHaveLength(1);
		expect(rt.warnings[0]).toContain(file);
	});

	test("inside a sub-agent pane the gate keeps its hands off: a verifier's own edits are not its business", async () => {
		process.env.PI_SUBAGENT = "1";
		const rt = mockPi();
		const gate = setupVerificationGate(rt.pi);
		await rt.change();
		await rt.settle();
		expect(rt.sent).toHaveLength(0); // no message
		expect(await rt.callTool("watchdog_decide", { decision: "done" })).toBeUndefined(); // no refusal
		expect(gate.state.pending).toHaveLength(0); // and nothing recorded
	});

	test("replay is idempotent: a second session_start does not double the ledger", async () => {
		const rt = mockPi();
		const gate = setupVerificationGate(rt.pi);
		await rt.change();
		round(gate, "FAIL");

		await rt.start();
		expect(gate.state.roundsUsed).toBe(1);
		expect(gate.state.pending).toHaveLength(1);

		await rt.start();
		expect(gate.state.roundsUsed).toBe(1);
		expect(gate.state.pending).toHaveLength(1);
	});
});
