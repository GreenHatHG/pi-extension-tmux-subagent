/**
 * Verification hard gate (main session only). When verification is enabled in config, non-trivial
 * changes must end with an independent verification verdict. Enforcement is code, not prompt: the
 * gate injects a nudge user-message (pi.sendUserMessage) that makes the model run the verification
 * tool (or fix and re-verify). After nudgeLimit nudges for the same change set the gate stops and
 * escalates loudly to the user instead of silently passing.
 *
 * Two loop brakes, both code (the model has no say in them):
 * - PASS freeze: a PASS/PARTIAL verdict remembers the files it covered. Editing one of them voids
 *   that verdict, and the gate says so once, because the classic waste is "one more nit" right
 *   after a PASS — which scraps a clean verification and buys another full round.
 * - FAIL streak limits: consecutive FAIL verdicts first get a triage warning (soft limit: is the
 *   remainder part of the task, or an observation?), then stop the fix/verify loop entirely and
 *   hand the decision to the user (hard limit). The hard limit is enforced twice: on the settle
 *   nudge below, and at the verification tool's spawn (see brakeBeforeSpawn) — a round can start
 *   without the session ever settling, which is how a loop escapes a settle-only brake.
 *
 * WHEN the gate fires — completion order, not file order: while a watchdog drives the session, a
 * work-turn settle only means "this turn ended", not "the task is done" (the watchdog keeps the
 * model going, and a stream drop mid-task also settles). So the gate stays silent on those settles
 * and waits for the watchdog's done signal (`watchdog:stopped` with reason "ai-stop"), then demands
 * verification on that settle. Without a watchdog (or after it stopped / hit its cap) the settle is
 * the only completion signal left, so the gate falls back to demanding verification there.
 *
 * The ledger (what changed, what verdicts came back, how many nudges were spent) lives in session
 * custom entries (pi.appendEntry, customType "verification-gate"), so it survives /reload and
 * session resume: session_start replays the entries to rebuild state.
 *
 * Facts recorded, not claims: changes are recorded from successful write/edit tool results (the
 * file's mtime at that moment), never from tool_call intents and never from the model's own
 * description of what it changed.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isEditToolResult, isWriteToolResult } from "@earendil-works/pi-coding-agent";
import { FAIL_HARD_LIMIT, FAIL_SOFT_LIMIT, resolveVerification } from "../core/config";
import { onEvent } from "../registry";

/** customType for this gate's session entries. */
const ENTRY_TYPE = "verification-gate";

/**
 * Every message this gate injects starts with this, so the transcript shows what came from the
 * gate and not from the user. (Telling human input apart uses the `input` event's source, not
 * this prefix.)
 */
const GATE_PREFIX = "[verification gate]";

/** One line in the gate's ledger, persisted as a custom entry. */
type LedgerEntry =
	| { kind: "change"; path: string; mtime: number }
	| { kind: "verifier"; artifactPath: string; fingerprint: string }
	| {
			kind: "verdict";
			fingerprint: string;
			verdict: "PASS" | "FAIL" | "PARTIAL";
			artifactPath: string;
			/** Files the verdict covered (a PASS freezes them). Older entries carry no list. */
			paths?: string[];
	  }
	| { kind: "freeze-warn"; path: string; fingerprint: string }
	| { kind: "escalate"; streak: number }
	| { kind: "nudge"; fingerprint: string; count: number }
	/** A human input restarted the FAIL budget. */
	| { kind: "grant" };

/** A pending change: path + the mtime observed when the write/edit succeeded. */
interface PendingChange {
	path: string;
	mtime: number;
}

/** In-memory ledger, rebuilt from session entries on session_start. */
export interface GateState {
	/** Changes not yet covered by a PASS/PARTIAL verdict. */
	pending: PendingChange[];
	/** Nudge counts per fingerprint (cleared for a fingerprint when its verdict lands). */
	nudges: Map<string, number>;
	/** The verifier run started for the current pending set, if any ("" = not started). */
	verifierArtifactPath: string;
	/** Fingerprint of the pending set the current verifier was spawned for ("" = none). */
	verifierFingerprint: string;
	/** The pending set as it stood when the verifier was spawned (the verdict only covers this). */
	verifierSnapshot: PendingChange[];
	/** Files a PASS/PARTIAL verdict covered (path -> that verdict's fingerprint). */
	frozen: Map<string, string>;
	/** Frozen files already warned about (path -> the verdict fingerprint the warning was for). */
	frozenWarned: Map<string, string>;
	/** Consecutive FAIL verdicts (PASS resets it; PARTIAL neither adds nor resets). */
	failStreak: number;
	/** The failStreak value the gate last escalated at (0 = never). */
	escalatedAt: number;
}

function emptyState(): GateState {
	return {
		pending: [],
		nudges: new Map(),
		verifierArtifactPath: "",
		verifierFingerprint: "",
		verifierSnapshot: [],
		frozen: new Map(),
		frozenWarned: new Map(),
		failStreak: 0,
		escalatedAt: 0,
	};
}

/** Test-only: a fresh ledger state (the module keeps its real state private). */
export function emptyStateForTest(): GateState {
	return emptyState();
}

/** Wipe a ledger in place (replay starts from empty; also handy in tests). */
export function resetState(s: GateState): void {
	s.pending = [];
	s.nudges.clear();
	s.verifierArtifactPath = "";
	s.verifierFingerprint = "";
	s.verifierSnapshot = [];
	s.frozen.clear();
	s.frozenWarned.clear();
	s.failStreak = 0;
	s.escalatedAt = 0;
}

/**
 * Identity of a change set: path+mtime pairs, sorted, hashed. mtime (not just the path set) is
 * load-bearing: re-writing the same file must produce a new fingerprint, or a fix-after-FAIL that
 * touches the same files would look "already handled" and the gate would pass it unverified.
 */
export function fingerprintOf(pending: PendingChange[]): string {
	const canonical = [...pending].sort((a, b) => a.path.localeCompare(b.path)).map((c) => `${c.path}:${c.mtime}`);
	return createHash("sha256").update(canonical.join("\n")).digest("hex").slice(0, 16);
}

/** The number of distinct files in the pending set (the non-trivial threshold counts files). */
function distinctFileCount(pending: PendingChange[]): number {
	return new Set(pending.map((c) => c.path)).size;
}

/** The "triage before fixing again" note, shared by the settle nudge and the tool-entry brake. */
function triageNote(streak: number): string {
	return `The last ${streak} rounds came back FAIL. Triage before fixing again: does each remaining failure break the original task, or is it an observation you can record and leave? Fix only the first kind.`;
}

/** Parse the verdict line out of a verifier report (last `VERDICT: X` line wins). */
export function parseVerdict(report: string): "PASS" | "FAIL" | "PARTIAL" | undefined {
	const matches = [...report.matchAll(/^VERDICT:\s*(PASS|FAIL|PARTIAL)\s*$/gm)];
	const last = matches.at(-1);
	return last?.[1] as "PASS" | "FAIL" | "PARTIAL" | undefined;
}

/** Apply one ledger line to state. Exported for tests; replay uses it too. */
export function applyLedger(s: GateState, entry: LedgerEntry): void {
	if (entry.kind === "change") {
		s.pending.push({ path: entry.path, mtime: entry.mtime });
	} else if (entry.kind === "verifier") {
		s.verifierArtifactPath = entry.artifactPath;
		s.verifierFingerprint = entry.fingerprint;
		// Snapshot what the verifier will see: edits made while it runs are NOT covered by its verdict.
		s.verifierSnapshot = s.pending.map((c) => ({ ...c }));
	} else if (entry.kind === "verdict") {
		// Older entries carry no path list: fall back to what the verifier actually saw
		const covered = entry.paths ?? s.verifierSnapshot.map((c) => c.path);
		if (entry.verdict === "PASS" || entry.verdict === "PARTIAL") {
			// Freeze what this verdict cleared: an edit there voids it
			for (const path of covered) {
				s.frozen.set(path, entry.fingerprint);
				s.frozenWarned.delete(path);
			}
			const seen = new Set(s.verifierSnapshot.map((c) => `${c.path}:${c.mtime}`));
			s.pending = s.pending.filter((c) => !seen.has(`${c.path}:${c.mtime}`));
		}
		// Only FAIL grows the streak: PARTIAL is neither progress nor a failed round
		if (entry.verdict === "FAIL") s.failStreak += 1;
		else if (entry.verdict === "PASS") {
			s.failStreak = 0;
			s.escalatedAt = 0;
		}
		s.verifierArtifactPath = "";
		s.verifierFingerprint = "";
		s.verifierSnapshot = [];
		s.nudges.delete(entry.fingerprint);
	} else if (entry.kind === "freeze-warn") {
		s.frozenWarned.set(entry.path, entry.fingerprint);
	} else if (entry.kind === "escalate") {
		s.escalatedAt = entry.streak;
	} else if (entry.kind === "grant") {
		// A human input is a new budget: the loop may start over on purpose
		s.failStreak = 0;
		s.escalatedAt = 0;
	} else {
		s.nudges.set(entry.fingerprint, entry.count);
	}
}

/** Verdict of the tool-entry brake: start this round, or refuse and hand it to the user. */
export interface SpawnBrake {
	blocked: boolean;
	/** When blocked: the text to return as the tool result. */
	message?: string;
	/** When blocked and the user was warned just now (once per streak): the warning line. */
	warning?: string;
	/** When open and the FAIL streak passed the soft limit: note to hand to the model. */
	triage?: string;
}

export interface VerificationGate {
	/** The live ledger (for the tool to read, e.g. to list pending files). */
	readonly state: GateState;
	/**
	 * Brake at the one place a verification round can start. The settle-driven nudge cannot see a
	 * loop that never settles (blocking inside bash for 20 minutes, fix, next round): the FAIL
	 * streak is therefore also checked here. A human input restarts the budget, so the brake is
	 * not a dead end.
	 */
	brakeBeforeSpawn(): SpawnBrake;
	/** Mark the current pending set as covered by a running verifier (called by the tool). */
	recordVerifierStarted(artifactPath: string): void;
	/**
	 * Look for a verdict in the current verifier's report and record it. Returns the verdict found
	 * (and recorded), or undefined when nothing is running, the report is missing, or it has no
	 * parseable verdict line yet. Pass `expectedArtifactPath` to record only if the running
	 * verifier is still the one that wrote that report (a newer spawn replaces it).
	 */
	recordVerdictFromReport(expectedArtifactPath?: string): "PASS" | "FAIL" | "PARTIAL" | undefined;
}

/**
 * The hard gate. Always registered (so off→on needs no restart); the config's `enabled` flag is
 * read at decision time, not load time.
 */
export function setupVerificationGate(pi: ExtensionAPI): VerificationGate {
	const state = emptyState();

	// Watchdog coordination (runtime only, never in the ledger). watchdogSeen = a pi-watchdog has
	// spoken in this session (state broadcast or a stopped signal); watchdogRunning = its last
	// state said it is actively driving continuations; aiDeclaredDone = the done signal arrived
	// and the settle that carries it has not been processed yet.
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
	// changed nothing). mtime is read at result time, so the fingerprint moves on every rewrite.
	onEvent(
		pi,
		"tool_result",
		{
			where: "session/verification-gate.ts:change recorder",
			note: "Record successful write/edit results as pending changes for the verification gate",
		},
		(event: unknown) => {
			const e = event as { toolName?: string; isError?: boolean; input?: Record<string, unknown> };
			if (e.isError) return;
			const isEdit = isEditToolResult(event as never);
			const isWrite = isWriteToolResult(event as never);
			if (!isEdit && !isWrite) return;
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
			// A verdict that covered this file is void now: say it once, so the model stops polishing
			const frozenAt = state.frozen.get(filePath);
			if (!resolveVerification().enabled || !frozenAt) return;
			if (state.frozenWarned.get(filePath) === frozenAt) return;
			record({ kind: "freeze-warn", path: filePath, fingerprint: frozenAt });
			pi.sendUserMessage(
				`[verification gate] ${filePath} was covered by a PASS/PARTIAL verdict and just changed, so that verdict no longer covers it — the whole change set needs a fresh verification run. After a PASS, nits and observations belong in a TODO or in the report to the user, not in another in-place edit.`,
				{ deliverAs: "followUp" },
			);
		},
	);

	// The demand itself, shared by both trigger paths (post-done settle and fallback settle).
	function demandVerification(ctx: ExtensionContext): void {
		const cfg = resolveVerification();
		if (!cfg.enabled) return;
		if (state.pending.length === 0) return;
		const distinct = distinctFileCount(state.pending);
		if (distinct < cfg.minChangedFiles) return;

		const fingerprint = fingerprintOf(state.pending);
		const spent = state.nudges.get(fingerprint) ?? 0;
		const paths = [...new Set(state.pending.map((c) => c.path))].join(", ");
		const verifierNote = state.verifierArtifactPath
			? `You already started a verification run: read its result at ${state.verifierArtifactPath} and act on the verdict.`
			: `Run the verification tool now with the original task and these changed files: ${paths}.`;

		// Hard FAIL limit: stop the loop and let the user decide
		if (state.failStreak >= FAIL_HARD_LIMIT) {
			// Already escalated for this streak: stay quiet instead of quietly restarting the loop
			if (state.escalatedAt === state.failStreak) return;
			record({ kind: "escalate", streak: state.failStreak });
			ctx.ui.notify(
				`verification gate: ${state.failStreak} verification rounds FAILED in a row — automatic fix/verify loop stopped, the user decides (changes: ${paths})`,
				"warning",
			);
			pi.sendUserMessage(
				`[verification gate] The last ${state.failStreak} verification rounds came back FAIL. Stop fixing: report to the user what still fails, split it into what the original task requires vs. what is an observation, and ask how to proceed. Do not start another fix/verify round on your own.`,
				{ deliverAs: "followUp" },
			);
			return;
		}

		// Soft FAIL limit: same loop, but triage before spending another round on it
		const triage = state.failStreak >= FAIL_SOFT_LIMIT ? ` ${triageNote(state.failStreak)}` : "";

		if (spent >= cfg.nudgeLimit) {
			// Never silently pass: at the limit the gate escalates to the user and stops nudging.
			ctx.ui.notify(
				`verification gate: ${distinct} changed file(s) still unverified after ${spent} nudges — automatic enforcement stopped, decide yourself (changes: ${paths})`,
				"warning",
			);
			return;
		}

		record({ kind: "nudge", fingerprint, count: spent + 1 });
		pi.sendUserMessage(
			`[verification gate] This turn changed ${distinct} file(s) (${paths}) but nothing verified them before you settled. ${verifierNote} Do not report completion until a verifier verdict (VERDICT: PASS or PARTIAL) covers these changes.${triage} (nudge ${spent + 1}/${cfg.nudgeLimit})`,
			{ deliverAs: "followUp" },
		);
	}

	// Watchdog lifecycle in: track whether a watchdog is driving, and catch the done signal.
	// These are pi.events bus channels (pi-watchdog publishes via pi.events.emit), NOT pi.on
	// lifecycle events: the runner only dispatches pi.on events, so onEvent() would never hear
	// them — the two transports are disjoint even though the channel names look alike.
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

	onEvent(
		pi,
		"agent_settled",
		{
			where: "session/verification-gate.ts:hard gate",
			note: "On the post-done settle (or any settle without a watchdog) with unverified non-trivial changes: nudge verification (escalate after nudgeLimit)",
		},
		async (_event: unknown, ctx: ExtensionContext) => {
			// The settle right after a done signal is THE completion settle: act on it.
			const doneSettle = aiDeclaredDone;
			aiDeclaredDone = false;
			// A watchdog-driven session: other settles are mid-task (the watchdog keeps the model
			// going; a stream drop also settles), so the gate waits for the done. No watchdog, or a
			// stopped/napped one: the settle is the only completion signal left, fall back to it.
			if (!doneSettle && watchdogSeen && watchdogRunning) return;
			demandVerification(ctx);
		},
	);

	// The brake's escape hatch: real human input (typed in the TUI, or sent by a remote client)
	// restarts the FAIL budget. pi tags the source, so an extension injecting a user message —
	// this gate's own nudge, the watchdog, goal-mode's "keep going" — can never be mistaken for
	// the user deciding, and an injection landing after the human's word cannot swallow it.
	onEvent(
		pi,
		"input",
		{
			where: "session/verification-gate.ts:grant",
			note: "Human input restarts the FAIL budget so the tool-entry brake is never a dead end (extension-sourced input is ignored)",
		},
		(event: unknown) => {
			const e = event as { source?: string } | undefined;
			if (e?.source === "extension") return;
			record({ kind: "grant" });
		},
	);

	onEvent(
		pi,
		"session_start",
		{
			where: "session/verification-gate.ts:replay",
			note: "Rebuild the verification gate ledger from session entries on start/resume/reload, then sync watchdog state",
		},
		(_event: unknown, ctx: ExtensionContext) => {
			replay(ctx);
			// Sync the watchdog coordination flags: a resumed session starts blind, and the query
			// makes a loaded watchdog re-broadcast its state synchronously.
			pi.events.emit("watchdog:state:query", {});
		},
	);

	return {
		state,
		brakeBeforeSpawn(): SpawnBrake {
			if (state.failStreak < FAIL_HARD_LIMIT) {
				return state.failStreak >= FAIL_SOFT_LIMIT
					? { blocked: false, triage: triageNote(state.failStreak) }
					: { blocked: false };
			}

			const escalated = state.escalatedAt !== state.failStreak;
			if (escalated) record({ kind: "escalate", streak: state.failStreak });
			return {
				blocked: true,
				message: `${GATE_PREFIX} Not starting another verification round: the last ${state.failStreak} rounds came back FAIL (hard limit ${FAIL_HARD_LIMIT}). Stop fixing. Report to the user what still fails, split it into what the original task requires vs. what is an observation, and ask how to proceed. The brake lifts on the next reply from the user.`,
				warning: escalated
					? `verification: ${state.failStreak} rounds FAILED in a row — refusing to start another verifier, the user decides`
					: undefined,
			};
		},
		recordVerifierStarted(artifactPath: string): void {
			record({ kind: "verifier", artifactPath, fingerprint: fingerprintOf(state.pending) });
		},
		recordVerdictFromReport(expectedArtifactPath?: string) {
			const artifactPath = state.verifierArtifactPath;
			if (!artifactPath) return undefined;
			if (expectedArtifactPath && expectedArtifactPath !== artifactPath) return undefined;
			if (!existsSync(artifactPath)) return undefined;
			const report = readFileSync(artifactPath, "utf8");
			const verdict = parseVerdict(report);
			if (!verdict) return undefined;
			record({
				kind: "verdict",
				// The fingerprint captured at spawn time, not now: the pending set may have grown while
				// the verifier ran, and those newer changes are not covered by this verdict.
				fingerprint: state.verifierFingerprint || fingerprintOf(state.pending),
				verdict,
				artifactPath,
				// Exactly what the verifier saw; a PASS on it freezes these files
				paths: state.verifierSnapshot.map((c) => c.path),
			});
			return verdict;
		},
	};
}
