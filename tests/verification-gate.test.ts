/**
 * Unit tests for the verification gate's pure logic: fingerprint derivation, verdict parsing,
 * and ledger application. The event wiring (tool_result/agent_settled) needs a live pi session
 * and is covered by manual verification.
 */
import { describe, expect, test } from "bun:test";
import { applyLedger, emptyStateForTest, fingerprintOf, parseVerdict } from "../src/session/verification-gate";

describe("fingerprintOf", () => {
	test("same change set yields the same fingerprint", () => {
		const a = [
			{ path: "/a.ts", mtime: 100 },
			{ path: "/b.ts", mtime: 200 },
		];
		const b = [
			{ path: "/a.ts", mtime: 100 },
			{ path: "/b.ts", mtime: 200 },
		];
		expect(fingerprintOf(a)).toBe(fingerprintOf(b));
	});

	test("order of the set does not matter", () => {
		const a = [
			{ path: "/a.ts", mtime: 100 },
			{ path: "/b.ts", mtime: 200 },
		];
		const b = [
			{ path: "/b.ts", mtime: 200 },
			{ path: "/a.ts", mtime: 100 },
		];
		expect(fingerprintOf(a)).toBe(fingerprintOf(b));
	});

	test("re-writing the same file (new mtime) yields a NEW fingerprint", () => {
		// Load-bearing: a fix-after-FAIL touching the same files must not look "already handled".
		const before = [{ path: "/a.ts", mtime: 100 }];
		const after = [{ path: "/a.ts", mtime: 200 }];
		expect(fingerprintOf(after)).not.toBe(fingerprintOf(before));
	});

	test("an added file yields a NEW fingerprint", () => {
		const before = [{ path: "/a.ts", mtime: 100 }];
		const after = [
			{ path: "/a.ts", mtime: 100 },
			{ path: "/b.ts", mtime: 100 },
		];
		expect(fingerprintOf(after)).not.toBe(fingerprintOf(before));
	});
});

describe("parseVerdict", () => {
	test("parses the exact verdict line", () => {
		expect(parseVerdict("stuff\nVERDICT: PASS\n")).toBe("PASS");
		expect(parseVerdict("VERDICT: FAIL")).toBe("FAIL");
		expect(parseVerdict("VERDICT: PARTIAL")).toBe("PARTIAL");
	});

	test("takes the last verdict line when the report repeats it", () => {
		expect(parseVerdict("VERDICT: FAIL\n...fixed...\nVERDICT: PASS\n")).toBe("PASS");
	});

	test("rejects look-alikes", () => {
		expect(parseVerdict("**VERDICT: PASS**")).toBeUndefined(); // markdown bold is forbidden by the prompt
		expect(parseVerdict("verdict: pass")).toBeUndefined(); // case-sensitive by contract
		expect(parseVerdict("VERDICT: SURE")).toBeUndefined();
		expect(parseVerdict("no verdict here")).toBeUndefined();
	});
});

describe("applyLedger", () => {
	test("changes accumulate; PASS clears the pending set", () => {
		const s = emptyStateForTest();
		applyLedger(s, { kind: "change", path: "/a.ts", mtime: 1 });
		applyLedger(s, { kind: "change", path: "/b.ts", mtime: 2 });
		expect(s.pending).toHaveLength(2);
		const fp = fingerprintOf(s.pending);
		applyLedger(s, { kind: "verifier", artifactPath: "/tmp/x/result.md" });
		applyLedger(s, { kind: "verdict", fingerprint: fp, verdict: "PASS", artifactPath: "/tmp/x/result.md" });
		expect(s.pending).toHaveLength(0);
		expect(s.verifierArtifactPath).toBe("");
	});

	test("PARTIAL clears the snapshot too (it means verified-with-limits)", () => {
		const s = emptyStateForTest();
		applyLedger(s, { kind: "change", path: "/a.ts", mtime: 1 });
		const fp = fingerprintOf(s.pending);
		applyLedger(s, { kind: "verifier", artifactPath: "/tmp/x/result.md", fingerprint: fp });
		applyLedger(s, { kind: "verdict", fingerprint: fp, verdict: "PARTIAL", artifactPath: "/tmp/x/result.md" });
		expect(s.pending).toHaveLength(0);
	});

	test("FAIL keeps the pending set (the fix will re-fingerprint) and clears the nudge counter", () => {
		const s = emptyStateForTest();
		applyLedger(s, { kind: "change", path: "/a.ts", mtime: 1 });
		const fp = fingerprintOf(s.pending);
		applyLedger(s, { kind: "nudge", fingerprint: fp, count: 2 });
		applyLedger(s, { kind: "verifier", artifactPath: "/tmp/x/result.md", fingerprint: fp });
		applyLedger(s, { kind: "verdict", fingerprint: fp, verdict: "FAIL", artifactPath: "/tmp/x/result.md" });
		expect(s.pending).toHaveLength(1);
		expect(s.verifierArtifactPath).toBe("");
		expect(s.nudges.get(fp)).toBeUndefined();
	});

	test("PASS clears only the snapshot: edits made while the verifier ran stay pending", () => {
		const s = emptyStateForTest();
		applyLedger(s, { kind: "change", path: "/a.ts", mtime: 1 });
		const fp = fingerprintOf(s.pending);
		applyLedger(s, { kind: "verifier", artifactPath: "/tmp/x/result.md", fingerprint: fp });
		// The model edits another file while the verifier is running
		applyLedger(s, { kind: "change", path: "/b.ts", mtime: 2 });
		applyLedger(s, { kind: "verdict", fingerprint: fp, verdict: "PASS", artifactPath: "/tmp/x/result.md" });
		expect(s.pending.map((c) => c.path)).toEqual(["/b.ts"]); // /a.ts cleared, /b.ts kept
		expect(s.verifierArtifactPath).toBe("");
		expect(s.verifierSnapshot).toHaveLength(0);
	});

	test("PASS freezes the files it covered; FAIL freezes nothing", () => {
		const s = emptyStateForTest();
		applyLedger(s, { kind: "change", path: "/a.ts", mtime: 1 });
		const fp = fingerprintOf(s.pending);
		applyLedger(s, { kind: "verifier", artifactPath: "/tmp/x/result.md", fingerprint: fp });
		applyLedger(s, { kind: "verdict", fingerprint: fp, verdict: "FAIL", artifactPath: "/tmp/x/result.md" });
		expect(s.frozen.size).toBe(0);

		applyLedger(s, { kind: "verifier", artifactPath: "/tmp/x/result.md", fingerprint: fp });
		applyLedger(s, { kind: "verdict", fingerprint: fp, verdict: "PASS", artifactPath: "/tmp/x/result.md" });
		expect([...s.frozen.keys()]).toEqual(["/a.ts"]);

		// The warning is recorded, so a reload cannot repeat it
		applyLedger(s, { kind: "freeze-warn", path: "/a.ts", fingerprint: fp });
		expect(s.frozenWarned.get("/a.ts")).toBe(fp);
	});

	test("fail streak: FAIL grows it, PASS resets it, PARTIAL leaves it alone", () => {
		const s = emptyStateForTest();
		const fail = () =>
			applyLedger(s, { kind: "verdict", fingerprint: "f", verdict: "FAIL", artifactPath: "/tmp/x/result.md" });
		fail();
		fail();
		expect(s.failStreak).toBe(2);
		applyLedger(s, { kind: "verdict", fingerprint: "f", verdict: "PARTIAL", artifactPath: "/tmp/x/result.md" });
		expect(s.failStreak).toBe(2);
		applyLedger(s, { kind: "verdict", fingerprint: "f", verdict: "PASS", artifactPath: "/tmp/x/result.md" });
		expect(s.failStreak).toBe(0);
	});

	test("escalate records the streak it fired at, so the same streak does not escalate twice", () => {
		const s = emptyStateForTest();
		applyLedger(s, { kind: "verdict", fingerprint: "f", verdict: "FAIL", artifactPath: "/tmp/x/result.md" });
		applyLedger(s, { kind: "escalate", streak: 1 });
		expect(s.escalatedAt).toBe(1);
		applyLedger(s, { kind: "verdict", fingerprint: "f", verdict: "PASS", artifactPath: "/tmp/x/result.md" });
		expect(s.escalatedAt).toBe(0); // a PASS re-arms it
	});
});
