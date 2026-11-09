/**
 * Verdict wrap-up extension for the advisor fork pane, loaded via `pi -e <this file>` with
 * --no-extensions (the watchdog is deliberately absent, so submit_verdict is the ONLY wrap-up
 * channel and the model cannot pick a competing one). Three responsibilities:
 *
 * 1. submit_verdict tool: validate verdict/judgment, write result.md, exit 0, signal, kill-session.
 *    Invalid args return an isError tool result with guidance so the model retries in place.
 * 2. agent_end nudge: a run that ends without a submission gets a guidance user message
 *    (triggerTurn), up to MAX_NUDGES times; after that, exit 98 (wrapped up without a verdict).
 * 3. The ON_STOP chain of the watchdog path does not exist here; the shell chain in the pane
 *    command is just `pi ...; echo $? > exit`, and the pane-died hook signals a crash.
 *
 * All tmux/exit-file interactions reuse the completion protocol names from core/env via env vars,
 * so this file stays dependency-free (it loads in the pane, outside this project's extension tree).
 */
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AdvisorVerdict, buildVerdictArtifact, VERDICT_CHOICES } from "./verdict";

const VERDICTS = VERDICT_CHOICES;

type Verdict = AdvisorVerdict;

/** Local copy of shQuote: this file stays dependency-free (it loads in the pane, outside the project tree). */
const shQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

const MAX_NUDGES = 3;
const TOOL_NAME = "submit_verdict";

const GUIDANCE = [
	`You MUST finish by calling the ${TOOL_NAME} tool exactly once, with:`,
	`- verdict: one of PROCEED | REDIRECT | STOP`,
	`- judgment: your full judgment text (400-700 tokens, conclusions first, grounded in the transcript;`,
	`  end the text with exactly one line "VERDICT: <choice>").`,
	"Do NOT call watchdog_decide or any other wrap-up tool - it does not exist. Do not just reply with text:",
	"a text-only reply never reaches the executor; only the tool call delivers your judgment.",
].join(" ");

/** Env contract: all are injected by the launcher via tmux -e (advisor-fork.ts). */
const exitFile = process.env.PI_SUB_EXIT_FILE;
const doneChannel = process.env.PI_SUB_DONE;
const artifactPath = process.env.PI_SUB_VERDICT_ARTIFACT;
const socketName = process.env.PI_SUB_SOCKET;

export default function (pi: ExtensionAPI) {
	if (!exitFile || !doneChannel || !artifactPath || !socketName) return; // not an advisor pane; stay inert

	let submitted = false;
	let nudges = 0;

	const signalDone = () => {
		pi.exec("sh", ["-c", `TMUX= tmux -L ${shQuote(socketName)} wait-for -S ${shQuote(doneChannel)}`]).catch(() => {});
	};

	// kill-session -t $TMUX_PANE does not work (it takes a session name, not a pane). The session
	// name is derivable from the done channel: <session>-done -> <session>.
	const sessionName = doneChannel.replace(/-done$/, "");
	const killSession = () => {
		setTimeout(() => {
			pi.exec("sh", [
				"-c",
				`TMUX= tmux -L ${shQuote(socketName)} kill-session -t ${shQuote(sessionName)} 2>/dev/null || true`,
			]).catch(() => {});
		}, 300);
	};

	const wrapUp = (verdict: Verdict, judgment: string) => {
		submitted = true;
		// Verdict goes on line 1: the launcher parses the file, not the LLM text, so the structured
		// tool argument is the source of truth (the judgment body need not end with a VERDICT line).
		writeFileSync(artifactPath, buildVerdictArtifact(verdict, judgment));
		writeFileSync(exitFile, "0");
		signalDone();
		killSession();
	};

	pi.registerTool({
		name: TOOL_NAME,
		label: "Submit verdict",
		description: [
			"REQUIRED final action: submit your judgment and end the consultation.",
			"verdict: PROCEED (plan is sound, keep going) | REDIRECT (wrong path - say what to do instead, in order) | STOP (halt and escalate to the user, say why).",
			"judgment: 400-700 tokens, conclusions first, grounded in the transcript (name files/functions/line numbers; mark anything unverified), ending with exactly one line 'VERDICT: <choice>'.",
			"Call exactly once. You only judge - never start or continue the executor's work.",
		].join(" "),
		parameters: Type.Object({
			verdict: Type.Union(
				VERDICTS.map((v) => Type.Literal(v)),
				{
					description: "One of PROCEED | REDIRECT | STOP",
				},
			),
			judgment: Type.String({ description: "The full judgment text, ending with a 'VERDICT: <choice>' line" }),
		}),
		async execute(_id: string, params: { verdict: Verdict; judgment: string }) {
			const judgment = params.judgment?.trim() ?? "";
			if (judgment.length < 50) {
				return {
					content: [{ type: "text", text: `Rejected: judgment is empty or too short. ${GUIDANCE}` }],
					details: {},
					isError: true,
				};
			}
			wrapUp(params.verdict, judgment);
			return {
				content: [{ type: "text", text: "Verdict accepted. The consultation is closed; the pane is closing." }],
				details: {},
			};
		},
	});

	pi.on("agent_end", async () => {
		if (submitted) return;
		if (nudges >= MAX_NUDGES) {
			// Out of chances: report a failed wrap-up. 98 = "wrapped up without a deliverable" in the
			// completion protocol; the waiter sees the pane die and reads 98.
			writeFileSync(exitFile, "98");
			signalDone();
			killSession();
			return;
		}
		nudges++;
		pi.sendUserMessage(
			`Your turn ended without calling ${TOOL_NAME}, so your judgment was never delivered. ${GUIDANCE}`,
		);
	});

	// Crash backstop: if pi dies with no submission and no nudge budget left, the pane-died hook
	// (registered by the launcher) fires the done signal and the waiter reads a missing/98 exit.
}
