/**
 * launchSub refuses to start the advisor when advisor.vccCli cannot be found (exit 127), but launches
 * anyway for every ordinary failure — too few messages, timeout, session not on disk yet. That gate
 * keys on `commandMissing`, so two ways it can rot silently: a command-not-found that comes back
 * looking ordinary (gate never fires, and the advisor burns its run probing for the missing binary —
 * 8 minutes, no deliverable, once), and a normal decline classified as missing (every first advisor
 * call in a fresh session gets refused).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVccCompact } from "../src/modes/vcc";

const outPath = () => join(mkdtempSync(join(tmpdir(), "vcc-")), "summary.md");

describe("runVccCompact", () => {
	test("a command the shell cannot find is reported as missing", async () => {
		const r = await runVccCompact("definitely-not-a-command-xyz", "/tmp/whatever.jsonl", outPath());
		expect(r.ok).toBe(false);
		expect(r.commandMissing).toBe(true);
	});

	test("a working command that exits nonzero is not reported as missing", async () => {
		const r = await runVccCompact("false", "/tmp/whatever.jsonl", outPath());
		expect(r.ok).toBe(false);
		expect(r.commandMissing).toBeFalsy();
		expect(r.error?.length).toBeGreaterThan(0);
	});
});
