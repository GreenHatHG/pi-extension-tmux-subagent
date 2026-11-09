/** Brief templates for the remaining modes: each template is the sub-agent's only source of context.
 * (advisor no longer goes through this flow: it forks the main session's transcript, see launch/advisor-fork.ts) */
import { WATCHDOG_TOOL } from "../completion/profile";
import { SOCKET } from "../core/tmux";

/** The watchdog interactive path needs an explicit wrap-up; the batch path skips this section. */
function buildCompletionSection(useWatchdog: boolean): string {
	if (!useWatchdog) return "";
	return `
## Wrap up
- When everything is done (deliverable written, nothing else to output), call ${WATCHDOG_TOOL} with decision "done" as your last action
- If a watchdog check reaches you before you are done, answer it with ${WATCHDOG_TOOL} decision "continue" so the next turn carries on with the task; text is not an answer there
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

/** useWatchdog = wrap up via watchdog_decide (false = pi -p, which exits on its own, no wrap-up action). */
export function buildVerificationBrief(
	question: string,
	context: string | undefined,
	artifactPath: string,
	useWatchdog: boolean,
): string {
	const tools = useWatchdog ? `read/bash/write/edit/${WATCHDOG_TOOL}` : "read/bash/write/edit";
	const finish = useWatchdog
		? `, then call ${WATCHDOG_TOOL} with decision "done" to finish`
		: " (batch mode: ends as soon as it is written, no other wrap-up action)";
	return `# Verification brief

## Original task (what the implementer was asked to do)
${question}

## What the implementer says changed (their claim, not a fact — your job is to break it)
${context?.trim() || "(none given — inspect the repo yourself)"}

## Scope (settle it before you start)
- In scope: the original task above, plus regressions this change introduced in the code it touches. Nothing else.
- Out of scope: defects that predate the change, hypothetical setups (older tool versions, exotic filesystems, symlinked or hostile paths, concurrent sessions), and hardening nobody asked for. These belong in Observations, not in the verdict.
- Stop when the task's own behavior and its regressions are covered: probing past that buys latency, not safety.

## What to do
- Verify independently: run the build, tests, linters, and exercise the change yourself per your system prompt; every PASS needs a real command run block
- Try to break it: boundary values, error paths, idempotency, regressions — the happy path proves nothing
- Promise audit (diff files only, not the whole tree): from each changed file's docstring/comments, extract the behavior verbs it promises (e.g. "kills the session", "sends the signal", "writes the file", "retries", "cleans up") and, for each, point at the exact line that implements it. A promise with no implementing line is a FAIL, not an observation — this is where silent omissions live (a comment saying "kill-session" with no kill call)
- Do NOT share the implementer's own test results as evidence; treat them as claims to re-check

## What a FAIL means here
- The three verdicts mean exactly this:
  - PASS = the original task is met, nothing blocking found
  - PARTIAL = the task is met, but something is explicitly not covered or rests on an assumption you must state in the report
  - FAIL = the task is not met, or the change introduced a regression, data loss, or a crash path in the shipped code
- PARTIAL is NOT a soft FAIL: a PARTIAL still lets the main session finish, so use it for "verified, with these limits", never for "this is broken".
- Everything that is not one of the three above goes under \`## Observations (non-blocking)\` and must NOT move the verdict: predates the change, out of scope, or an edge case you could not hit in a normal setup.
- A FAIL must name the part of the original task it breaks. When everything you can point at is an observation, the verdict is PASS with those observations listed.

## Deliverable
- Write the full verification report to ${artifactPath} with the write tool — your writes are fenced to exactly this one file, anywhere else is blocked${finish}
- Sections in order: what you ran and what it printed -> per-check result -> \`## Observations (non-blocking)\` (always present, write "none" if empty) -> the verdict line
- The report MUST end with exactly one line: \`VERDICT: PASS\`, \`VERDICT: FAIL\`, or \`VERDICT: PARTIAL\` (parsed by the main session)
- Wrap-up gate: finishing without a non-empty report marks this run failed (exit 98) — always write the report first, then call done

## Boundaries
- Your tools are only ${tools}, by design: you verify, the main session fixes
- Never modify files in the project directory, never install dependencies, never run git write operations (the write fence enforces the deliverable path; temp-dir test scripts via bash are fine)`;
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
