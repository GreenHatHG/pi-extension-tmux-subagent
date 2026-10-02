/**
 * advisor 快捷设置：`/advisor` 命令 + 页脚状态。
 *
 * 命令**始终注册**（与 advisor 是否启用无关）——否则关掉 advisor 后就再没有入口把它打开。
 *
 * 生效时机（用户选定）：
 * - 开关：工具是否注册在扩展 load 时决定 → **下次启动 pi 生效**
 * - 模型 / 思考档位：advisor 每次调用都新起子进程、现读配置 → **下次调用 advisor 生效**
 * - 页脚状态常驻显示「本会话已生效的开关 + 下次调用将使用的模型」，有未生效的开关改动时
 *   显示 `→on(重启)` / `→off(重启)`
 *
 * 面板只改 `subagent_advisor.json`（读-改-写，保留 vccCli 与未知键）。若设了环境变量
 * `PI_ADVISOR_MODEL`，它的优先级更高，面板会明确警告。
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

/** 会话启动时已生效（= 已决定工具是否注册）的 advisor 状态 */
export interface SessionAdvisor {
	enabled: boolean;
	model?: string;
	/** 当前主模型命中 advisor.disabledModels 时，工具被动态移除 */
	disabledByMainModel?: boolean;
}

const ENABLED_ON = "开启";
const ENABLED_OFF = "关闭";
const THINKING_DEFAULT = "(模型默认)";

/**
 * 模型支持的思考档位——与 pi 的 `getSupportedThinkingLevels`（@earendil-works/pi-ai）同构：
 * - `reasoning` 为假 → 只支持 `off`
 * - `thinkingLevelMap[level] === null` → 显式声明不支持，剔除
 * - `xhigh` / `max` 必须显式映射为字符串才支持（未映射视为不支持）
 *
 * 该函数未从 pi-coding-agent 导出，且 pi-ai 不是本包的声明依赖（运行时不一定能解析），
 * 故按同一算法本地实现，避免多引一份依赖。
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

/** 从 "provider/id:thinking" 里取 "id:thinking" 作页脚短标签 */
function shortModel(spec: string): string {
	const slash = spec.lastIndexOf("/");
	return slash >= 0 ? spec.slice(slash + 1) : spec;
}

/** 重绘页脚状态：开关取本会话已生效值，模型取下次调用将使用的值。
 * 环境变量 PI_ADVISOR_MODEL 优先于配置文件，此时文件里的开关改动不会生效，不显示 `→…`。 */
function paintStatus(ctx: ExtensionContext, session: SessionAdvisor): void {
	const theme = ctx.ui.theme;
	const file = readAdvisorFileConfig();
	const envOverride = !!process.env.PI_ADVISOR_MODEL?.trim();
	const nextModel = resolveAdvisorModel() ?? session.model;
	const parts: string[] = [];
	if (session.disabledByMainModel) {
		parts.push(theme.fg("muted", "advisor:off"));
		parts.push(theme.fg("warning", "（主模型禁用）"));
	} else if (session.enabled) {
		parts.push(theme.fg("accent", "advisor:on"));
		if (nextModel) parts.push(theme.fg("muted", `· ${shortModel(nextModel)}`));
		if (!envOverride && file.enabled === false) parts.push(theme.fg("warning", "→off(重启)"));
	} else {
		parts.push(theme.fg("muted", "advisor:off"));
		if (file.enabled === true) parts.push(theme.fg("accent", "→on(重启)"));
	}
	try {
		ctx.ui.setStatus("advisor", parts.join(" "));
	} catch {
		/* 状态栏不可用时静默（纯展示） */
	}
}

interface ModelChoice {
	value: string;
	provider: string;
	id: string;
	name: string;
	/** 该模型支持的思考档位（用于过滤思考档位行） */
	thinkingLevels: string[];
}

/** 模型候选：会话限定了模型就用限定集，否则用全部可用模型（已配 auth 的） */
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

/** 思考档位行可选值：`(模型默认)` + 该模型支持的档位。模型未知（未设置 / 自定义）时列出全部档位。 */
function thinkingValuesFor(models: ModelChoice[], modelValue: string): string[] {
	const levels = models.find((m) => m.value === modelValue)?.thinkingLevels ?? [...THINKING_LEVELS];
	return [THINKING_DEFAULT, ...levels];
}

type PickerRow = { kind: "model"; item: ModelChoice } | { kind: "custom"; value: string };

/**
 * 模型选择子菜单：输入即模糊过滤（id/provider/name），回车确认。
 * 输入串非空且不等于任何候选时，列表顶部给一条「使用自定义」——覆盖本地 catalogue 里没有
 * 但子 agent 的 pi 能解析的模型。Esc 返回不选。
 */
function buildModelPicker(
	models: ModelChoice[],
	currentBare: string,
	theme: Theme,
	done: (value?: string) => void,
): Component {
	const input = new Input({ placeholder: "输入以搜索模型…" });
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
			const lines: string[] = [theme.fg("accent", theme.bold("选择 advisor 模型"))];
			lines.push(...input.render(width));
			lines.push("");
			const maxVisible = 12;
			const start = Math.max(0, Math.min(selected - Math.floor(maxVisible / 2), rows.length - maxVisible));
			const end = Math.min(start + maxVisible, rows.length);
			if (rows.length === 0) {
				lines.push(theme.fg("muted", "  无匹配模型"));
			}
			for (let i = start; i < end; i++) {
				const row = rows[i];
				if (!row) continue;
				const isSel = i === selected;
				const cursor = isSel ? theme.fg("accent", "→ ") : "  ";
				if (row.kind === "custom") {
					lines.push(cursor + theme.fg("warning", `✎ 使用自定义：${row.value}`));
					continue;
				}
				const check = row.item.value === currentBare ? theme.fg("accent", "✓ ") : "  ";
				const text = `${row.item.id} ${theme.fg("muted", `[${row.item.provider}]`)}`;
				lines.push(cursor + check + (isSel ? theme.fg("accent", text) : text));
			}
			if (start > 0 || end < rows.length) {
				lines.push(theme.fg("muted", `  (${selected + 1}/${rows.length})`));
			}
			lines.push(theme.fg("dim", "↑↓ 选择 · Enter 确认 · Esc 返回 · 输入即搜索"));
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

/** 打开交互面板：开关 / 模型 / 思考档位（vccCli 只读）。改动即时保存。 */
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
		container.addChild(new Text(theme.fg("accent", theme.bold("advisor 设置")), 0, 0));
		if (envOverride) {
			container.addChild(
				new Text(
					theme.fg(
						"warning",
						`环境变量 PI_ADVISOR_MODEL=${envOverride} 优先级更高，将覆盖此处的模型：下面改模型不会生效`,
					),
					0,
					0,
				),
			);
		}
		container.addChild(
			new Text(theme.fg("muted", "模型 / 思考档位：下次调用 advisor 生效　·　开关：下次启动 pi 生效"), 0, 0),
		);

		let list: SettingsList;

		/** 写回配置；失败（只读目录/磁盘）时提示并返回 false，由调用方回滚草稿 */
		function persist(patch: { enabled?: boolean; model?: string | null }): boolean {
			try {
				writeAdvisorConfig(patch);
				return true;
			} catch (err) {
				ctx.ui.notify(`advisor 配置写入失败：${err instanceof Error ? err.message : String(err)}`, "error");
				return false;
			}
		}

		const thinkingItem: SettingItem = {
			id: "thinking",
			label: "思考档位",
			description: "仅列出该模型支持的档位，追加在模型串后（下次调用 advisor 生效）",
			currentValue: draftThinking ?? THINKING_DEFAULT,
			values: thinkingValuesFor(models, draftModel),
		};

		const items: SettingItem[] = [
			{
				id: "enabled",
				label: "启用",
				description: "关闭后主模型看不到 advisor 工具（下次启动 pi 生效）",
				currentValue: draftEnabled ? ENABLED_ON : ENABLED_OFF,
				values: [ENABLED_ON, ENABLED_OFF],
			},
			{
				id: "model",
				label: "模型",
				description: "advisor 子 agent 使用的模型（下次调用 advisor 生效）",
				currentValue: draftModel || "(未设置)",
				submenu: (_current, subDone) => buildModelPicker(models, draftModel, theme, (value) => subDone(value)),
			},
			thinkingItem,
			{
				id: "vccCli",
				label: "vccCli",
				description: "原始会话取证 CLI（只读，请直接编辑 subagent_advisor.json）",
				currentValue: file.vccCli || "(未配置)",
			},
		];

		function applyChange(id: string, newValue: string): void {
			if (id === "enabled") {
				const want = newValue === ENABLED_ON;
				if (want && !draftModel) {
					ctx.ui.notify("请先选择模型，再开启 advisor", "warning");
					list.updateValue("enabled", ENABLED_OFF);
					return;
				}
				if (!persist({ enabled: want })) {
					list.updateValue("enabled", draftEnabled ? ENABLED_ON : ENABLED_OFF);
					return;
				}
				draftEnabled = want;
				ctx.ui.notify(`advisor 已${want ? "开启" : "关闭"}：下次启动 pi 生效`, "info");
			} else if (id === "model") {
				const allowed = thinkingValuesFor(models, newValue);
				thinkingItem.values = allowed;
				// 新模型不支持当前思考档位时重置为模型默认，避免存下无效后缀
				const nextThinking =
					draftThinking !== undefined && !allowed.includes(draftThinking) ? undefined : draftThinking;
				const spec = formatModelSpec(newValue, nextThinking);
				if (!persist({ model: spec })) {
					list.updateValue("model", draftModel || "(未设置)");
					thinkingItem.values = thinkingValuesFor(models, draftModel);
					return;
				}
				draftModel = newValue;
				const wasReset = nextThinking !== draftThinking;
				if (wasReset) {
					draftThinking = nextThinking;
					list.updateValue("thinking", THINKING_DEFAULT);
				}
				const resetNote = wasReset ? "（新模型不支持原思考档位，已重置为模型默认）" : "";
				ctx.ui.notify(`advisor 模型已保存：下次调用使用 ${spec}${resetNote}`, "info");
			} else if (id === "thinking") {
				if (!draftModel) {
					ctx.ui.notify("请先选择模型，再设置思考档位", "warning");
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
				ctx.ui.notify(`advisor 思考档位已保存：下次调用使用 ${spec}`, "info");
			}
			paintStatus(ctx, session);
		}

		list = new SettingsList(items, items.length, getSettingsListTheme(), applyChange, () => done(true));
		container.addChild(list);
		container.addChild(
			new Text(theme.fg("dim", "↑↓ 选择 · Enter/Space 切换或进入 · Esc 关闭（改动已即时保存）"), 0, 0),
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
 * 注册 `/advisor` 命令与页脚状态。始终调用（enabled 与否无关）。
 *
 * @param session 扩展 load 时解析出的 advisor 状态（决定工具是否注册、页脚显示的本会话开关）
 */
export function setupAdvisorSettings(pi: ExtensionAPI, session: SessionAdvisor): void {
	pi.registerCommand("advisor", {
		description: "配置 advisor：开关 / 模型 / 思考档位（模型与思考下次调用生效，开关下次启动 pi 生效）",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/advisor 需要 TUI 模式", "error");
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
			where: "tools/advisor-settings.ts:页脚状态",
			note: "会话启动时在页脚常驻显示 advisor 当前生效状态（开关=本会话，模型=下次调用）",
		},
		paint,
	);
	onEvent(
		pi,
		"model_select",
		{
			where: "tools/advisor-settings.ts:页脚状态",
			note: "切换主模型后刷新 advisor 页脚状态",
		},
		paint,
	);
}
