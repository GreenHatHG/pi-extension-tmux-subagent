/**
 * TUI-only display layer for sub-agent briefs/replies (main session), shared by all three tools.
 * The brief is appendEntry'd right after launch succeeds; the reply is appendEntry'd by a watcher
 * after the sub-agent finishes. Both go to the TUI only, not into the LLM context, and don't change
 * the main session model's "wait-for + read result.md" protocol.
 *
 * Dependency direction: ui -> core; it imports neither launch/ nor tools/, so run-result fields are
 * described by a local minimal shape.
 */
import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, MouseRegion, Text } from "@earendil-works/pi-tui";
import { runTmux } from "../core/tmux";
import type { SubagentDisplay } from "../modes/types";

/** New entry type names (shared by the three modes). */
export const SUBAGENT_BRIEF_ENTRY = "pi-subagent-brief";
export const SUBAGENT_REPLY_ENTRY = "pi-subagent-reply";

/**
 * Old type names: used by history jsonl written during the advisor-only era. We only register the
 * renderers so old sessions still display; an unregistered customType renders as empty in pi, so
 * keeping the old entry names would make them invisible.
 */
const LEGACY_ENTRY_TYPES = ["pi-advisor-brief", "pi-advisor-reply"];

/** Display-related fields of LaunchResult (minimal shape). */
export interface SubagentLaunchInfo {
	/** Brief text (main-session appendEntry, display only). */
	brief?: string;
	session?: string;
	artifactPath?: string;
	exitFile?: string;
	done?: string;
	logPath?: string;
}

interface SubagentEntryData {
	label: string;
	body: string;
	note?: string;
}

type EntryTheme = Parameters<Parameters<ExtensionAPI["registerEntryRenderer"]>[1]>[2];

/** Build content for the collapsed and expanded forms. */
function buildSubagentEntryContent(
	d: Partial<SubagentEntryData>,
	fallback: string,
	expanded: boolean,
	theme: EntryTheme,
): Component {
	const body = d.body ?? "";
	if (!expanded) {
		const lines = body ? body.split("\n") : [];
		const note = d.note ? ` · ${d.note}` : "";
		return new Text(
			theme.fg("muted", `▸ ${d.label ?? fallback} (${lines.length} lines${note}, click to expand)`),
			1,
			0,
		);
	}
	const c = new Container();
	c.addChild(new Text(theme.fg("toolTitle", theme.bold(`▾ ${d.label ?? fallback} (click to collapse)`)), 1, 0));
	if (d.note) c.addChild(new Text(theme.fg("muted", d.note), 1, 0));
	c.addChild(new Markdown(body || "(empty)", 1, 0, getMarkdownTheme()));
	return c;
}

/**
 * Entry renderer for briefs/replies: collapsed to a one-line summary by default, ctrl+o expands it
 * globally to full Markdown; in fullscreen mode a left click expands/collapses in place.
 *
 * The click state is local per entry: the global ctrl+o rebuilds the entry component and resets it
 * (same as pi's native ToolExecution / thinking block). Data is written via pi.appendEntry, so it
 * can re-render after a session restore.
 */
function renderSubagentEntry(
	entry: { data?: unknown; customType?: string },
	options: { expanded: boolean },
	theme: EntryTheme,
) {
	const d = (entry.data ?? {}) as Partial<SubagentEntryData>;
	// keep the old advisor entry fallback text as "advisor" (only visible on entries with a missing label)
	const fallback = entry.customType && LEGACY_ENTRY_TYPES.includes(entry.customType) ? "advisor" : "subagent";
	let expanded = options.expanded;
	let cache: { width: number; expanded: boolean; lines: string[] } | undefined;
	// MouseRegion.child is read-only, so use a content component that reads the latest expanded from
	// the closure: a click only flips the state and clears the cache, and the next render makes the new content.
	const content: Component = {
		render(width) {
			if (!cache || cache.width !== width || cache.expanded !== expanded) {
				cache = { width, expanded, lines: buildSubagentEntryContent(d, fallback, expanded, theme).render(width) };
			}
			return cache.lines;
		},
		invalidate() {
			cache = undefined;
		},
	};
	return new MouseRegion(content, (event) => {
		if (event.type !== "click" || event.button !== "left") return undefined;
		// Double/triple click on the same word goes to pi's word/line selection, so don't toggle expand
		if (event.clickCount !== undefined && event.clickCount > 1) return { handled: true };
		expanded = !expanded;
		cache = undefined;
		return { handled: true };
	});
}

/**
 * Register the brief/reply entry renderers. Call once in the main-session branch.
 */
export function registerSubagentEntryRenderers(pi: ExtensionAPI): void {
	pi.registerEntryRenderer(SUBAGENT_BRIEF_ENTRY, renderSubagentEntry);
	pi.registerEntryRenderer(SUBAGENT_REPLY_ENTRY, renderSubagentEntry);
	for (const legacy of LEGACY_ENTRY_TYPES) pi.registerEntryRenderer(legacy, renderSubagentEntry);
}

/** Push the brief into the TUI (not the LLM context); skip when there is no brief. */
export function showSubagentBrief(pi: ExtensionAPI, r: SubagentLaunchInfo, display: SubagentDisplay): void {
	if (r.brief) pi.appendEntry(SUBAGENT_BRIEF_ENTRY, { label: display.briefLabel, body: r.brief });
}

/** Start a TUI watcher that waits for the sub-agent and pushes the reply; skip when fields are missing. */
export function watchSubagentReply(pi: ExtensionAPI, r: SubagentLaunchInfo, display: SubagentDisplay): void {
	if (r.session && r.artifactPath && r.exitFile && r.done) {
		void watchSubagentResult(pi, {
			session: r.session,
			artifactPath: r.artifactPath,
			exitFile: r.exitFile,
			done: r.done,
			logPath: r.logPath ?? "",
			label: display.replyLabel,
		}).catch(() => {}); // readFileSync TOCTOU and similar: the watcher is a display-only bonus, so fail quietly
	}
}

/**
 * On failure, show the tail of the stderr log to the user. The watchdog path's log is pi's stderr
 * only; the batch path's log is stdout+stderr. Give a clear message when it can't be read.
 */
function failureLog(logPath: string): string {
	if (!logPath || !existsSync(logPath)) return "(no stderr log — old pane commands did not redirect stderr)";
	const lines = readFileSync(logPath, "utf8").split("\n");
	return ["## sub-agent stderr (last 30 lines)", "```", ...lines.slice(-30), "```"].join("\n");
}

/**
 * Wait for the sub-agent to finish, event-driven, then push result.md content into the TUI as a
 * display-only entry. The protocol mirrors the main agent's mainAgentNote: if the exit file already
 * exists -> read it now; else block on wait-for (zero tokens), raced against a 600s fallback per
 * round — after a timeout, kill the hanging tmux client, then has-session to decide: session still
 * there = not done, go another round; session gone = finished but the signal was missed, read exit.
 * Total cap 6h, so we don't wait forever if every hook fails.
 *
 * Known edge cases:
 * - a signal missed in the gap between the loop-head exit check and the wait-for setup (signals are
 *   not replayed for late waiters): that round sleeps the full 600s, then the has-session branch
 *   decides, so the report is at most one round late;
 * - the user quits the session: the watcher's JS logic stops with it (does not block process exit),
 *   and the tmux client process becomes an orphan, waking on the signal and exiting on normal finish.
 */
const WATCH_ROUND_TIMEOUT = 600_000; // display-only fallback: shorter than the LLM-facing suggestion on purpose, so a lost signal is reported sooner
const WATCH_TOTAL_LIMIT = 6 * 3600_000;
async function watchSubagentResult(
	pi: ExtensionAPI,
	opts: {
		session: string;
		artifactPath: string;
		exitFile: string;
		done: string;
		logPath: string;
		/** Reply entry label (data.label, shown when rendered). */
		label: string;
	},
): Promise<void> {
	const { session, artifactPath, exitFile, done, logPath, label } = opts;
	const started = Date.now();
	while (Date.now() - started < WATCH_TOTAL_LIMIT) {
		if (existsSync(exitFile)) break;
		// a wait-for signal wakes every waiter on the same channel and does not interfere with the main agent's bash wait-for
		let waiter: import("node:child_process").ChildProcess | undefined;
		const signal = runTmux(["wait-for", done], (proc) => {
			waiter = proc;
			// proc.unref can't suppress the stdio pipe handles, so unref each one; otherwise when the
			// user quits the session the main process is held by the hanging wait-for pipe. The cost is
			// the tmux client becomes an orphan (it exits only on a signal or when the server dies).
			proc.unref?.();
			// with stdio as a pipe, stdout/stderr are really net.Socket, which have unref
			(proc.stdout as import("node:net").Socket | null)?.unref?.();
			(proc.stderr as import("node:net").Socket | null)?.unref?.();
		});
		let fired = false;
		const timeout = new Promise<undefined>((resolve) => {
			const t = setTimeout(() => {
				fired = true;
				resolve(undefined);
			}, WATCH_ROUND_TIMEOUT);
			t.unref?.();
		});
		// when the tmux server dies, wait-for wakes silently with code 0 (as if it got the signal),
		// then the exit file is still missing and the next wait-for errors at once — code != 0 also
		// leads to the decide branch, otherwise we spin to the 6h cap.
		const r = await Promise.race([signal, timeout]);
		if (!fired && r && r.code === 0) continue; // signal came first: loop back to read exit and decide
		waiter?.kill(); // timeout or wait-for exited with an error: kill the hanging client
		const has = await runTmux(["has-session", "-t", session]);
		if (has.code === 0) continue; // session still there = not done, go another round
		// session gone = finished but the signal was missed: a missing exit means abnormal exit
		if (!existsSync(exitFile)) {
			pi.appendEntry(SUBAGENT_REPLY_ENTRY, {
				label,
				body: existsSync(artifactPath) ? readFileSync(artifactPath, "utf8") : failureLog(logPath),
				note: `Session ended but exit is missing (abnormal exit / killed, or tmux server unavailable); the reply may be incomplete · ${artifactPath}`,
			});
			return;
		}
	}
	// loop exit = the exit file appeared (normal path) or the total cap was hit (all hooks failed)
	if (existsSync(exitFile)) {
		const code = readFileSync(exitFile, "utf8").trim();
		const ok = code === "0";
		pi.appendEntry(SUBAGENT_REPLY_ENTRY, {
			label,
			body: existsSync(artifactPath) && ok ? readFileSync(artifactPath, "utf8") : failureLog(logPath),
			note: ok ? `exit 0 · ${artifactPath}` : `exit ${code || "missing"} (abnormal exit) · ${artifactPath}`,
		});
		return;
	}
	pi.appendEntry(SUBAGENT_REPLY_ENTRY, {
		label,
		body: "",
		note: `Wait timed out (not done after 6 hours), no reply produced. Deliverable path: ${artifactPath}`,
	});
}
