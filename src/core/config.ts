/**
 * Read and write advisor config (optional feature: off by default, tools only registered when
 * explicitly configured).
 * Two read spots: resolveAdvisor() decides at extension load whether to register the tool;
 * resolveAdvisorModel() reads the model string at call time — advisor starts a fresh subprocess
 * per call, so a model/thinking change in the /advisor panel takes effect on the next call.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Thinking levels pi --model accepts (the ":" suffix), same as pi's /thinking levels. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

/** advisor section fields in subagent_advisor.json (unknown keys are kept on write). */
export interface AdvisorFileConfig {
	enabled?: boolean;
	/** pi --model string, like "provider/id" or "provider/id:high" (thinking sits in the suffix). */
	model?: string;
	/** Advisor is off when the current main model matches one of these; supports * wildcards and plain model ids. */
	disabledModels?: string[];
	/** Standalone pi-vcc CLI command (e.g. "pi-vcc" or "bun /path/to/pi-vcc/cli/main.ts"). */
	vccCli?: string;
	[key: string]: unknown;
}

/** The whole config file; unknown top-level keys are kept on write. */
interface Config {
	advisor?: AdvisorFileConfig;
	[key: string]: unknown;
}

/** pi agent dir (PI_CODING_AGENT_DIR can redirect it). */
export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** Path to the advisor config file. */
export function advisorConfigPath(): string {
	return join(agentDir(), "subagent_advisor.json");
}

/** Read the whole config file; missing or broken = empty object. */
function readConfig(): Config {
	const path = advisorConfigPath();
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Config;
	} catch {
		return {};
	}
}

/** Read only the advisor section (for the /advisor panel; no defaults). */
export function readAdvisorFileConfig(): AdvisorFileConfig {
	return readConfig().advisor ?? {};
}

/** Split model and thinking out of a pi --model string; if the suffix is not a known level, the whole string is the model. */
export function parseModelSpec(spec: string | undefined): { model: string; thinking?: ThinkingLevelName } {
	const s = spec?.trim();
	if (!s) return { model: "" };
	const i = s.lastIndexOf(":");
	if (i <= 0) return { model: s };
	const tail = s.slice(i + 1);
	if ((THINKING_LEVELS as readonly string[]).includes(tail)) {
		return { model: s.slice(0, i), thinking: tail as ThinkingLevelName };
	}
	return { model: s };
}

/** Build a pi --model string (no suffix when thinking is empty). */
export function formatModelSpec(model: string, thinking?: string): string {
	const m = model.trim();
	return thinking ? `${m}:${thinking}` : m;
}

/** Match a model pattern from config; only * is special, everything else is literal. */
function wildcardModelMatch(value: string, pattern: string): boolean {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`, "i").test(value);
}

/**
 * Check whether the main model hits advisor.disabledModels.
 * A pattern with "/" matches the full provider/id; one without "/" matches only the id.
 * Matching ignores case, and the main model's thinking suffix is ignored.
 */
export function isModelDisabled(patterns: readonly unknown[] | undefined, modelSpec: string | undefined): boolean {
	const model = parseModelSpec(modelSpec).model.toLowerCase();
	if (!model || !patterns) return false;
	const slash = model.indexOf("/");
	const modelId = slash >= 0 ? model.slice(slash + 1) : model;
	const fullModel = slash >= 0 ? model : `/${model}`;
	for (const raw of patterns) {
		if (typeof raw !== "string") continue;
		const pattern = raw.trim().toLowerCase();
		if (!pattern) continue;
		if (pattern.includes("/")) {
			if (wildcardModelMatch(fullModel, pattern)) return true;
		} else if (wildcardModelMatch(modelId, pattern)) {
			return true;
		}
	}
	return false;
}

function normalizeDisabledModels(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const models = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	return models.length > 0 ? models : undefined;
}

/**
 * Read only the model string (env PI_ADVISOR_MODEL > config file), ignoring enabled.
 */
export function resolveAdvisorModel(): string | undefined {
	const env = process.env.PI_ADVISOR_MODEL?.trim();
	if (env) return env;
	const m = readAdvisorFileConfig().model?.trim();
	return m || undefined;
}

export interface AdvisorSettings {
	enabled: boolean;
	/** advisor model (pi --model format, e.g. "provider/id:high"); undefined means off, not "use the default model" (with enabled: true we tell the user to add config). */
	model?: string;
	/** Patterns that turn advisor off when the current main model matches. */
	disabledModels?: string[];
	/** enabled: true but no model: stay off, and session_start tells the user to add config. */
	missingModel?: boolean;
	/** Standalone pi-vcc CLI command (e.g. "pi-vcc"). When set, the advisor brief gets a "raw session forensics" section (recall CLI recovers raw output the brief may drop); when unset, forensics is declared unavailable. */
	vccCli?: string;
}

/**
 * Turning it on is the config: env PI_ADVISOR_MODEL or config advisor.model non-empty -> on with
 * that model; enabled: true but no model -> off (advisor is pointless without a stronger model),
 * and session_start tells the user to add config; anything else (enabled: false, no config) -> off.
 */
export function resolveAdvisor(): AdvisorSettings {
	const a = readAdvisorFileConfig();
	const disabledModels = normalizeDisabledModels(a.disabledModels);
	const env = process.env.PI_ADVISOR_MODEL?.trim();
	if (env) return { enabled: true, model: env, disabledModels, vccCli: a.vccCli };
	if (a.enabled === false) return { enabled: false, disabledModels };
	if (a.model?.trim()) return { enabled: true, model: a.model.trim(), disabledModels, vccCli: a.vccCli };
	if (a.enabled === true) return { enabled: false, disabledModels, missingModel: true };
	return { enabled: false, disabledModels };
}

/**
 * Write advisor config back (read-modify-write, keeps vccCli and unknown keys).
 * `model` null or empty string deletes the field; creates the dir if missing, and writes a temp
 * file first then renames.
 */
export function writeAdvisorConfig(patch: { enabled?: boolean; model?: string | null }): void {
	const path = advisorConfigPath();
	const cfg = readConfig();
	const advisor: AdvisorFileConfig = { ...(cfg.advisor ?? {}) };
	if (patch.enabled !== undefined) advisor.enabled = patch.enabled;
	if (patch.model !== undefined) {
		if (patch.model) advisor.model = patch.model;
		else delete advisor.model;
	}
	cfg.advisor = advisor;
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
}
