/**
 * The verification brief is the verifier's only source of context, so its wording is load-bearing:
 * the scope gate and the three-verdict definition are what keep a verifier from turning every
 * out-of-scope nit into a FAIL (the loop that burned three hours once).
 */
import { describe, expect, test } from "bun:test";
import { buildVerificationBrief } from "../src/modes/briefs";

const brief = buildVerificationBrief("do the task", "changed /a.ts", "/tmp/x/result.md", false);

describe("verification brief", () => {
	test("states the scope gate", () => {
		expect(brief).toContain("## Scope (settle it before you start)");
		expect(brief).toContain("In scope:");
		expect(brief).toContain("Out of scope:");
	});

	test("defines all three verdicts, and PARTIAL is not a soft FAIL", () => {
		expect(brief).toContain("PASS = the original task is met");
		expect(brief).toContain("PARTIAL = the task is met");
		expect(brief).toContain("FAIL = the task is not met");
		expect(brief).toContain("PARTIAL is NOT a soft FAIL");
	});

	test("out-of-scope findings cannot move the verdict", () => {
		expect(brief).toContain("## Observations (non-blocking)");
		expect(brief).toContain("must NOT move the verdict");
	});
});
