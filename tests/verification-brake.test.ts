/**
 * Round budget at the tool entry: the verification tool itself refuses to start round N+1, even
 * with the gate switched off and even when the session never settles. The incident: 9 FAIL rounds
 * over three hours, every one of them started from a tool call while the model blocked inside bash
 * waiting for the previous verifier, so no settle ever fired.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ROUND_LIMIT } from "../src/core/config";
import { setupVerificationGate, type VerificationGate } from "../src/session/verification-gate";
import { setupVerification } from "../src/tools/verification";
import { type GateEnv, useGateEnv } from "./gate-env";

let env: GateEnv;

beforeEach(() => {
	// Gate switched OFF on purpose: the observed loop ran with the gate disabled, so the brake
	// must not depend on it.
	env = useGateEnv({ verification: { enabled: false } });
});

afterEach(() => {
	env.restore();
});

function harness() {
	const entries: Record<string, unknown>[] = [];
	const tools = new Map<string, { execute: (...a: unknown[]) => Promise<{ content: { text?: string }[] }> }>();
	const lifecycle = new Map<string, ((...a: unknown[]) => unknown)[]>();
	const pi = {
		on: (event: string, handler: (...a: unknown[]) => unknown) => {
			const l = lifecycle.get(event) ?? [];
			l.push(handler);
			lifecycle.set(event, l);
		},
		events: { on: () => {}, emit: () => {} },
		appendEntry: (customType: string, data: unknown) =>
			entries.push({ type: "custom", id: `e${entries.length}`, customType, data }),
		sendUserMessage: () => {},
		registerTool: (
			def: { name: string } & { execute: (...a: unknown[]) => Promise<{ content: { text?: string }[] }> },
		) => tools.set(def.name, def),
	} as unknown as ExtensionAPI;
	const ctx = {
		ui: { notify: () => {} },
		isIdle: () => true,
		sessionManager: { getEntries: () => entries, getSessionId: () => "sess" },
	} as unknown as ExtensionContext;

	const gate = setupVerificationGate(pi);
	let launched = 0;
	setupVerification(pi, gate, async () => {
		launched++;
		return { ok: true, text: "Sub-agent started (deliverable: /tmp/pi-sub-x/result.md)." };
	});
	const tool = tools.get("verification");
	if (!tool) throw new Error("verification tool was not registered");
	/** Fire a pi `input` event from the given source, like pi does when a prompt is submitted. */
	const input = (source: string) => {
		for (const h of lifecycle.get("input") ?? []) h({ type: "input", text: "go", source });
	};
	return { gate, tool, input, launched: () => launched, ctx };
}

/** One verifier round: register the artifact, write a report, let the gate read the verdict. */
function round(gate: VerificationGate, verdict: "PASS" | "FAIL"): void {
	const artifact = join(env.dir, `report-${Math.random().toString(36).slice(2)}.md`);
	gate.recordVerifierStarted(artifact);
	writeFileSync(artifact, `# report\n\nVERDICT: ${verdict}\n`);
	gate.recordVerdictFromReport();
}

/** Spend the whole round budget. */
function spendBudget(gate: VerificationGate): void {
	for (let i = 0; i < ROUND_LIMIT; i++) round(gate, "FAIL");
}

describe("verification tool × round budget", () => {
	test("at the round limit the tool refuses to spawn another verifier", async () => {
		const rt = harness();
		spendBudget(rt.gate);

		const res = await rt.tool.execute("c1", { question: "original task" }, undefined, undefined, rt.ctx);

		expect(rt.launched()).toBe(0);
		expect(res.content[0]?.text).toContain("already used its");
	});

	test("human input refills the budget", async () => {
		const rt = harness();
		spendBudget(rt.gate);
		rt.input("interactive");

		await rt.tool.execute("c1", { question: "original task" }, undefined, undefined, rt.ctx);

		expect(rt.launched()).toBe(1);
	});

	test("an extension-injected message does not refill it", async () => {
		const rt = harness();
		spendBudget(rt.gate);
		rt.input("extension"); // the watchdog, goal-mode's "keep going", this gate's own message

		await rt.tool.execute("c1", { question: "original task" }, undefined, undefined, rt.ctx);

		expect(rt.launched()).toBe(0);
	});

	test("an injection after the human's word cannot swallow the refill", async () => {
		const rt = harness();
		spendBudget(rt.gate);
		rt.input("interactive");
		rt.input("extension");

		await rt.tool.execute("c1", { question: "original task" }, undefined, undefined, rt.ctx);

		expect(rt.launched()).toBe(1);
	});

	test("one human reply buys one budget, not a permanent pass", async () => {
		const rt = harness();
		spendBudget(rt.gate);
		rt.input("interactive");
		await rt.tool.execute("c1", { question: "original task" }, undefined, undefined, rt.ctx);
		expect(rt.launched()).toBe(1);

		spendBudget(rt.gate);
		await rt.tool.execute("c2", { question: "original task" }, undefined, undefined, rt.ctx);

		expect(rt.launched()).toBe(1);
	});
});
