/**
 * Pure logic of the verification gate: the ledger, the ticket it derives, and the three refusals.
 * The event wiring (tool_call / agent_settled) is covered in verification-gate-coordination.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { ROUND_LIMIT, resolveVerification, type VerificationSettings } from "../src/core/config";
import {
	applyLedger,
	distinctPaths,
	emptyStateForTest,
	parseVerdict,
	refuseDone,
	refuseEdit,
	refuseVerification,
	ticketOf,
} from "../src/session/verification-gate";
import { useGateEnv } from "./gate-env";

const cfg = (patch: Partial<VerificationSettings> = {}): VerificationSettings => ({
	enabled: true,
	minChangedFiles: 3,
	...patch,
});

/** Register a round and land its verdict, the way the tool and the report poll do. */
function round(s: ReturnType<typeof emptyStateForTest>, verdict: "PASS" | "FAIL" | "PARTIAL"): void {
	applyLedger(s, { kind: "verifier", artifactPath: "/tmp/r/result.md" });
	applyLedger(s, {
		kind: "verdict",
		verdict,
		artifactPath: "/tmp/r/result.md",
		paths: s.verifierSnapshot.map((c) => c.path),
	});
}

describe("parseVerdict", () => {
	test("takes the last verdict line and rejects look-alikes", () => {
		expect(parseVerdict("VERDICT: FAIL\n...fixed...\nVERDICT: PASS\n")).toBe("PASS");
		expect(parseVerdict("**VERDICT: PASS**")).toBeUndefined();
		expect(parseVerdict("no verdict here")).toBeUndefined();
	});
});

describe("ledger", () => {
	test("a PASS clears exactly what the verifier saw; edits made during the run stay pending", () => {
		const s = emptyStateForTest();
		applyLedger(s, { kind: "change", path: "/a.ts", mtime: 1 });
		applyLedger(s, { kind: "verifier", artifactPath: "/tmp/r/result.md" });
		applyLedger(s, { kind: "change", path: "/b.ts", mtime: 2 }); // edited while the verifier ran
		applyLedger(s, { kind: "verdict", verdict: "PASS", artifactPath: "/tmp/r/result.md", paths: ["/a.ts"] });
		expect(s.pending.map((c) => c.path)).toEqual(["/b.ts"]);
		expect(ticketOf(s)).toBe("stale"); // the PASS is now older than the tree
	});

	test("a human reply opens a new burst and refills the rounds; a verdict does not", () => {
		const s = emptyStateForTest();
		applyLedger(s, { kind: "change", path: "/a.ts", mtime: 1 });
		round(s, "FAIL");
		round(s, "FAIL");
		expect(s.roundsUsed).toBe(2);
		expect(s.failStreak).toBe(2);
		applyLedger(s, { kind: "burst" });
		expect(s.roundsUsed).toBe(0);
		expect(s.failStreak).toBe(0);
	});

	test("the ticket is derived from pending + the last verdict, never stored", () => {
		const s = emptyStateForTest();
		expect(ticketOf(s)).toBe("none");
		applyLedger(s, { kind: "change", path: "/a.ts", mtime: 1 });
		expect(ticketOf(s)).toBe("dirty");
		round(s, "PASS");
		expect(ticketOf(s)).toBe("checked");
		applyLedger(s, { kind: "change", path: "/a.ts", mtime: 9 });
		expect(ticketOf(s)).toBe("stale");
	});
});

describe("refusals", () => {
	test("a round past the limit is refused, even with the gate switched off", () => {
		const s = emptyStateForTest();
		applyLedger(s, { kind: "change", path: "/a.ts", mtime: 1 });
		for (let i = 0; i < ROUND_LIMIT; i++) round(s, "FAIL");
		expect(refuseVerification(s, cfg())).toContain("already used its");
		expect(refuseVerification(s, cfg({ enabled: false }))).toContain("already used its");
	});

	test("re-verifying a tree a verdict already covered is refused: it would prove nothing", () => {
		const s = emptyStateForTest();
		// Nothing recorded at all: allowed, because bash edits never reach the ledger and a false
		// "nothing to verify" would block a legitimate round.
		expect(refuseVerification(s, cfg())).toBeUndefined();
		applyLedger(s, { kind: "change", path: "/a.ts", mtime: 1 });
		expect(refuseVerification(s, cfg())).toBeUndefined();
		round(s, "PASS");
		expect(refuseVerification(s, cfg())).toContain("No file changed");
	});

	test("the last round closes the pen: further edits are refused, never rounds before it", () => {
		const s = emptyStateForTest();
		applyLedger(s, { kind: "change", path: "/a.ts", mtime: 1 });
		expect(refuseEdit(s, cfg())).toBeUndefined();
		for (let i = 0; i < ROUND_LIMIT; i++) round(s, "PASS");
		expect(refuseEdit(s, cfg())).toContain("editing stops here");
		expect(refuseEdit(s, cfg({ enabled: false }))).toBeUndefined(); // switched off = no barrier
	});

	test("done is refused while files are unverified, but allowed once the rounds are spent", () => {
		const s = emptyStateForTest();
		for (const p of ["/a.ts", "/b.ts", "/c.ts"]) applyLedger(s, { kind: "change", path: p, mtime: 1 });
		expect(refuseDone(s, cfg())).toContain("/a.ts");
		expect(refuseDone(s, cfg({ minChangedFiles: 4 }))).toBeUndefined(); // below the threshold
		for (let i = 0; i < ROUND_LIMIT; i++) round(s, "FAIL");
		// Blocking done here would wedge the session: edits are refused, a round is refused
		expect(refuseDone(s, cfg())).toBeUndefined();
	});

	test("distinctPaths counts files, not writes", () => {
		expect(
			distinctPaths([
				{ path: "/a.ts", mtime: 1 },
				{ path: "/a.ts", mtime: 2 },
			]),
		).toEqual(["/a.ts"]);
	});
});

test("with no config at all the gate is on and needs 3 files", () => {
	const env = useGateEnv({});
	try {
		expect(resolveVerification()).toEqual({ enabled: true, minChangedFiles: 3 });
	} finally {
		env.restore();
	}
});
