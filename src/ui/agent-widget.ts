/**
 * Live list of this conversation's sub-agents, shown as a widget above the editor (main session,
 * interactive TUI only).
 *
 * The data source is tmux itself: list-sessions for liveness plus the @pi-sub-parent-session
 * option to keep the list to this conversation, capture-pane for the same screen a manual attach
 * shows, and the run dir's exit file for the final state. No sub-agent side hooks, no new files.
 *
 * The widget is created from a custom entry appended to the session at startup: restoring a session
 * or reloading the extension replays that entry, so the widget comes back on its own. That works
 * because pi renders entry components before the extension widgets (it sees the marker and turns
 * polling on first) and only then renders the widget.
 *
 * Cost: while a marker exists the poll runs once a second, and with no live agent that is a single
 * cheap `tmux list-sessions`. The list itself is hidden until the first agent shows up.
 *
 * Collapsed it is one line per agent (status dot, name, latest activity). Clicking the title row or
 * ctrl+o (app.tools.expand) opens the expanded view with a few screen lines per agent; a click on
 * any agent row opens the same popup attach as /attach. /attach keeps working on its own, so mouse
 * input is a shortcut, never a requirement.
 *
 * Display only: it never throws into the main session and never touches the wait-for / exit
 * protocol.
 */
import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { resolvePaths } from "../core/paths";
import { captureSubagentPane, listSubagentSessions, runTmux } from "../core/tmux";
import { onEvent } from "../registry";
import { manualAttachCmd, openAttach, overlayAvailable, popupMsg } from "./attach-open";

/** Session entry that creates the widget; also the marker that brings it back on restore. */
const AGENT_WIDGET_ENTRY = "pi-subagent-pad";

const WIDGET_KEY = "subagents";
/** Poll interval: one list-sessions per tick, so an idle session costs one cheap tmux call a second. */
const POLL_MS = 1000;
/** How long a finished agent stays in the list so its result is readable. */
const LINGER_MS = 8000;
/** Collapsed view: keep the widget small (the editor needs room). */
const COLLAPSED_MAX = 5;
/** Expanded view: screen lines per agent and a cap for the whole widget. */
const TAIL_LINES = 6;
const EXPANDED_MAX = 14;

/** What one agent shows in the list. */
interface AgentRow {
	session: string;
	/** Sub-agent mode from the @pi-sub-mode session option ("task" when unknown). */
	mode: string;
	/** Latest real output line: the collapsed one-liner. */
	activity: string;
	/** Last screen lines for the expanded view. */
	tail: string[];
	/** Set once the session is gone; dropped again after LINGER_MS. */
	end?: { ok: boolean; note: string; at: number };
}

// ---------- widget state ----------

const rows = new Map<string, AgentRow>();
let ctxRef: ExtensionContext | undefined;
let widgetTui: TUI | undefined;
let installed = false;
let wantWidget = false;
let ticking = false;
let timer: ReturnType<typeof setInterval> | undefined;
/**
 * ctrl+o (pi hands it to the entry renderer as setExpanded) and a click are two owners of the same
 * view. A click only overrides until pi next reports a changed expanded state, which means the user
 * pressed ctrl+o: the key takes the view back.
 */
let overrideExpanded: boolean | undefined;
/** Latest expanded state pi reported for the marker entry, and the value before it. */
let entryExpanded = false;
let prevEntryExpanded = false;
/** Line ranges of the last render, so a click can be mapped back to an agent. */
let hitRows: Array<{ session: string; start: number; end: number }> = [];
let lastSig = "";

// ---------- reading a pane ----------

/**
 * Lines pi's TUI always draws (borders, editor rules, footer, metrics). They say nothing about what
 * the sub-agent is doing, so the list skips them; the full screen is always a click away.
 */
function isChrome(line: string): boolean {
	const t = line.trim();
	if (!t) return true;
	if (/^[─━═╌┄┈╭╮╰╯│┃┌┐└┘├┤┬┴┼▔▁]+$/.test(t)) return true; // borders and editor rules
	if (t.startsWith("[metrics]")) return true; // per-turn performance line
	if (t.includes("↑") && t.includes("↓")) return true; // token stats + model line
	if (t.startsWith("↳") && t.includes("tokens")) return true; // single usage echo
	if (/[🛡⏱]/u.test(t) && t.length < 100) return true; // footer status row
	if (/^(~|\/)\S*\s*\(\S+\)$/.test(t)) return true; // footer cwd (branch)
	return false;
}

/** Content lines of a captured pane, oldest first. */
function paneContent(raw: string): string[] {
	return raw
		.split("\n")
		.map((line) => line.replace(/\s+$/, ""))
		.filter((line) => !isChrome(line));
}

/** Final state from the run dir's exit file: 0 = clean wrap-up, else failure, missing = killed/crash. */
function endState(session: string): { ok: boolean; note: string; at: number } {
	try {
		const raw = readFileSync(resolvePaths(session).exitFile, "utf8").trim();
		if (raw === "0") return { ok: true, note: "done", at: Date.now() };
		return { ok: false, note: raw ? `exit ${raw}` : "failed", at: Date.now() };
	} catch {
		return { ok: false, note: "killed / crashed", at: Date.now() };
	}
}

/** Mode of every live session, in one tmux call (the option is set at launch). */
async function sessionModes(): Promise<Map<string, string>> {
	const modes = new Map<string, string>();
	const r = await runTmux(["list-sessions", "-F", "#{session_name}\t#{@pi-sub-mode}"]);
	if (r.code !== 0) return modes;
	for (const line of r.stdout.split("\n").filter(Boolean)) {
		const [name, mode] = line.split("\t");
		if (name && mode) modes.set(name, mode);
	}
	return modes;
}

// ---------- polling ----------

/** Number of live sessions to capture in parallel, so one slow pane cannot stretch the tick. */
async function captureAll(sessions: string[]): Promise<Map<string, string[]>> {
	const captured = new Map<string, string[]>();
	const results = await Promise.all(
		sessions.map(async (session) => ({ session, cap: await captureSubagentPane(session) })),
	);
	for (const { session, cap } of results) {
		// the session can end between the list and the capture; the next tick marks it finished
		if (cap.code === 0) captured.set(session, paneContent(cap.stdout));
	}
	return captured;
}

/** Turn polling on for this session. Safe to call twice. */
function ensurePolling(): void {
	if (!ctxRef || timer) return;
	timer = setInterval(() => void tick(), POLL_MS);
	void tick();
}

async function tick(): Promise<void> {
	const ctx = ctxRef;
	if (!ctx || ticking || !wantWidget) return;
	ticking = true;
	try {
		const live = await listSubagentSessions(ctx.sessionManager.getSessionId());
		const modes = live.length > 0 ? await sessionModes() : new Map<string, string>();
		const captured = await captureAll(live);
		for (const [session, content] of captured) {
			rows.set(session, {
				session,
				mode: modes.get(session) ?? "task",
				activity: content[content.length - 1] ?? "",
				tail: content.slice(-TAIL_LINES),
			});
		}
		const now = Date.now();
		for (const [session, row] of rows) {
			if (!live.includes(session) && !row.end) row.end = endState(session);
			if (row.end && now - row.end.at > LINGER_MS) rows.delete(session);
		}
		refresh();
	} catch {
		/* display only: a failed poll must never reach the main session */
	} finally {
		ticking = false;
	}
}

/** Install the widget while agents exist, drop it when the list is empty. */
function refresh(): void {
	const ctx = ctxRef;
	// a tick already in flight when the session went away must not install a widget again
	if (!ctx || !wantWidget) return;
	if (rows.size === 0) {
		if (installed) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			installed = false;
			widgetTui = undefined;
		}
		lastSig = "";
		return;
	}
	if (!installed) {
		// install once: setWidget disposes and rebuilds on every call, so afterwards we only refresh
		// module state and ask the TUI for a render
		ctx.ui.setWidget(WIDGET_KEY, (tui) => {
			widgetTui = tui;
			return {
				render: (width: number) => renderList(width),
				invalidate: () => {},
				dispose: () => {
					widgetTui = undefined;
				},
				handleMouse: (event: TuiMouseEvent) => onWidgetMouse(event),
			};
		});
		installed = true;
	}
	const sig = [...rows.values()].map((r) => `${r.session}:${r.end?.note ?? r.activity}`).join("\n");
	if (sig !== lastSig) {
		lastSig = sig;
		widgetTui?.requestRender();
	}
}

// ---------- rendering ----------

function isExpanded(): boolean {
	return overrideExpanded ?? entryExpanded;
}

/** The status dot and the one line of text that describes an agent right now. */
function statusOf(row: AgentRow, theme: ExtensionContext["ui"]["theme"]): { dot: string; text: string } {
	if (row.end) {
		return {
			dot: theme.fg(row.end.ok ? "success" : "error", row.end.ok ? "✓" : "✗"),
			text: theme.fg("muted", row.end.note),
		};
	}
	return { dot: theme.fg("accent", "◐"), text: theme.fg("text", row.activity || "starting…") };
}

/** Mouse clicks only reach a component in fullscreen mode (regular mode leaves the mouse to the terminal). */
function mouseAvailable(): boolean {
	return widgetTui?.mode === "fullscreen";
}

function renderList(width: number): string[] {
	const theme = ctxRef?.ui.theme;
	if (!theme) return [];
	const list = [...rows.values()];
	const expanded = isExpanded();
	const running = list.filter((r) => !r.end).length;
	const done = list.filter((r) => r.end?.ok).length;
	const failed = list.filter((r) => r.end && !r.end.ok).length;
	const counts = [`${running} running`, done ? `${done} done` : "", failed ? `${failed} failed` : ""]
		.filter(Boolean)
		.join(" · ");

	const click = mouseAvailable() ? " or click" : "";
	const hint = expanded ? `  ctrl+o${click} to collapse` : `  ctrl+o${click} to expand`;
	const out: string[] = [
		truncateToWidth(theme.fg("accent", `${expanded ? "▾" : "▸"} agents · ${counts}`) + theme.fg("dim", hint), width),
	];
	hitRows = [];

	const shown = expanded ? list : list.slice(0, COLLAPSED_MAX);
	for (const row of shown) {
		const start = out.length;
		const { dot, text } = statusOf(row, theme);
		// the mode only deserves a column when the list mixes modes; collapsed keeps the name short so
		// the activity text stays readable (the expanded view shows it in full)
		const label = row.mode === "task" ? row.session : `${row.session} ${theme.fg("dim", row.mode)}`;
		const name = expanded ? label : truncateToWidth(label, 30, "…");
		out.push(truncateToWidth(`  ${dot} ${theme.fg("text", name)} ${theme.fg("dim", "│")} ${text}`, width));
		if (expanded) {
			const tail = row.tail.length > 0 ? row.tail : ["(no output yet)"];
			for (const line of tail) {
				if (out.length - start > TAIL_LINES) break;
				out.push(truncateToWidth(`      ${theme.fg("dim", line)}`, width));
			}
		}
		hitRows.push({ session: row.session, start, end: out.length - 1 });
	}
	if (!expanded && list.length > COLLAPSED_MAX) {
		out.push(theme.fg("muted", `  … ${list.length - COLLAPSED_MAX} more`));
	}
	if (out.length > EXPANDED_MAX) {
		out.splice(EXPANDED_MAX, out.length, theme.fg("dim", "  … list cut off, /attach for the full screen"));
	}
	return out;
}

/** Attach to an agent from a click. Fire and forget: the popup blocks until the user leaves it. */
function attachFromList(session: string): void {
	const ctx = ctxRef;
	if (!ctx) return;
	if (!overlayAvailable(ctx.mode)) {
		ctx.ui.notify(`Can't open an overlay here; run it yourself: ${manualAttachCmd(session)}`, "info");
		return;
	}
	void openAttach(session)
		.then((res) => {
			if (res.error) ctx.ui.notify(res.error, "error");
			else ctx.ui.notify(popupMsg(session, res.prefix ?? "Ctrl-b"), "info");
		})
		.catch(() => {
			/* display path: a failed popup must not break the session */
		});
}

/** Title row toggles collapsed/expanded; a row click attaches, so watching is one click even when collapsed. */
function onWidgetMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
	if (event.type !== "click" || event.button !== "left") return undefined;
	if (event.clickCount !== undefined && event.clickCount > 1) return { handled: true }; // let pi do word selection
	if (event.y === 0) {
		overrideExpanded = !isExpanded();
		return { handled: true };
	}
	const row = hitRows.find((r) => event.y >= r.start && event.y <= r.end);
	if (!row) return undefined;
	attachFromList(row.session);
	return { handled: true };
}

// ---------- lifecycle ----------

/**
 * The widget lives in a custom entry: appended at startup, replayed on restore and reload. Until
 * that entry is seen (wantWidget), polling stays off, so sessions without the marker cost nothing.
 */
export function registerAgentWidgetEntry(pi: ExtensionAPI): void {
	pi.registerEntryRenderer(AGENT_WIDGET_ENTRY, (_entry, options) => {
		// pi renders the entry before it renders the widget, so the state seen here is what the widget
		// render uses right after. A change means ctrl+o was pressed, so it wins over an earlier click.
		prevEntryExpanded = entryExpanded;
		entryExpanded = options.expanded;
		if (entryExpanded !== prevEntryExpanded) overrideExpanded = undefined;
		wantWidget = true;
		ensurePolling();
		return { render: () => [], invalidate: () => {} };
	});
}

/** Append the marker that creates the widget for this session. */
function appendAgentWidget(pi: ExtensionAPI): void {
	pi.appendEntry(AGENT_WIDGET_ENTRY, { note: "live sub-agent list widget" });
}

/** Wire the widget to the TUI: poll while the session runs, stop on the way out. */
export function setupAgentWidget(pi: ExtensionAPI): void {
	onEvent(
		pi,
		"session_start",
		{
			where: "ui/agent-widget.ts:start polling",
			note: "Interactive TUI only: poll tmux once a second and mirror this conversation's sub-agents above the editor",
		},
		(_event: unknown, ctx: ExtensionContext) => {
			if (ctx.mode !== "tui") return; // print / json / rpc have no widget
			ctxRef = ctx;
			overrideExpanded = undefined;
			entryExpanded = false;
			prevEntryExpanded = false;
			// A restored session already carries the marker entry; a fresh one gets it right here (the
			// entry renderer that pi runs for it flips wantWidget on).
			if (hasWidgetMarker(ctx)) wantWidget = true;
			else appendAgentWidget(pi);
			if (wantWidget) ensurePolling();
		},
	);

	onEvent(
		pi,
		"session_shutdown",
		{
			where: "ui/agent-widget.ts:stop polling",
			note: "Drop the widget and the timer so nothing is left behind after quit / reload / session switch",
		},
		() => {
			if (timer) {
				clearInterval(timer);
				timer = undefined;
			}
			if (ctxRef && installed) ctxRef.ui.setWidget(WIDGET_KEY, undefined);
			installed = false;
			wantWidget = false;
			widgetTui = undefined;
			rows.clear();
			hitRows = [];
			lastSig = "";
			ctxRef = undefined;
		},
	);
}

/** Does this session already carry the widget marker? (An empty list means no widget is shown.) */
function hasWidgetMarker(ctx: ExtensionContext): boolean {
	return ctx.sessionManager.getBranch().some((entry) => {
		const e = entry as { type?: string; customType?: string };
		return e.type === "custom" && e.customType === AGENT_WIDGET_ENTRY;
	});
}
