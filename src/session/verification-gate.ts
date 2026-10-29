/**
 * Verification gate (main session only). The problem it solves: the main agent wraps up
 * implementation work and certifies it in its own head, so the user had to type "run verification"
 * by hand (20 times before this existed), and the independent verifier kept finding real FAILs.
 * The gate makes that check a fact of code, not a promise in a prompt — the verdict is parsed from
 * the verifier's report file and the changes are recorded from successful write/edit results, never
 * from the model's own summary.
 *
 * Shape: a BURST, not a nag.
 * - A burst starts on real human input. Inside one burst the model gets ROUND_LIMIT verification
 *   rounds (edit -> verify -> edit -> verify -> edit -> verify). After the last round the gate
 *   refuses further edits and further rounds; the model reports to the user, and the user's next
 *   reply opens the next burst. A PASS does not end a burst by itself — the model may decide to
 *   stop, and stop is always allowed.
 * - Enforcement is a refusal at the moment of the tool call (tool_call can block), not a queued
 *   message: a refusal is always true when it is read, costs nothing, and cannot pile up. The old
 *   design sent one message per edited file about a verdict that had already been replaced, and the
 *   queue delivered them one per turn for 23 minutes after the work was done.
 * - At most ONE message per burst, built from live state at delivery time. Nothing is pre-written,
 *   so a message can never claim "just changed" about a file nobody touched.
 *
 * The ledger (changes, rounds, verdicts, bursts) lives in session custom entries
 * (customType "verification-gate"), so /reload and resume keep the budget.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isEditToolResult, isWriteToolResult } from "@earendil-works/pi-coding-agent";
import { FAIL_SOFT_LIMIT, ROUND_LIMIT, resolveVerification, type VerificationSettings } from "../core/config";
import { resolveProcessRole } from "../core/env";
import { onEvent } from "../registry";

/** customType for this gate's session entries. */
const ENTRY_TYPE = "verification-gate";

/** Every message this gate injects starts with this, so the transcript shows its source. */
const GATE_PREFIX = "[verification gate]";

export type Verdict = "PASS" | "FAIL" | "PARTIAL";

/** A pending change: path + the mtime observed when the write/edit succeeded. */
export interface PendingChange {
	path: string;
	mtime: number;
}

/** One line in the gate's ledger, persisted as a custom entry. */
export type LedgerEntry =
	| { kind: "change"; path: string; mtime: number }
	| { kind: "verifier"; artifactPath: string }
	| { kind: "verdict"; verdict: Verdict; artifactPath: string; paths: string[] }
	/** Real human input: a new burst with a fresh round budget. */
	| { kind: "burst" }
	/** The one settle message was sent for this burst. */
	| { kind: "nudge" }
	/** The user was warned that this burst spent its rounds. */
	| { kind: "limit-warn" };

/** What the gate knows about one change set, derived from the ledger (never stored). */
export type Ticket = "none" | "dirty" | "stale" | "checked";

/** In-memory ledger, rebuilt from session entries on session_start. */
export interface GateState {
	/** 1-based; every real human input starts the next one. */
	burst: number;
	/** Verification rounds started in this burst (one per verifier spawn). */
	roundsUsed: number;
	/** Changes not yet covered by a verdict. */
	pending: PendingChange[];
	/** The verifier run in flight, if any ("" = none). */
	verifierArtifactPath: string;
	/** The pending set as it stood when the verifier was spawned (its verdict covers only this). */
	verifierSnapshot: PendingChange[];
	/** The newest verdict, or undefined when nothing was verified yet. */
	lastVerdict?: { verdict: Verdict; paths: string[]; artifactPath: string };
	/** The burst a settle message was already sent for (0 = none). */
	nudgedBurst: number;
	/** The burst the user was already warned about (0 = none). */
	warnedBurst: number;
	/** Consecutive FAIL rounds (PASS resets; PARTIAL neither adds nor resets). Drives the triage note. */
	failStreak: number;
}

function emptyState(): GateState {
	return {
		burst: 1,
		roundsUsed: 0,
		pending: [],
		verifierArtifactPath: "",
		verifierSnapshot: [],
		lastVerdict: undefined,
		nudgedBurst: 0,
		warnedBurst: 0,
		failStreak: 0,
	};
}

/** Test-only: a fresh ledger state (the module keeps its real state private). */
export function emptyStateForTest(): GateState {
	return emptyState();
}

/** Wipe a ledger in place (replay starts from empty; also handy in tests). */
export function resetState(s: GateState): void {
	Object.assign(s, emptyState());
}

/** Apply one ledger line to state. Exported for tests; replay uses it too. */
export function applyLedger(s: GateState, entry: LedgerEntry): void {
	if (entry.kind === "change") {
		s.pending.push({ path: entry.path, mtime: entry.mtime });
	} else if (entry.kind === "verifier") {
		s.roundsUsed += 1;
		s.verifierArtifactPath = entry.artifactPath;
		// Snapshot what the verifier will see: edits made while it runs are NOT covered by its verdict.
		s.verifierSnapshot = s.pending.map((c) => ({ ...c }));
	} else if (entry.kind === "verdict") {
		// Older entries carry no path list: fall back to what the verifier actually saw
		const covered = entry.paths ?? s.verifierSnapshot.map((c) => c.path);
		if (entry.verdict === "PASS" || entry.verdict === "PARTIAL") {
			const seen = new Set(s.verifierSnapshot.map((c) => `${c.path}:${c.mtime}`));
			s.pending = s.pending.filter((c) => !seen.has(`${c.path}:${c.mtime}`));
		}
		s.lastVerdict = { verdict: entry.verdict, paths: covered, artifactPath: entry.artifactPath };
		// Only FAIL grows the streak: PARTIAL is neither progress nor a failed round
		if (entry.verdict === "FAIL") s.failStreak += 1;
		else if (entry.verdict === "PASS") s.failStreak = 0;
		s.verifierArtifactPath = "";
		s.verifierSnapshot = [];
	} else if (entry.kind === "burst") {
		// A human reply is a new budget. The loop may start over on purpose.
		s.burst += 1;
		s.roundsUsed = 0;
		s.failStreak = 0;
	} else if (entry.kind === "nudge") {
		s.nudgedBurst = s.burst;
	} else {
		s.warnedBurst = s.burst;
	}
}

/** The state of the current change set: nothing, unverified, verified-then-edited, or verified. */
export function ticketOf(s: GateState): Ticket {
	if (s.pending.length === 0) return s.lastVerdict ? "checked" : "none";
	return s.lastVerdict ? "stale" : "dirty";
}

/** Distinct files in the pending set (the non-trivial threshold counts files, not writes). */
export function distinctPaths(pending: PendingChange[]): string[] {
	return [...new Set(pending.map((c) => c.path))];
}

/** Parse the verdict line out of a verifier report (last `VERDICT: X` line wins). */
export function parseVerdict(report: string): Verdict | undefined {
	const matches = [...report.matchAll(/^VERDICT:\s*(PASS|FAIL|PARTIAL)\s*$/gm)];
	const last = matches.at(-1);
	return last?.[1] as Verdict | undefined;
}

/** The "triage before fixing again" note, shared by the settle message and the tool result. */
export function triageNote(streak: number): string {
	return `The last ${streak} rounds came back FAIL. Triage before fixing again: does each remaining failure break the original task, or is it an observation you can record and leave? Fix only the first kind.`;
}

/**
 * Why a verification round must not start (undefined = allowed). Pure, so the tool and the
 * tool_call brake both read the same answer.
 */
export function refuseVerification(s: GateState, cfg: VerificationSettings): string | undefined {
	if (s.roundsUsed >= ROUND_LIMIT) {
		const last = s.lastVerdict ? ` (last verdict: ${s.lastVerdict.verdict})` : "";
		return `${GATE_PREFIX} This burst already used its ${ROUND_LIMIT} verification rounds${last}. Stop: report to the user what is verified and what is not, and ask how to proceed. A reply from the user opens a new burst.`;
	}
	if (cfg.enabled && s.pending.length === 0 && s.lastVerdict) {
		return `${GATE_PREFIX} No file changed since verdict ${s.lastVerdict.verdict} (${s.lastVerdict.artifactPath}). Another round would inspect the same bytes and prove nothing new — report instead.`;
	}
	return undefined;
}

/** Why an edit must not start (undefined = allowed). The last round of a burst closes the pen. */
export function refuseEdit(s: GateState, cfg: VerificationSettings): string | undefined {
	if (!cfg.enabled || s.roundsUsed < ROUND_LIMIT) return undefined;
	return `${GATE_PREFIX} This burst used its ${ROUND_LIMIT} verification rounds, so editing stops here: another edit would be work nobody can check. Report to the user what is verified and what still is not. A reply from the user opens a new burst.`;
}

/** Why the model must not declare done (undefined = allowed). */
export function refuseDone(s: GateState, cfg: VerificationSettings): string | undefined {
	if (!cfg.enabled) return undefined;
	// At the round limit the pen is already closed and another round is refused: blocking done too
	// would wedge the session, so the report goes out and the user sees the unverified list instead.
	if (s.roundsUsed >= ROUND_LIMIT) return undefined;
	const paths = distinctPaths(s.pending);
	if (paths.length === 0 || paths.length < cfg.minChangedFiles) return undefined;
	return `${GATE_PREFIX} ${paths.length} file(s) changed and nothing verified them: ${paths.join(", ")}. Run the verification tool now (round ${s.roundsUsed + 1} of ${ROUND_LIMIT}), then wrap up.`;
}

export interface VerificationGate {
	/** The live ledger (for the tool to read, e.g. to list pending files). */
	readonly state: GateState;
	/** Why this round must not start (undefined = allowed). Raised by the tool itself too. */
	refusalToVerify(): string | undefined;
	/** Mark the current pending set as covered by a running verifier (called by the tool). */
	recordVerifierStarted(artifactPath: string): void;
	/**
	 * Look for a verdict in the current verifier's report and record it. Returns the verdict found
	 * (and recorded), or undefined when nothing is running, the report is missing, the run covered
	 * no file at all, or it has no parseable verdict line yet. Pass `expectedArtifactPath` to record
	 * only if the running verifier is still the one that wrote that report.
	 */
	recordVerdictFromReport(expectedArtifactPath?: string): Verdict | undefined;
}

/**
 * The gate. Always registered (so off→on needs no restart); the config's `enabled` flag is read at
 * decision time, not load time. A no-op inside a sub-agent pane: the gate guards the main session's
 * completion, and its ledger must not carry a verifier's own edits.
 */
export function setupVerificationGate(pi: ExtensionAPI): VerificationGate {
	const state = emptyState();
	const isMain = resolveProcessRole().kind === "main";

	// Watchdog coordination (runtime only, never in the ledger). watchdogSeen = a pi-watchdog has
	// spoken in this session; watchdogRunning = its last state said it is actively driving
	// continuations; aiDeclaredDone = the done signal arrived and its settle is not processed yet.
	let watchdogSeen = false;
	let watchdogRunning = false;
	let aiDeclaredDone = false;

	/** Append one ledger line and apply it to the in-memory state (single source of truth). */
	function record(entry: LedgerEntry): void {
		pi.appendEntry(ENTRY_TYPE, entry);
		applyLedger(state, entry);
	}

	/** Rebuild state from session entries on start/resume/reload. */
	function replay(ctx: ExtensionContext): void {
		// Start from empty: a second session_start must not double every counter
		resetState(state);
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
				applyLedger(state, entry.data as LedgerEntry);
			}
		}
	}

	// Record real file changes: only successful write/edit results count (a blocked or failed call
	// changed nothing). mtime is read at result time, so a re-write is a distinct pending entry.
	if (isMain) {
		onEvent(
			pi,
			"tool_result",
			{
				where: "session/verification-gate.ts:change recorder",
				note: "Record successful write/edit results as pending changes (facts, never tool_call intents)",
			},
			(event: unknown) => {
				const e = event as { isError?: boolean; input?: Record<string, unknown> };
				if (e.isError) return;
				if (!isEditToolResult(event as never) && !isWriteToolResult(event as never)) return;
				const path = e.input?.path;
				if (typeof path !== "string" || !path) return;
				// One spelling per file: a relative path and its absolute form must not look like two files
				const filePath = resolve(path);
				let mtime: number;
				try {
					mtime = statSync(filePath).mtimeMs;
				} catch {
					// File gone between write and stat (deleted right after): nothing to verify for it.
					return;
				}
				record({ kind: "change", path: filePath, mtime });
			},
		);

		// Enforcement lives here: a refusal at the tool call is always true when it is read.
		onEvent(
			pi,
			"tool_call",
			{
				where: "session/verification-gate.ts:refusals",
				note: "Refuse: a verification round past the burst limit or on an unchanged tree, an edit after the last round, and done on unverified changes",
			},
			(event: unknown, ctx: ExtensionContext) => {
				const e = event as { toolName?: string; input?: Record<string, unknown> };
				const cfg = resolveVerification();
				const limitMessage = (msg: string | undefined) => {
					if (!msg) return undefined;
					// Tell the user once per burst that the machine stopped itself: silence here would
					// look like the task simply ended.
					if (state.warnedBurst !== state.burst) {
						record({ kind: "limit-warn" });
						ctx.ui.notify(
							`verification: ${ROUND_LIMIT} rounds used in this burst — automatic work stopped, the user decides (unverified: ${distinctPaths(state.pending).join(", ") || "none"})`,
							"warning",
						);
					}
					return { block: true, reason: msg };
				};
				if (e.toolName === "verification") return limitMessage(refuseVerification(state, cfg));
				if (e.toolName === "edit" || e.toolName === "write") return limitMessage(refuseEdit(state, cfg));
				if (e.toolName === "watchdog_decide") {
					if (e.input?.decision !== "done") return undefined;
					const doneMsg = refuseDone(state, cfg);
					if (doneMsg) return limitMessage(doneMsg);
					// Spent budget: the wrap-up goes through (blocking it would wedge the session), so the
					// user is the only one who can still see what stays unverified.
					const left = distinctPaths(state.pending);
					if (cfg.enabled && state.roundsUsed >= ROUND_LIMIT && left.length > 0 && state.warnedBurst !== state.burst) {
						record({ kind: "limit-warn" });
						ctx.ui.notify(
							`verification: wrapping up with ${left.length} unverified file(s) after ${ROUND_LIMIT} rounds — ${left.join(", ")}`,
							"warning",
						);
					}
					return undefined;
				}
				return undefined;
			},
		);

		// One message per burst, built from live state right now.
		onEvent(
			pi,
			"agent_settled",
			{
				where: "session/verification-gate.ts:settle message",
				note: "On the completion settle with unverified non-trivial changes: one coalesced message per burst, rendered from live state",
			},
			async (_event: unknown, _ctx: ExtensionContext) => {
				// The settle right after a done signal is THE completion settle: act on it.
				const doneSettle = aiDeclaredDone;
				aiDeclaredDone = false;
				// A watchdog-driven session: other settles are mid-task (the watchdog keeps the model
				// going; a stream drop also settles), so the gate waits for the done. No watchdog, or a
				// stopped/napped one: the settle is the only completion signal left, fall back to it.
				if (!doneSettle && watchdogSeen && watchdogRunning) return;

				const cfg = resolveVerification();
				if (!cfg.enabled) return;
				if (state.nudgedBurst === state.burst) return;
				// A spent burst already refused edits and rounds: another message adds nothing
				if (state.roundsUsed >= ROUND_LIMIT) return;
				const paths = distinctPaths(state.pending);
				if (paths.length < cfg.minChangedFiles) return;

				record({ kind: "nudge" });
				const ticket = ticketOf(state);
				const where = state.verifierArtifactPath
					? `You already started a round: read its report at ${state.verifierArtifactPath}.`
					: `Run the verification tool now with the original task and these files: ${paths.join(", ")} (round ${state.roundsUsed + 1} of ${ROUND_LIMIT}).`;
				const stale =
					ticket === "stale"
						? ` These files changed after verdict ${state.lastVerdict?.verdict}, so that verdict no longer covers them.`
						: "";
				const triage = state.failStreak >= FAIL_SOFT_LIMIT ? ` ${triageNote(state.failStreak)}` : "";
				pi.sendUserMessage(
					`${GATE_PREFIX} ${paths.length} changed file(s) are unverified: ${paths.join(", ")}.${stale} ${where} Do not report completion until a verdict covers them.${triage}`,
					{ deliverAs: "followUp" },
				);
			},
		);

		// A burst starts on real human input and only on that. pi tags the source, so an extension
		// injecting a user message (the watchdog, goal-mode, this gate's own message) never refills
		// the budget, and an injection landing after the human's word cannot swallow it.
		onEvent(
			pi,
			"input",
			{
				where: "session/verification-gate.ts:burst",
				note: "Human input opens a new burst with a fresh round budget (extension-sourced input is ignored)",
			},
			(event: unknown) => {
				const e = event as { source?: string } | undefined;
				if (e?.source === "extension") return;
				record({ kind: "burst" });
			},
		);

		onEvent(
			pi,
			"session_start",
			{
				where: "session/verification-gate.ts:replay",
				note: "Rebuild the ledger from session entries on start/resume/reload, then sync watchdog state",
			},
			(_event: unknown, ctx: ExtensionContext) => {
				replay(ctx);
				// Sync the watchdog coordination flags: a resumed session starts blind, and the query
				// makes a loaded watchdog re-broadcast its state synchronously.
				pi.events.emit("watchdog:state:query", {});
			},
		);
	}

	pi.events.on("watchdog:state", (event: unknown) => {
		watchdogSeen = true;
		const e = event as { running?: boolean } | undefined;
		watchdogRunning = e?.running === true;
	});
	pi.events.on("watchdog:stopped", (event: unknown) => {
		watchdogSeen = true;
		const e = event as { reason?: string } | undefined;
		if (e?.reason === "ai-stop") aiDeclaredDone = true;
	});

	return {
		state,
		refusalToVerify() {
			return refuseVerification(state, resolveVerification());
		},
		recordVerifierStarted(artifactPath: string): void {
			record({ kind: "verifier", artifactPath });
		},
		recordVerdictFromReport(expectedArtifactPath?: string) {
			if (!isMain) return undefined;
			const artifactPath = state.verifierArtifactPath;
			if (!artifactPath) return undefined;
			if (expectedArtifactPath && expectedArtifactPath !== artifactPath) return undefined;
			if (!existsSync(artifactPath)) return undefined;
			// A round that covered no file proves nothing: recording it would clear the pending set
			// against an empty change set (the "PASS with paths: []" bug).
			if (state.verifierSnapshot.length === 0) return undefined;
			const report = readFileSync(artifactPath, "utf8");
			const verdict = parseVerdict(report);
			if (!verdict) return undefined;
			record({
				kind: "verdict",
				verdict,
				artifactPath,
				// Exactly what the verifier saw; edits made while it ran are not covered
				paths: state.verifierSnapshot.map((c) => c.path),
			});
			return verdict;
		},
	};
}
