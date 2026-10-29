/**
 * verification tool (main session, registered unconditionally). Spawns an adversarial verifier
 * sub-agent (verification mode) over the existing spawn infrastructure. The hard gate
 * (session/verification-gate.ts) decides whether the model MUST call this; the tool itself only
 * runs the verifier and wires the verdict back into the gate's ledger.
 */
import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { verificationMode } from "../modes/types";
import type { VerificationGate } from "../session/verification-gate";
import { showSubagentBrief, watchSubagentReply } from "../ui/subagent-entries";
import { type LaunchFn, renderResultWithOps, startedToolResult } from "./shared";

/**
 * Poll for the verifier's completion, then feed its report to the gate. Completion order is
 * exit first, verdict second: the exit file only appears when the wrap-up ran (watchdog ON_STOP
 * or a real process exit), so a report read before it might be a stream-drop leftover the
 * verifier is about to rewrite after its own watchdog nudges it back to life.
 * Display-only, like watchSubagentReply: any failure just means the next gate settle re-checks
 * the report.
 */
const VERDICT_POLL_MS = 5_000;
const VERDICT_POLL_LIMIT = 6 * 3600_000; // same cap as the reply watcher
function watchVerifierVerdict(gate: VerificationGate, artifactPath: string, exitFile: string): void {
	const started = Date.now();
	const timer = setInterval(() => {
		// No exit file yet: the verifier has not wrapped up (or was nudged back to work after a
		// stream drop) — its report may still change, so don't record a verdict from it.
		if (!existsSync(exitFile)) {
			if (Date.now() - started <= VERDICT_POLL_LIMIT) return;
			clearInterval(timer);
			return;
		}
		// Exited: the report is final, record the verdict (or its absence — the pending set stays,
		// so the gate stays armed and nudges again if needed).
		gate.recordVerdictFromReport(artifactPath);
		clearInterval(timer);
	}, VERDICT_POLL_MS);
	timer.unref?.(); // must not hold the process open: this is bookkeeping, not the session's life support
}

/** Register the verification tool. */
export function setupVerification(pi: ExtensionAPI, gate: VerificationGate, launch: LaunchFn): void {
	pi.registerTool({
		name: "verification",
		label: "Adversarial verification",
		description: [
			"Spawn an isolated adversarial verifier sub-agent that tries to break your just-finished implementation work:",
			"it runs builds, tests, linters, and hostile inputs, and returns a report ending with VERDICT: PASS, FAIL, or PARTIAL.",
			"Pass the original user task and the files changed. The full report is written to a system-generated path",
			"(/tmp/pi-sub-<session>/result.md), whose exact value is given in the tool response.",
			"Do not put the deliverable path in `question` — the brief the verifier receives already carries it",
			"If the report is missing or empty (the verifier died silently), read the flight recorder at /tmp/pi-sub-<session>/signals.log",
			"(signals/crashes/exit events, exact path given in the tool response) to find why the process died",
		].join(" "),
		promptSnippet:
			"spawn an adversarial verifier sub-agent to independently verify non-trivial implementation before reporting done",
		promptGuidelines: [
			"verification: after non-trivial implementation (3+ file edits, backend/API changes, infrastructure changes), spawn this before reporting completion — your own checks do not substitute for independent verification.",
			"verification: pass the ORIGINAL user task in `question` and the changed file paths in `context`. On FAIL, fix, then run it again.",
			"verification: one user reply buys 3 rounds (edit -> verify -> edit -> verify -> edit -> verify). After the third round edits and rounds are refused: report to the user what is verified and what is not. A PASS lets you stop early, or use a remaining round on a real fix — never on polish.",
			"verification: a round on an unchanged tree is refused — a verdict for bytes nobody touched proves nothing. So is wrapping up while files are unverified.",
		],
		parameters: Type.Object({
			question: Type.String({
				description: "The original user task the implementation was supposed to satisfy, stated precisely",
			}),
			context: Type.Optional(
				Type.String({
					description:
						"Files changed (absolute paths), the approach taken, and any caveats. Do not paste test results or claim things work — the verifier runs its own checks",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// The tool_call brake blocks this before execute; repeat the check here so the round budget
			// holds even when a caller reaches the tool another way.
			const refusal = gate.refusalToVerify();
			if (refusal) return startedToolResult(refusal);

			// Append the gate's pending-file list so the verifier sees the fact, not the model's claim
			const pendingPaths = [...new Set(gate.state.pending.map((c) => c.path))];
			const context =
				pendingPaths.length > 0
					? `${params.context ? `${params.context}\n` : ""}Changed files: ${pendingPaths.join(", ")}`
					: params.context;
			// Writes through bash are invisible to the ledger: say so instead of letting the model read
			// a PASS on an unrecorded change set as coverage.
			const uncovered =
				pendingPaths.length === 0
					? "\n\n[verification] No write/edit was recorded in this burst, so this verdict cannot clear the gate. Changes made through bash are invisible to it."
					: "";
			const r = await launch(params.question, context, undefined, ctx.sessionManager.getSessionId());
			if (r.ok) {
				if (r.artifactPath && r.exitFile) {
					gate.recordVerifierStarted(r.artifactPath);
					watchVerifierVerdict(gate, r.artifactPath, r.exitFile);
				}
				// Brief/reply go through appendEntry to the TUI only, not into the LLM context
				showSubagentBrief(pi, r, verificationMode.display);
				watchSubagentReply(pi, r, verificationMode.display);
			}
			return startedToolResult(`${r.text}${uncovered}`, r.ops);
		},
		renderResult(result, _options, theme, _context) {
			return renderResultWithOps(result, "Verifier started (copy into any terminal to watch):", theme);
		},
	});
}
