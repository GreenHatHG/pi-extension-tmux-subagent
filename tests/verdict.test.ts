import { describe, expect, it } from "bun:test";
import { buildVerdictArtifact, parseVerdictArtifact } from "../src/launch/verdict";

describe("parseVerdictArtifact", () => {
	it("parses a well-formed artifact", () => {
		const raw = buildVerdictArtifact("REDIRECT", "Stop using tailwind. Do X instead.");
		expect(parseVerdictArtifact(raw)).toEqual({
			verdict: "REDIRECT",
			judgment: "Stop using tailwind. Do X instead.",
		});
	});

	it("rejects a missing VERDICT line", () => {
		expect(parseVerdictArtifact("just some advice")).toBeUndefined();
	});

	it("rejects an unknown verdict word", () => {
		expect(parseVerdictArtifact("VERDICT: MAYBE\n\nadvice")).toBeUndefined();
	});

	it("rejects an empty judgment body", () => {
		expect(parseVerdictArtifact("VERDICT: PROCEED\n")).toBeUndefined();
		expect(parseVerdictArtifact("VERDICT: PROCEED\n   \n")).toBeUndefined();
	});

	it("keeps the full judgment body including internal blank lines", () => {
		const body = "line one\n\nline two";
		const parsed = parseVerdictArtifact(`VERDICT: STOP\n\n${body}`);
		expect(parsed?.judgment).toBe(body);
		expect(parsed?.verdict).toBe("STOP");
	});

	it("tolerates surrounding whitespace", () => {
		const parsed = parseVerdictArtifact("\n  VERDICT: PROCEED\n\n  advice\n");
		expect(parsed).toEqual({ verdict: "PROCEED", judgment: "advice" });
	});
});
