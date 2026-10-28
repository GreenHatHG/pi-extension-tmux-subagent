/**
 * Tool-entry brake: the verification tool itself must refuse to start another round once the
 * consecutive-FAIL streak hits the hard limit, even with the gate switched off and even when the
 * session never settles (the incident: 9 FAIL rounds over 3 hours, all started from tool calls
 * while the model blocked inside bash waiting for each verifier).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FAIL_HARD_LIMIT } from "../src/core/config";
import { setupVerificationGate, type VerificationGate } from "../src/session/verification-gate";
import { setupVerification } from "../src/tools/verification";

let dirs: string[] = [];
const oldEnvDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "vbrake-"));
	dirs.push(dir);
	// Gate switched OFF on purpose: the observed loop ran with the gate disabled, so the brake
	// must not depend on it.
	writeFileSync(join(dir, "subagent_advisor.json"), JSON.stringify({ verification: { enabled: false } }));
	process.env.PI_CODING_AGENT_DIR = dir;
});

afterEach(() => {
	if (oldEnvDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = oldEnvDir;
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

function harness() {
	const entries: Record<string, unknown>[] = [];
	const tools = new Map<string, { execute: (...a: unknown[]) => Promise<{ content: { text?: string }[] }> }>();
	const warnings: string[] = [];
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
		ui: {
			notify: (m: string, level?: string) => {
				if (level === "warning") warnings.push(m);
			},
		},
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
	return { gate, tool, entries, warnings, input, launched: () => launched, ctx };
}

const verdictFail = "FAIL" as const;

/** One verifier round: register the artifact, write a report, let the gate read the verdict. */
function round(gate: VerificationGate, verdict: "PASS" | "FAIL"): void {
	const artifact = join(dirs[0], `report-${Math.random().toString(36).slice(2)}.md`);
	gate.recordVerifierStarted(artifact);
	writeFileSync(artifact, `# report\n\nVERDICT: ${verdict}\n`);
	gate.recordVerdictFromReport();
}

/** Spend the full FAIL budget so the brake is closed. */
function failBudget(gate: VerificationGate): void {
	for (let i = 0; i < FAIL_HARD_LIMIT; i++) round(gate, verdictFail);
}

describe("verification tool × FAIL brake", () => {
	test("at the hard FAIL limit the tool refuses to spawn another verifier", async () => {
		const rt = harness();
		failBudget(rt.gate);

		const res = await rt.tool.execute("c1", { question: "original task" }, undefined, undefined, rt.ctx);

		expect(rt.launched()).toBe(0);
		expect(res.content[0]?.text).toContain("Not starting another verification round");
	});

	test("human input lifts the brake and restarts the budget", async () => {
		const rt = harness();
		failBudget(rt.gate);
		rt.input("interactive");

		await rt.tool.execute("c1", { question: "original task" }, undefined, undefined, rt.ctx);

		expect(rt.launched()).toBe(1);
	});

	test("an extension-injected message does not count as the user deciding", async () => {
		const rt = harness();
		failBudget(rt.gate);
		rt.input("extension"); // the gate's own nudge, a watchdog poke, goal-mode's "keep going"

		await rt.tool.execute("c1", { question: "original task" }, undefined, undefined, rt.ctx);

		expect(rt.launched()).toBe(0);
	});

	test("an injection after the human's word does not swallow the grant", async () => {
		const rt = harness();
		failBudget(rt.gate);
		rt.input("interactive");
		// Freeze-warn/nudge lands after the human spoke: the authorization underneath still counts
		rt.input("extension"); // e.g. the freeze warning that edit triggered

		await rt.tool.execute("c1", { question: "original task" }, undefined, undefined, rt.ctx);

		expect(rt.launched()).toBe(1);
	});

	test("one human input grants one budget, not a permanent pass", async () => {
		const rt = harness();
		failBudget(rt.gate);
		rt.input("interactive");
		await rt.tool.execute("c1", { question: "original task" }, undefined, undefined, rt.ctx);
		expect(rt.launched()).toBe(1);

		// Another full streak of FAILs; that same turn is spent
		failBudget(rt.gate);
		await rt.tool.execute("c2", { question: "original task" }, undefined, undefined, rt.ctx);

		expect(rt.launched()).toBe(1);
	});
});
