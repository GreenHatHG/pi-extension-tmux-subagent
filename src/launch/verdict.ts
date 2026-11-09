/** Verdict contract shared by the advisor fork launcher (src/launch/advisor-fork.ts) and the verdict extension (src/launch/verdict-extension.ts). */

export type AdvisorVerdict = "PROCEED" | "REDIRECT" | "STOP";

export const VERDICT_CHOICES = ["PROCEED", "REDIRECT", "STOP"] as const;

/** Line 1 of result.md, written by the submit_verdict handler from the structured tool argument. */
export function buildVerdictArtifact(verdict: AdvisorVerdict, judgment: string): string {
	return `VERDICT: ${verdict}\n\n${judgment}`;
}

/** Parse the launcher-side result.md; returns undefined when line 1 is not a valid verdict line. */
export function parseVerdictArtifact(raw: string): { verdict: AdvisorVerdict; judgment: string } | undefined {
	const m = raw.trim().match(/^VERDICT:\s*(PROCEED|REDIRECT|STOP)\s*\n([\s\S]+)$/);
	if (!m) return undefined;
	const judgment = m[2].trim();
	if (!judgment) return undefined;
	return { verdict: m[1].toUpperCase() as AdvisorVerdict, judgment };
}
