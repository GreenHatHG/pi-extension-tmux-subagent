/** Brief templates for the three modes: each template is the sub-agent's only source of context. */
import { SOCKET } from "../core/tmux";
import type { VccSummary } from "./vcc";

/**
 * Optional inputs for a brief: used by the advisor forensics section (task / web-research ignore it).
 * sessionFile = absolute path to the main session's (executor's) jsonl; vccCli = the pi-vcc CLI
 * command; vccSummary = the vcc compressed summary pre-generated at advisor start.
 */
export interface BriefOpts {
	sessionFile?: string;
	vccCli?: string;
	vccSummary?: VccSummary;
}

/** The watchdog interactive path needs an explicit wrap-up; the batch path skips this section. */
function buildCompletionSection(useWatchdog: boolean): string {
	if (!useWatchdog) return "";
	return `
## Wrap up
- When everything is done (deliverable written, nothing else to output), call watchdog_decide as your last action
`;
}

/** useWatchdog = wrap up via watchdog_decide (false = pi -p, which exits on its own, no wrap-up action). */
export function buildTaskBrief(
	question: string,
	context: string | undefined,
	artifactPath: string,
	useWatchdog: boolean,
): string {
	const completion = buildCompletionSection(useWatchdog);
	return `# Task brief

## Goal
${question}

## Known context (from the main session; this brief is your only source of context)
${context?.trim() || "(none)"}

## Deliverable
- Write the deliverable to ${artifactPath}: conclusions first, keep it tight, add a source URL to each item (when it applies), mark anything unverified
${completion}
## Boundaries
- Don't delegate to a new sub-agent (spawn_sub): you are the one executing the brief; delegation belongs to the main session only
- tmux, if you use it at all: read-only inspection on -L ${SOCKET} (capture-pane/has-session/ls); never kill anything, and never touch the default tmux server`;
}

/** Stable list of recall CLI usage. */
const recallCliGuide = (vccCli: string, sessionFile: string): string =>
	`  - Search: \`${vccCli} recall ${sessionFile} <keywords>\` (multiple words are ranked by relevance; hits show only a local snippet)\n  - More usage: \`${vccCli} --help\` (only when the line above is not enough — don't explore just to read the manual)`;

/** Advisor forensics section (falls back by availability: pre-generated summary > recall CLI > session file only). */
function buildAdvisorForensics(opts?: BriefOpts): string {
	const sessionFile = opts?.sessionFile;
	if (!sessionFile) {
		return `## Raw session forensics
- The main session is not on disk yet, so there is no forensics this time. You must verify the load-bearing premises in the background claims yourself with read / read-only shell; if you can't, mark it "unverified" in your reply and do not accept it by default.
- If you need raw context, state the gap in your reply and the main session will fill it.

`;
	}

	const vccCli = opts?.vccCli;
	if (!vccCli) {
		return `## Raw session forensics
- Session file: ${sessionFile} (advisor.vccCli is not set, so there is no recall CLI / pre-generated summary)
- You must verify the load-bearing premises in the background claims yourself with read / read-only shell; if you can't, mark it "unverified" in your reply and do not accept it by default. When you need raw context, state the gap in your reply and the main session will fill it.

`;
	}

	const guide = recallCliGuide(vccCli, sessionFile);
	const summary = opts?.vccSummary;
	if (!vccSummaryOk(summary)) {
		return `## Raw session forensics (recall CLI, read-only)
- Summary pre-generation failed, so there is no compressed summary to read directly: the main session's summary in this brief may miss command output, raw errors and timing details. When you suspect a gap, run the recall CLI with bash to recover it:
${guide}
  - You can also run \`${vccCli} compact ${sessionFile}\` yourself to see the whole session's compressed summary (stdout only, no --write)
- Session file: ${sessionFile}
- Verify the load-bearing premises in the background claims; if you can't, mark it "unverified" in your reply and do not accept it by default.

`;
	}

	return `## Raw session forensics (vcc compressed summary + recall CLI, read-only; default evidence)
- Step 1 (default): read ${summary.path}. It is the whole session's vcc compressed summary, pre-generated when advisor started (the full picture of steps, commands and conclusions so far), and it is an independent view that is neutral to the requester's framing — read it first for any non-trivial consultation
- Step 2 — add detail as needed: the summary may still truncate command output / raw errors. When you suspect a gap, run the recall CLI with bash to search the main session's full record:
${guide}
- Session file: ${sessionFile}
- When the summary/forensics conflicts with the background claims (hand-written by the main session): trust the summary and forensics, and call the conflict itself out in your reply — it is often the real problem

`;
}

/**
 * Advisor mode brief template (wants judgment, not execution). Forensics section: see
 * buildAdvisorForensics; the watchdog path adds a run profile and the suggested result.md structure.
 */
export function buildAdvisorBrief(
	question: string,
	context: string | undefined,
	artifactPath: string,
	useWatchdog: boolean,
	opts?: BriefOpts,
): string {
	const tools = useWatchdog ? "read/write/watchdog_decide/bash" : "read/write/bash";
	const finish = useWatchdog
		? ", then call watchdog_decide to finish"
		: " (batch mode: ends as soon as it is written, no other wrap-up action)";
	const forensics = buildAdvisorForensics(opts);
	return `# Consultation brief

## Question
${question}

## Claims under audit (provided by the main session; these are the requester's claims, not established facts — their load-bearing premises may be unverified, or may be the very error under review)
${context?.trim() || "(none)"}

## What to do
- Give a judgment: plan (concrete next steps, in order) / correction (point out the wrong direction, redirect and explain why) / stop signal (halt and escalate to the user)
- Conclusions first, keep it tight; name files/functions/line numbers; mark anything unverified
- Audit the claims first: treat the background above as "claims under audit", not facts; find the load-bearing premises (the ones that would change your judgment if false) and verify each one
- Forensics is the default evidence, not a bonus: if the forensics section has a pre-generated vcc session summary (below), read it first for any non-trivial consultation — it is a neutral compression of what actually happened, independent of the requester's framing. When the summary conflicts with the background claims, trust the forensics and call the conflict out in your reply (it is often the real problem)
- Load-bearing premises must be verified: if your judgment depends on an empirical claim (how a command/tool really behaves or what it prints, whether an API works, what a file really contains) and neither forensics nor read settles it, verify it yourself with read-only tools (prefer the least invasive probe: read the source/docs, --help, a dry-run); if you can't, mark it "unverified" in your reply and say how your judgment depends on it; never accept it by default
- Read files only when you need to verify a claim or fill a gap; make no real changes (write is for the deliverable only)

${forensics}
## Deliverable
- Write the full advice to ${artifactPath}${finish}
- Suggested structure (so the main session can act on it directly): judgment (plan / correction / stop signal) -> verified key facts (name file:line for each) -> a direct answer to each question -> an ordered execution plan -> unverified items

## Boundaries
- Your tools are only ${tools}, by design: you judge, the main session executes`;
}

/** vccSummary exists and succeeded. */
function vccSummaryOk(s?: VccSummary): s is VccSummary {
	return s?.ok === true;
}

/** Web-research mode brief template. */
export function buildWebResearchBrief(
	question: string,
	context: string | undefined,
	artifactPath: string,
	useWatchdog: boolean,
): string {
	const today = new Date().toISOString().slice(0, 10);
	const completion = buildCompletionSection(useWatchdog);
	return `# Web research brief

## Question
${question}

## Known context (from the main session; this brief is your only source of context)
${context?.trim() || "(none)"}

## Current date
${today} (use it to judge freshness and the recencyFilter value)

## Tool strategy
- Do all web work with the web tools in your tool list (provided by pi-web-access)
- fetch defaults to readable (the answer mode is disabled), so you read the pages yourself; fetch only the pages you will cite
- Don't read long content whole: locate a single fact with the retrieval tool's findText, and fetch a full body by responseId
- If this session has no web tools at all, web bootstrap failed: write the failure reason into the deliverable and stop at once; don't try other ways to get online

## Deliverable
- Write conclusions to ${artifactPath}: conclusions first, add a source URL to each item, mark anything unverified
${completion}
## Boundaries
- Use bash only for auxiliary search/retrieval work (e.g. processing tool output text); never as a way to get online
- tmux, if you use it at all: read-only inspection on -L ${SOCKET}; never kill anything, and never touch the default tmux server`;
}
