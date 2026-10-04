/**
 * Advisor quick settings: the `/advisor` command + footer status. The command is always registered
 * (regardless of enabled), else there is no way to turn advisor back on once it is off.
 *
 * When changes apply: the on/off switch is decided at extension load (takes effect next pi start);
 * model/thinking are read from config each call (take effect next call). The footer shows the switch
 * in effect for this session + the model the next call will use; a switch change not yet in effect
 * shows `→on(restart)` / `→off(restart)`. When the PI_ADVISOR_MODEL env var is set it wins, and the
 * panel warns about it.
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	fuzzyFilter,
	getKeybindings,
	Input,
	type SettingItem,
	SettingsList,
	Text,
} from "@earendil-works/pi-tui";
import {
	formatModelSpec,
	parseModelSpec,
	readAdvisorFileConfig,
	resolveAdvisorModel,
	THINKING_LEVELS,
	writeAdvisorConfig,
} from "../core/config";
import { onEvent } from "../registry";

/** Advisor state in effect at session start (= whether the tool got registered). */
export interface SessionAdvisor {
	enabled: boolean;
	model?: string;
	/** Removed dynamically when the current main model hits advisor.disabledModels. */
	disabledByMainModel?: boolean;
}

const ENABLED_ON = "on";
const ENABLED_OFF = "off";
const THINKING_DEFAULT = "(model default)";

/**
 * Thinking levels the model supports, same as pi's getSupportedThinkingLevels: reasoning false ->
 * off only; thinkingLevelMap[level] === null is dropped; xhigh/max must be mapped explicitly. That
 * function is not exported from pi-coding-agent and pi-ai is not a declared dep of this package, so
 * we implement the same algorithm locally.
 */
function supportedThinkingLevels(model: {
	reasoning: boolean;
	thinkingLevelMap?: Partial<Record<string, string | null>>;
}): string[] {
	if (!model.reasoning) return ["off"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

/** Take "id:thinking" out of "provider/id:thinking" for the footer's short label. */
function shortModel(spec: string): string {
	const slash = spec.lastIndexOf("/");
	return slash >= 0 ? spec.slice(slash + 1) : spec;
}

/** Repaint the footer status: the switch uses this session's in-effect value, the model uses the value the next call will use. */
function paintStatus(ctx: ExtensionContext, session: SessionAdvisor): void {
	const theme = ctx.ui.theme;
	const file = readAdvisorFileConfig();
	const envOverride = !!process.env.PI_ADVISOR_MODEL?.trim();
	const nextModel = resolveAdvisorModel() ?? session.model;
	const parts: string[] = [];
	if (session.disabledByMainModel) {
		parts.push(theme.fg("muted", "advisor:off"));
		parts.push(theme.fg("warning", "(disabled by main model)"));
	} else if (session.enabled) {
		parts.push(theme.fg("accent", "advisor:on"));
		if (nextModel) parts.push(theme.fg("muted", `· ${shortModel(nextModel)}`));
		if (!envOverride && file.enabled === false) parts.push(theme.fg("warning", "→off(restart)"));
	} else {
		parts.push(theme.fg("muted", "advisor:off"));
		if (file.enabled === true) parts.push(theme.fg("accent", "→on(restart)"));
	}
	try {
		ctx.ui.setStatus("advisor", parts.join(" "));
	} catch {
		/* stay quiet when the status bar is unavailable (display only) */
	}
}

interface ModelChoice {
	value: string;
	provider: string;
	id: string;
	name: string;
	/** Thinking levels this model supports (used to filter the thinking rows). */
	thinkingLevels: string[];
}

/** Model candidates: use the scoped set if the session scopes models, else all available models. */
function collectModels(ctx: ExtensionContext): ModelChoice[] {
	const scoped = ctx.scopedModels;
	const list = scoped.length > 0 ? scoped.map((s) => s.model) : ctx.modelRegistry.getAvailable();
	const seen = new Set<string>();
	const out: ModelChoice[] = [];
	for (const m of list) {
		const value = `${m.provider}/${m.id}`;
		if (seen.has(value)) continue;
		seen.add(value);
		out.push({
			value,
			provider: m.provider,
			id: m.id,
			name: m.name,
			thinkingLevels: supportedThinkingLevels(m),
		});
	}
	out.sort((a, b) => a.value.localeCompare(b.value));
	return out;
}

/** Thinking row values: `(model default)` + the levels this model supports. When the model is unknown, list all levels. */
function thinkingValuesFor(models: ModelChoice[], modelValue: string): string[] {
	const levels = models.find((m) => m.value === modelValue)?.thinkingLevels ?? [...THINKING_LEVELS];
	return [THINKING_DEFAULT, ...levels];
}

type PickerRow = { kind: "model"; item: ModelChoice } | { kind: "custom"; value: string };

/**
 * Model submenu: typing filters live (id/provider/name), Enter confirms. When the typed text is
 * non-empty and matches no candidate, a "use custom" row appears at the top. Esc returns without a pick.
 */
function buildModelPicker(
	models: ModelChoice[],
	currentBare: string,
	theme: Theme,
	done: (value?: string) => void,
): Component {
	const input = new Input({ placeholder: "Type to search models…" });
	input.focused = true;
	let rows: PickerRow[] = [];
	let selected = 0;

	function rebuild(): void {
		const q = input.getValue().trim();
		const matched = q ? fuzzyFilter(models, q, (m) => `${m.id} ${m.provider} ${m.name}`) : models;
		rows = matched.map((m) => ({ kind: "model", item: m }));
		if (q && !models.some((m) => m.value === q)) {
			rows = [{ kind: "custom", value: q }, ...rows];
		}
		selected = 0;
		if (!q) {
			const i = rows.findIndex((r) => r.kind === "model" && r.item.value === currentBare);
			if (i >= 0) selected = i;
		}
	}
	rebuild();

	function pick(): void {
		const row = rows[selected];
		if (!row) return;
		done(row.kind === "model" ? row.item.value : row.value);
	}

	return {
		render(width: number) {
			const lines: string[] = [theme.fg("accent", theme.bold("Pick advisor model"))];
			lines.push(...input.render(width));
			lines.push("");
			const maxVisible = 12;
			const start = Math.max(0, Math.min(selected - Math.floor(maxVisible / 2), rows.length - maxVisible));
			const end = Math.min(start + maxVisible, rows.length);
			if (rows.length === 0) {
				lines.push(theme.fg("muted", "  no matching model"));
			}
			for (let i = start; i < end; i++) {
				const row = rows[i];
				if (!row) continue;
				const isSel = i === selected;
				const cursor = isSel ? theme.fg("accent", "→ ") : "  ";
				if (row.kind === "custom") {
					lines.push(cursor + theme.fg("warning", `✎ use custom: ${row.value}`));
					continue;
				}
				const check = row.item.value === currentBare ? theme.fg("accent", "✓ ") : "  ";
				const text = `${row.item.id} ${theme.fg("muted", `[${row.item.provider}]`)}`;
				lines.push(cursor + check + (isSel ? theme.fg("accent", text) : text));
			}
			if (start > 0 || end < rows.length) {
				lines.push(theme.fg("muted", `  (${selected + 1}/${rows.length})`));
			}
			lines.push(theme.fg("dim", "↑↓ select · Enter confirm · Esc back · typing searches"));
			return lines;
		},
		invalidate() {
			input.invalidate();
		},
		handleInput(data: string) {
			const kb = getKeybindings();
			if (kb.matches(data, "tui.select.up")) {
				if (rows.length) selected = selected === 0 ? rows.length - 1 : selected - 1;
			} else if (kb.matches(data, "tui.select.down")) {
				if (rows.length) selected = selected === rows.length - 1 ? 0 : selected + 1;
			} else if (kb.matches(data, "tui.select.confirm")) {
				pick();
			} else if (kb.matches(data, "tui.select.cancel")) {
				done();
			} else {
				input.handleInput(data);
				rebuild();
			}
		},
	};
}

/** Open the interactive panel: switch / model / thinking level (vccCli is read-only). Changes save right away. */
async function openAdvisorPanel(ctx: ExtensionContext, session: SessionAdvisor): Promise<void> {
	const file = readAdvisorFileConfig();
	const envOverride = process.env.PI_ADVISOR_MODEL?.trim();
	const parsed = parseModelSpec(file.model);
	let draftEnabled = file.enabled !== false && !!parsed.model;
	let draftModel = parsed.model;
	let draftThinking: string | undefined = parsed.thinking;
	const models = collectModels(ctx);

	await ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("advisor settings")), 0, 0));
		if (envOverride) {
			container.addChild(
				new Text(
					theme.fg(
						"warning",
						`Env var PI_ADVISOR_MODEL=${envOverride} wins and overrides the model here: changing the model below has no effect`,
					),
					0,
					0,
				),
			);
		}
		container.addChild(
			new Text(
				theme.fg("muted", "Model / thinking level: apply next advisor call　·　Switch: applies next pi start"),
				0,
				0,
			),
		);

		let list: SettingsList;

		/** Write the config back; on failure (read-only dir/disk) notify and return false so the caller can roll back the draft. */
		function persist(patch: { enabled?: boolean; model?: string | null }): boolean {
			try {
				writeAdvisorConfig(patch);
				return true;
			} catch (err) {
				ctx.ui.notify(`Failed to write advisor config: ${err instanceof Error ? err.message : String(err)}`, "error");
				return false;
			}
		}

		const thinkingItem: SettingItem = {
			id: "thinking",
			label: "Thinking level",
			description:
				"Lists only the levels this model supports, appended to the model string (applies next advisor call)",
			currentValue: draftThinking ?? THINKING_DEFAULT,
			values: thinkingValuesFor(models, draftModel),
		};

		const items: SettingItem[] = [
			{
				id: "enabled",
				label: "Enabled",
				description: "When off, the main model can't see the advisor tool (applies next pi start)",
				currentValue: draftEnabled ? ENABLED_ON : ENABLED_OFF,
				values: [ENABLED_ON, ENABLED_OFF],
			},
			{
				id: "model",
				label: "Model",
				description: "Model the advisor sub-agent uses (applies next advisor call)",
				currentValue: draftModel || "(not set)",
				submenu: (_current, subDone) => buildModelPicker(models, draftModel, theme, (value) => subDone(value)),
			},
			thinkingItem,
			{
				id: "vccCli",
				label: "vccCli",
				description: "Raw session forensics CLI (read-only; edit subagent_advisor.json directly)",
				currentValue: file.vccCli || "(not configured)",
			},
		];

		function applyChange(id: string, newValue: string): void {
			if (id === "enabled") {
				const want = newValue === ENABLED_ON;
				if (want && !draftModel) {
					ctx.ui.notify("Pick a model first, then turn advisor on", "warning");
					list.updateValue("enabled", ENABLED_OFF);
					return;
				}
				if (!persist({ enabled: want })) {
					list.updateValue("enabled", draftEnabled ? ENABLED_ON : ENABLED_OFF);
					return;
				}
				draftEnabled = want;
				ctx.ui.notify(`advisor ${want ? "on" : "off"}: applies next pi start`, "info");
			} else if (id === "model") {
				const allowed = thinkingValuesFor(models, newValue);
				thinkingItem.values = allowed;
				// When the new model does not support the current thinking level, reset to the model default so we don't save a bad suffix
				const nextThinking =
					draftThinking !== undefined && !allowed.includes(draftThinking) ? undefined : draftThinking;
				const spec = formatModelSpec(newValue, nextThinking);
				if (!persist({ model: spec })) {
					list.updateValue("model", draftModel || "(not set)");
					thinkingItem.values = thinkingValuesFor(models, draftModel);
					return;
				}
				draftModel = newValue;
				const wasReset = nextThinking !== draftThinking;
				if (wasReset) {
					draftThinking = nextThinking;
					list.updateValue("thinking", THINKING_DEFAULT);
				}
				const resetNote = wasReset
					? " (new model does not support the old thinking level, reset to model default)"
					: "";
				ctx.ui.notify(`advisor model saved: next call uses ${spec}${resetNote}`, "info");
			} else if (id === "thinking") {
				if (!draftModel) {
					ctx.ui.notify("Pick a model first, then set the thinking level", "warning");
					list.updateValue("thinking", draftThinking ?? THINKING_DEFAULT);
					return;
				}
				const nextThinking = newValue === THINKING_DEFAULT ? undefined : newValue;
				const spec = formatModelSpec(draftModel, nextThinking);
				if (!persist({ model: spec })) {
					list.updateValue("thinking", draftThinking ?? THINKING_DEFAULT);
					return;
				}
				draftThinking = nextThinking;
				ctx.ui.notify(`advisor thinking level saved: next call uses ${spec}`, "info");
			}
			paintStatus(ctx, session);
		}

		list = new SettingsList(items, items.length, getSettingsListTheme(), applyChange, () => done(true));
		container.addChild(list);
		container.addChild(
			new Text(theme.fg("dim", "↑↓ select · Enter/Space toggle or open · Esc close (changes save right away)"), 0, 0),
		);
		container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				list.handleInput?.(data);
				tui.requestRender();
			},
		};
	});
}

/**
 * Register the `/advisor` command and the footer status.
 *
 * @param session advisor state resolved at extension load (decides whether the tool is registered,
 *                and the switch the footer shows for this session)
 */
export function setupAdvisorSettings(pi: ExtensionAPI, session: SessionAdvisor): void {
	pi.registerCommand("advisor", {
		description:
			"Configure advisor: switch / model / thinking level (model and thinking apply next call, switch applies next pi start)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/advisor needs TUI mode", "error");
				return;
			}
			await openAdvisorPanel(ctx, session);
		},
	});

	const paint = (_event: unknown, ctx: ExtensionContext) => {
		paintStatus(ctx, session);
	};
	onEvent(
		pi,
		"session_start",
		{
			where: "tools/advisor-settings.ts:footer status",
			note: "Show advisor's current in-effect state in the footer at session start (switch = this session, model = next call)",
		},
		paint,
	);
	onEvent(
		pi,
		"model_select",
		{
			where: "tools/advisor-settings.ts:footer status",
			note: "Refresh the advisor footer after a main-model switch",
		},
		paint,
	);
}
