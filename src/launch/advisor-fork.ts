/**
 * Fork-based advisor launch: instead of a brief + fresh session, the advisor pane runs
 * `pi --fork <main-session.jsonl>` so the advisor model reads the main session's full verbatim
 * history (all tool inputs/outputs), then answers ONE round: a judgment delivered through the
 * submit_verdict tool (src/launch/verdict-extension.ts), whose handler is the whole completion
 * protocol: validate -> write result.md -> exit 0 -> done signal -> kill-session.
 *
 * Differences from launchSub: no brief file, no vcc forensics, and the plugin waits inside the
 * tool call. The pane loads --no-extensions plus only the verdict extension, so watchdog_decide
 * (and every other wrap-up channel) does not exist there and cannot race the verdict tool.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isWatchdogAvailable } from "../completion/profile";
import { ENV_SUB_EXIT_FILE } from "../core/env";
import { kebab, resolvePaths, type SubagentPaths, shortId } from "../core/paths";
import { runTmux, SOCKET, shQuote, styleSubagentSession } from "../core/tmux";
import { type AdvisorVerdict, parseVerdictArtifact } from "./verdict";

/** Hard cap on the advisor run; the whole design is "one round, direct control", so a hung judge is killed. */
export const ADVISOR_TIMEOUT_MS = 1800_000;

/** Max guidance re-prompts after a run that ended without a submit_verdict call. */
export const MAX_VERDICT_NUDGES = 3;

/** Judgment prompt submitted as the forked pane's first user message (positional pre-fill). */
export function buildConsultationPrompt(): string {
	return [
		"You are the advisor. The transcript above is the executor's session, verbatim, up to its last completed message;",
		"the executor just called the advisor tool because it hit a decision difficulty (its in-flight turn is not visible here).",
		"Review the whole transcript and answer in ONE round: 400-700 tokens, conclusions first, grounded in the transcript",
		"(name files/functions/line numbers; mark anything unverified).",
		`REQUIRED final action: call the submit_verdict tool with your verdict (PROCEED | REDIRECT | STOP) and judgment.`,
		`The judgment is delivered ONLY through that tool call; a text-only reply never reaches the executor.`,
		"You only judge - never start or continue the executor's work.",
	].join(" ");
}

export interface AdvisorForkResult {
	ok: boolean;
	text: string;
	judgment?: string;
	verdict?: AdvisorVerdict;
}

/** Bounded wait on the tmux done signal; the timeout path kills the pane (Q9: no salvage). */
async function waitForDone(pi: ExtensionAPI, paths: SubagentPaths): Promise<"done" | "timeout"> {
	const deadline = Date.now() + ADVISOR_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (existsSync(paths.exitFile)) return "done";
		const wait = pi.exec("sh", ["-c", `TMUX= tmux -L ${SOCKET} wait-for ${shQuote(paths.done)}`]);
		const timeout = new Promise<"timeout">((resolve) => {
			const t = setTimeout(() => resolve("timeout"), 60_000);
			t.unref?.();
		});
		const r = await Promise.race([wait.then(() => "signal" as const), timeout]);
		if (r === "signal" && existsSync(paths.exitFile)) return "done";
		// timeout: the wait-for client died but the server-side wait continues; loop and spawn a
		// fresh one. The exit-file check above bounds the whole thing to ADVISOR_TIMEOUT_MS.
	}
	await runTmux(["kill-session", "-t", paths.session]);
	return "timeout";
}

/**
 * Launch the forked advisor pane and wait inside the tool call. Returns the judgment text, or a
 * failure. `sessionFile` is the main session's jsonl; `parentSessionId` labels the tmux session.
 */
export async function launchAdvisorFork(
	pi: ExtensionAPI,
	sessionFile: string,
	parentSessionId: string,
	advisorModel: string,
	verdictExtensionPath: string,
): Promise<AdvisorForkResult> {
	if (!existsSync(sessionFile)) {
		return { ok: false, text: `Advisor not started: main session file not found on disk (${sessionFile}).` };
	}
	if (!existsSync(verdictExtensionPath)) {
		return { ok: false, text: `Advisor not started: verdict extension not found (${verdictExtensionPath}).` };
	}
	if (!isWatchdogAvailable(pi)) {
		return {
			ok: false,
			text: "Advisor not started: the main session needs the watchdog extension for the advisor tool's wrap-up semantics. Load pi-watchdog and retry.",
		};
	}
	const paths = resolvePaths(`${kebab("advisor-fork")}-${shortId()}`);
	mkdirSync(paths.dir, { recursive: true });

	// The pane gets ONLY the verdict extension: --no-extensions keeps every installed extension
	// (watchdog included) out, so submit_verdict is the single wrap-up channel. stderr goes to a
	// file: startup errors (bad --model, extension load failure) exit at once and would otherwise
	// be invisible. The pane shell writes pi's real exit code; the verdict handler pre-writes 0
	// (or the nudge budget writes 98) before the pane dies, and that pre-written value is what the
	// waiter reads (the SIGHUP from kill-session wins over `echo $?`).
	const piCommand = [
		"pi",
		"--no-extensions",
		"-e",
		shQuote(verdictExtensionPath),
		"--fork",
		shQuote(sessionFile),
		"--model",
		shQuote(advisorModel),
		shQuote(buildConsultationPrompt()),
		`2> ${shQuote(paths.logPath)}`,
	].join(" ");
	const paneCommand = `${piCommand}; echo $? > ${shQuote(paths.exitFile)}`;

	const launch = await runTmux([
		"new-session",
		// The verdict extension reads these three; PI_SUB_VERDICT_ARTIFACT replaces the write
		// whitelist (the model never calls write itself - the handler writes the artifact).
		"-e",
		`${ENV_SUB_EXIT_FILE}=${paths.exitFile}`,
		"-e",
		`PI_SUB_DONE=${paths.done}`,
		// The extension is dependency-free, so the socket name travels with the other env vars.
		"-e",
		`PI_SUB_SOCKET=${SOCKET}`,
		"-e",
		`PI_SUB_VERDICT_ARTIFACT=${paths.artifactPath}`,
		"-e",
		`PI_SUBAGENT_DEBUG=${paths.dir}/signals.log`,
		"-d",
		"-s",
		paths.session,
		"-x",
		"220",
		"-y",
		"50",
		paneCommand,
	]);
	if (launch.code !== 0) {
		return { ok: false, text: `Advisor launch failed: ${launch.stderr || launch.stdout}` };
	}
	await runTmux([
		"set-option",
		"-t",
		paths.session,
		"@pi-sub-parent-session",
		parentSessionId,
		";",
		"set-option",
		"-t",
		paths.session,
		"@pi-sub-mode",
		"advisor",
	]);
	await styleSubagentSession(paths.session);
	// Crash backstop: a pane that dies without any verdict handler action still fires the signal,
	// so the waiter sees a missing exit file (abnormal exit) instead of hanging.
	const hookError = await registerPaneDiedHook(paths);
	if (hookError) {
		await runTmux(["kill-session", "-t", paths.session]);
		return {
			ok: false,
			text: `Advisor not started: the pane-died hook failed to register (${hookError}), session reclaimed.`,
		};
	}

	// Let the TUI settle, then submit the pre-filled consultation prompt.
	await new Promise((r) => setTimeout(r, 3000));
	await runTmux(["send-keys", "-t", paths.session, "Enter"]);

	const outcome = await waitForDone(pi, paths);
	if (outcome === "timeout") {
		return {
			ok: false,
			text: `Advisor timed out after ${ADVISOR_TIMEOUT_MS / 1000}s and was killed. No verdict was submitted.`,
		};
	}
	const exit = existsSync(paths.exitFile) ? readFileSync(paths.exitFile, "utf8").trim() : "";
	if (exit !== "0" || !existsSync(paths.artifactPath)) {
		const tail = existsSync(paths.logPath) ? readFileSync(paths.logPath, "utf8").split("\n").slice(-10).join("\n") : "";
		return {
			ok: false,
			text:
				exit === "98"
					? `Advisor finished without submitting a verdict after ${MAX_VERDICT_NUDGES} guidance re-prompts. Last stderr lines:\n${tail || "(none)"}`
					: `Advisor run failed (exit ${exit || "missing"}). Last stderr lines:\n${tail || "(none)"}`,
		};
	}
	// result.md line 1 is "VERDICT: <choice>" written by the submit_verdict handler from the
	// structured tool argument; the judgment body follows after a blank line.
	const parsed = parseVerdictArtifact(readFileSync(paths.artifactPath, "utf8"));
	if (!parsed) {
		const raw = readFileSync(paths.artifactPath, "utf8").trim();
		return {
			ok: false,
			text: `Advisor submitted, but result.md does not start with a VERDICT line (PROCEED|REDIRECT|STOP) or the judgment body is empty. Raw content:\n${raw}`,
		};
	}
	const { verdict, judgment } = parsed;
	return { ok: true, text: judgment, judgment, verdict };
}

/** tmux pane-died backstop, local copy so advisor-fork stays independent of the batch launch path. */
async function registerPaneDiedHook(paths: SubagentPaths): Promise<string | undefined> {
	const hook = await runTmux([
		"set-hook",
		"-t",
		paths.session,
		"pane-died",
		`run-shell -b 'TMUX= tmux -L ${SOCKET} wait-for -S ${paths.done}'`,
	]);
	if (hook.code === 0) return undefined;
	return (hook.stderr || hook.stdout).trim();
}
