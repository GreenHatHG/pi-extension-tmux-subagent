/**
 * 模式框架：task / advisor / web-research 三种委派模式的全部差异收敛为一份
 * SubagentMode 描述对象。launchSub 只面向这个接口，不再按模式 if-else 散布；
 * 新增第四种模式 = 在本目录加一个实例 + 必要时补一份 brief/preset，其他文件零改动。
 *
 * 模式差异的四个维度：
 * - brief：子 agent 简报模板（唯一上下文来源）→ briefs.ts
 * - presetFlags：子 agent pi 的预设 CLI flag → presets.ts
 * - extraEnvArgs：附加的 tmux -e 环境注入（如 web-research 的联网引导开关）
 * - 附加系统提示词/工具集整形（advisor 用 CLI 预设；web-research 在子 agent 进程内
 *   完成，见 session/web-bootstrap.ts，不属于本接口）
 */
import { ENV_SUB_WEB } from "../core/env";
import { buildAdvisorBrief, buildTaskBrief, buildWebResearchBrief } from "./briefs";
import { advisorPresetFlags, webResearchPresetFlags } from "./presets";

export type ModeName = "task" | "advisor" | "web-research";

export interface SubagentMode {
	name: ModeName;
	/** 子 agent 简报模板 */
	brief(question: string, context: string | undefined, artifactPath: string, useWatchdog: boolean): string;
	/**
	 * 子 agent pi 的预设 CLI flag（放在启动参数最前面；调用方 extraArgs 在后可覆盖
	 * 同名单值 flag——pi 对 --model/--tools/--system-prompt 是后值覆盖前值）。
	 */
	presetFlags(useWatchdog: boolean): string[];
	/** 附加 tmux -e 环境注入（已成对：flag 名与值交替）。收尾协议的差异不在模式，见 completion/。 */
	extraEnvArgs(): string[];
}

export const taskMode: SubagentMode = {
	name: "task",
	brief: buildTaskBrief,
	presetFlags: () => [],
	extraEnvArgs: () => [],
};

export const advisorMode: SubagentMode = {
	name: "advisor",
	brief: buildAdvisorBrief,
	presetFlags: advisorPresetFlags,
	extraEnvArgs: () => [],
};

export const webResearchMode: SubagentMode = {
	name: "web-research",
	brief: buildWebResearchBrief,
	presetFlags: () => webResearchPresetFlags(),
	// web-research 引导：子 agent 进程的扩展 factory 检测到该变量后在 load 阶段
	// 动态激活 pi-web-access 工具集（见 session/web-bootstrap.ts）
	extraEnvArgs: () => ["-e", `${ENV_SUB_WEB}=1`],
};
