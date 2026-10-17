/**
 * tmux subprocess primitives: run commands on a dedicated socket, plus shell-quote wrapping.
 */
import { spawn } from "node:child_process";

/** Dedicated tmux socket: all sub-agent sessions run here, separate from the user's own tmux server. */
export const SOCKET = "pi-sub";

/** Safe single-quote shell wrap: keeps a string in one piece when inlined into tmux run-shell commands. */
export function shQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Generic process runner: collects stdout/stderr. onSpawn exposes the child (used to kill it after a timeout, e.g. a wait-for client). */
export function run(
	cmd: string,
	args: string[],
	onSpawn?: (proc: import("node:child_process").ChildProcess) => void,
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const proc = spawn(cmd, args, {
			env: { ...process.env, TMUX: "" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		onSpawn?.(proc);
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		const readOutput = () => ({
			stdout: Buffer.concat(stdout).toString(),
			stderr: Buffer.concat(stderr).toString(),
		});
		proc.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		proc.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		proc.on("close", (code) => resolve({ code: code ?? 1, ...readOutput() }));
		proc.on("error", (err) => {
			const output = readOutput();
			resolve({ code: 1, ...output, stderr: output.stderr || String(err) });
		});
	});
}

/** Run a tmux command. TMUX= avoids the nested-session warning (same as a TMUX= prefix in the shell). */
export function runTmux(
	args: string[],
	onSpawn?: (proc: import("node:child_process").ChildProcess) => void,
): Promise<{ code: number; stdout: string; stderr: string }> {
	return run("tmux", ["-L", SOCKET, ...args], onSpawn);
}

/**
 * List the live sub-agent sessions that belong to the current main session.
 *
 * pi-sub is a shared socket across main sessions, so list-sessions output is not automatically
 * this conversation's sub-agents. We write the main session ID into a tmux session option at
 * launch, then filter by that option here.
 */
export async function listSubagentSessions(parentSessionId: string): Promise<string[]> {
	if (!parentSessionId) return [];
	const r = await runTmux(["list-sessions", "-F", "#{session_name}\t#{@pi-sub-parent-session}"]);
	if (r.code !== 0) return [];
	return r.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			// the owner is always the last field; if the session name has a tab, join the rest back,
			// otherwise the owner grabs a name fragment and that session is lost for good.
			const parts = line.split("\t");
			const owner = parts.pop();
			return { session: parts.join("\t").trim(), owner };
		})
		.filter(({ owner }) => owner === parentSessionId)
		.map(({ session }) => session)
		.filter(Boolean);
}

/**
 * Grab the current visible screen of one session's pane. -p prints plain text (no ANSI), the
 * same screen a human sees with `tmux -L pi-sub attach`. code !== 0 if the session already ended.
 */
export function captureSubagentPane(session: string): Promise<{ code: number; stdout: string; stderr: string }> {
	return runTmux(["capture-pane", "-p", "-t", session]);
}

/** Kill just one sub-agent session (used by the main-session reaper). */
export function killSubagentSession(session: string): Promise<{ code: number; stdout: string; stderr: string }> {
	return runTmux(["kill-session", "-t", session]);
}

/** tmux key name (C-b / M-a / F12 / C-M-x) -> human text (Ctrl-b / Alt-a / F12 / Ctrl-Alt-x). */
export function formatPrefixKey(raw: string): string {
	let s = raw.trim();
	if (!s) return "Ctrl-b";
	const mods: string[] = [];
	for (;;) {
		if (s.startsWith("C-")) {
			mods.push("Ctrl");
			s = s.slice(2);
		} else if (s.startsWith("M-")) {
			mods.push("Alt");
			s = s.slice(2);
		} else if (s.startsWith("S-")) {
			mods.push("Shift");
			s = s.slice(2);
		} else break;
	}
	if (mods.length === 0) return s;
	return [...mods, s].join("-");
}

/**
 * Human text for the pi-sub server prefix key (users can change it, default Ctrl-b). Use -qv to
 * get the bare value (`show-options -g prefix` prints `prefix C-b`, -v gives just `C-b`).
 */
export async function subagentPrefixHint(): Promise<string> {
	const r = await runTmux(["show-options", "-gqv", "prefix"]);
	return formatPrefixKey(r.code === 0 ? r.stdout : "");
}

/**
 * Root-table mouse binding that turns a click on the right-hand hint zone into a detach: the
 * inner attach client exits, -E closes the popup, and the sub-agent keeps running. No prefix keys
 * needed.
 *
 * bind-key is server-global on the pi-sub socket, so guard the detach with the @pi-sub-parent-session
 * option (set at launch for every sub-agent): sessions without it fall back to the default behavior.
 * The status bar is split into three click zones: left pill -> *StatusLeft, window list -> *Status,
 * right hint -> *StatusRight. Only the hint zone (StatusRight) is bound, because the hint text is
 * the only place that says "click here to quit" — everywhere else keeps tmux's default behavior
 * (switch window, session menu, ...). Pane-area clicks are NOT touched on purpose — the sub-agent
 * runs the pi TUI, which uses the mouse itself, so pane events must keep flowing to it.
 */
const detachIfSub = `if -F '#{!=:#{@pi-sub-parent-session},}' 'detach-client' 'switch-client -t='`;
const STATUS_CLICK_DETACH: Array<[string, string, string]> = [
	// the hint lives in its own range: MouseDown1StatusRight is unbound by default, so this is the
	// only key needed — clicking anything else on the bar keeps the stock tmux behavior
	["-n", "MouseDown1StatusRight", detachIfSub],
];

/**
 * Give watchers a look that differs from the user's own tmux: an amber status bar matching the
 * popup's color identity + a "sub-agent" label + an always-on exit hint (sub-sessions inherit the
 * user tmux.conf, so by default they look identical).
 * Only display options change: capture-pane cannot see the status line, so captureSubagentPane is
 * unaffected. Pure decoration, so a failed set-option just means no color; callers should ignore it.
 */
export async function styleSubagentSession(session: string): Promise<void> {
	const hint = await subagentPrefixHint();
	// status-* are session options, window-status-* are window options (-w), hence two groups
	const sessionOpts: Array<[string, string]> = [
		["status", "on"],
		// Dark warm bar with an amber pill: same identity as the attach popup's amber frame + title
		// pill, so the popup's top bar and the inner session's bottom bar read as one design
		["status-style", "bg=colour235,fg=colour250"],
		["status-left-length", "30"],
		["status-left", "#[bg=colour214,fg=colour0,bold] sub-agent "],
		["status-right-length", "60"],
		// click hint first: it is the cheapest way out (no prefix keys); prefix d stays as the keyboard path
		[
			"status-right",
			`#[bg=colour235,fg=colour214,bold] click here to quit · #[bg=colour235,fg=colour240]popup · ${hint} d `,
		],
		["window-status-separator", "#[bg=colour235,fg=colour240]│"],
	];
	const windowOpts: Array<[string, string]> = [
		["window-status-style", "bg=colour235,fg=colour250"],
		["window-status-current-style", "bg=colour235,fg=colour214,bold"],
		["window-status-format", " #[fg=colour250]#W "],
		["window-status-current-format", " #[fg=colour214,bold]#W "],
	];
	const args: string[] = [];
	const push = (extra: string[], opt: string, value: string) => {
		if (args.length > 0) args.push(";");
		args.push("set-option", ...extra, "-t", session, opt, value);
	};
	for (const [opt, value] of sessionOpts) push([], opt, value);
	for (const [opt, value] of windowOpts) push(["-w"], opt, value);
	// the bindings are server-global, so re-binding per launch is harmless and idempotent, and it also
	// covers the very first sub-agent after the server starts fresh
	for (const [flags, key, cmd] of STATUS_CLICK_DETACH) {
		if (args.length > 0) args.push(";");
		args.push("bind-key", flags, key, cmd);
	}
	await runTmux(args);
}
