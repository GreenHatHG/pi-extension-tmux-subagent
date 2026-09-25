/**
 * advisor 配置读取（可选功能：默认关闭，显式配置才注册工具）。
 * 只负责「读 + 解析开关」，与工具定义（tools/advisor.ts）解耦。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface Config {
	advisor?: { enabled?: boolean; model?: string; vccCli?: string };
}

/** 读 ~/.pi/agent/subagent_advisor.json（PI_CODING_AGENT_DIR 可重定向）；不存在/损坏 = 空配置 */
function loadConfig(): Config {
	const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	const path = join(dir, "subagent_advisor.json");
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Config;
	} catch {
		return {};
	}
}

export interface AdvisorSettings {
	enabled: boolean;
	/** advisor 模型（pi --model 格式，如 "provider/id:high"）；undefined 不会沿用默认模型，而是不开 advisor（enabled: true 时提示补配置） */
	model?: string;
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
	const env = process.env.PI_ADVISOR_MODEL?.trim();
	if (env) return { enabled: true, model: env, vccCli: loadConfig().advisor?.vccCli };
	const a = loadConfig().advisor;
	if (!a || a.enabled === false) return { enabled: false };
	if (a.model?.trim()) return { enabled: true, model: a.model.trim(), vccCli: a.vccCli };
	if (a.enabled === true) return { enabled: false, missingModel: true };
	return { enabled: false };
}
