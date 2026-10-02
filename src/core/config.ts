/**
 * advisor 配置的读取与写入（可选功能：默认关闭，显式配置才注册工具）。
 *
 * - 读：resolveAdvisor() 解析开关与模型（扩展 load 时决定是否注册工具）；
 *   resolveAdvisorModel() 只看模型串——advisor 每次调用都新起子进程，
 *   所以 /advisor 面板改了模型/思考档位后，下次调用即生效。
 * - 写：writeAdvisorConfig() 由 /advisor 面板调用，读-改-写，保留 vccCli 与未知键。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** pi --model 串支持的思考档位（":" 后缀），与 pi 的 /thinking 档位一致 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

/** subagent_advisor.json 里 advisor 段落的字段（未知键保留写回） */
export interface AdvisorFileConfig {
	enabled?: boolean;
	/** pi --model 串，形如 "provider/id" 或 "provider/id:high"（thinking 内嵌在后缀） */
	model?: string;
	/** 当前主模型命中任一项时不启用 advisor；支持 * 通配符，也支持只写模型 id */
	disabledModels?: string[];
	/** pi-vcc 独立 CLI 调用命令（如 "pi-vcc" 或 "bun /path/to/pi-vcc/cli/main.ts"） */
	vccCli?: string;
	[key: string]: unknown;
}

/** 整个配置文件（顶层未知键也保留写回） */
interface Config {
	advisor?: AdvisorFileConfig;
	[key: string]: unknown;
}

/** pi 的 agent 目录（PI_CODING_AGENT_DIR 可重定向） */
export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** advisor 配置文件路径 */
export function advisorConfigPath(): string {
	return join(agentDir(), "subagent_advisor.json");
}

/** 读整个配置文件；不存在/损坏 = 空对象 */
function readConfig(): Config {
	const path = advisorConfigPath();
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Config;
	} catch {
		return {};
	}
}

/** 只读 advisor 段落（/advisor 面板展示用，不含默认值） */
export function readAdvisorFileConfig(): AdvisorFileConfig {
	return readConfig().advisor ?? {};
}

/** 从 pi --model 串拆出模型与思考档位；后缀不是已知档位则整串当作模型 */
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

/** 组装 pi --model 串（thinking 为空则不加后缀） */
export function formatModelSpec(model: string, thinking?: string): string {
	const m = model.trim();
	return thinking ? `${m}:${thinking}` : m;
}

/** 通配匹配配置中的模型 pattern；只支持 *，其余字符按字面量处理。 */
function wildcardModelMatch(value: string, pattern: string): boolean {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`, "i").test(value);
}

/**
 * 判断主模型是否命中 advisor.disabledModels。
 * 带 `/` 的 pattern 匹配完整的 provider/id；不带 `/` 的 pattern 只匹配 id。
 * 匹配不区分大小写，主模型的 thinking 后缀不参与匹配。
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
 * 只解析模型串（环境变量 PI_ADVISOR_MODEL > 配置文件），不看 enabled：
 * advisor 已注册时，模型/思考档位的改动下次调用即生效。
 */
export function resolveAdvisorModel(): string | undefined {
	const env = process.env.PI_ADVISOR_MODEL?.trim();
	if (env) return env;
	const m = readAdvisorFileConfig().model?.trim();
	return m || undefined;
}

export interface AdvisorSettings {
	enabled: boolean;
	/** advisor 模型（pi --model 格式，如 "provider/id:high"）；undefined 不会沿用默认模型，而是不开 advisor（enabled: true 时提示补配置） */
	model?: string;
	/** 当前主模型命中时禁用 advisor 的 pattern 列表 */
	disabledModels?: string[];
	/** 配了 enabled: true 但没配模型：不开，由 session_start 提示用户补配置 */
	missingModel?: boolean;
	/** pi-vcc 独立 CLI 调用命令（如 "bun /path/to/pi-vcc/cli/main.ts"；若已全局安装可填 "pi-vcc"）。
	 * 配置后 advisor 简报带「原始会话取证」栏目：用 bash 跑 recall CLI 恢复简报可能省略的原始输出；
	 * 未配置时不提供取证能力（简报会声明不可用）。 */
	vccCli?: string;
}

/**
 * advisor 是可选功能：默认不注册（零开销，主模型看不到这个工具）。开关即配置：
 * - 环境变量 PI_ADVISOR_MODEL 非空 → 开，且用该模型
 * - 配置文件 advisor.model 非空 → 开（配了模型即视为要用 advisor）
 * - 配置文件 advisor.enabled === true 但没配 model → 不开（advisor 的意义在更强的模型，
 *   沿用默认模型没有意义），由 session_start 里的 notify 提示用户补配置
 * - 其余情况（含 advisor.enabled === false、无配置）→ 关，不提示
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
 * 写回 advisor 配置（读-改-写，保留 vccCli 与未知键）。
 * `model` 传 null 或空串表示删除该字段。目录不存在则创建；先写临时文件再 rename。
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
