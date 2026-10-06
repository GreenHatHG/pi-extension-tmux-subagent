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
 * Give watchers a look that differs from the user's own tmux: purple status bar + a "sub-agent
 * watch" label + an always-on exit hint (sub-sessions inherit the user tmux.conf, so by default
 * they look identical).
 * Only display options change: capture-pane cannot see the status line, so captureSubagentPane is
 * unaffected. Pure decoration, so a failed set-option just means no color; callers should ignore it.
 */
export async function styleSubagentSession(session: string): Promise<void> {
	const hint = await subagentPrefixHint();
	// status-* are session options, window-status-* are window options (-w), hence two groups
	const sessionOpts: Array<[string, string]> = [
		["status", "on"],
		["status-style", "bg=colour53,fg=colour231"],
		["status-left-length", "30"],
		["status-left", " #[bg=colour53,fg=colour231,bold] sub-agent watch "],
		["status-right-length", "40"],
		["status-right", ` #[bg=colour213,fg=colour16,bold] in popup ${hint} d to quit `],
		["window-status-separator", "#[bg=colour53,fg=colour240]│"],
	];
	const windowOpts: Array<[string, string]> = [
		["window-status-style", "bg=colour53,fg=colour245"],
		["window-status-current-style", "bg=colour213,fg=colour16,bold"],
		["window-status-format", " #[fg=colour245]#W "],
		["window-status-current-format", " #[fg=colour16,bold]#W "],
	];
	const args: string[] = [];
	const push = (extra: string[], opt: string, value: string) => {
		if (args.length > 0) args.push(";");
		args.push("set-option", ...extra, "-t", session, opt, value);
	};
	for (const [opt, value] of sessionOpts) push([], opt, value);
	for (const [opt, value] of windowOpts) push(["-w"], opt, value);
	await runTmux(args);
}
