/**
 * 扩展入口（纯接线）：判断当前进程是主会话还是子 agent pane，然后按配置注册
 * 各功能。注册的完整清单见 registry.ts（所有 pi.on 都经 onEvent 登记）。
 *
 * 各职责的实现所在：
 * - core/：tmux 原语、会话命名与运行目录、advisor 配置解析、共享环境变量名（最底层）
 * - completion/：两条收尾路径（watchdog 交互式 / pi -p 批处理）的差异收敛
 * - modes/：task / advisor / web-research 三种模式的全部差异（brief 模板、预设 flag、
 *   附加环境注入），launchSub 只面向 SubagentMode 接口
 * - launch/：子 agent 启动编排（launchSub，含 ops 速查/等待说明文案）
 * - tools/：主会话侧的三个工具（spawn_sub / advisor / web_research）
 * - session/：子 agent 进程内的门禁、自检与联网引导（PI_SUBAGENT=1 / PI_SUB_WEB=1
 *   时生效，与主会话分属两个执行上下文）
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveAdvisor } from "./core/config";
import { shQuote } from "./core/tmux";
import { launchSub } from "./launch/launch";
import { advisorMode, taskMode, webResearchMode } from "./modes/types";
import { setupSelfCheck } from "./session/gate";
import { bootstrapWebResearch } from "./session/web-bootstrap";
import { notifyAdvisorMissingModel, setupAdvisor } from "./tools/advisor";
import { setupSpawnSub } from "./tools/spawn-sub";
import { setupWebResearch } from "./tools/web-research";

export default async function (pi: ExtensionAPI) {
	// web-research 子 agent 引导：必须在 setupSelfCheck 的子 agent 提前 return 之前执行。
	// 主会话进程无 PI_SUB_WEB，直接空操作；web-research 子 agent 进程在 load 阶段
	// 动态激活 pi-web-access 工具集（见 session/web-bootstrap.ts）。
	await bootstrapWebResearch(pi);

	// 子 agent pane 内（启动时经 tmux -e 注入 PI_SUBAGENT=1）不注册任何工具，直接返回：
	// 门禁无条件生效（防嵌套委派），watchdog 缺位的自检钩子是否注册由 setupSelfCheck
	// 按 PI_WATCHDOG 注入与否决定，见 session/gate.ts。
	if (setupSelfCheck(pi)) return;

	// ---------- advisor（可选功能，默认不注册：未配置时主模型看不到这个工具） ----------
	// enabled 蕴含 model 非空（resolveAdvisor 保证）：沿用默认模型就没有 advisor 的意义
	const advisor = resolveAdvisor();
	if (advisor.enabled && advisor.model) {
		const advisorModel = advisor.model;
		setupAdvisor(pi, advisorModel, (question, context, sessionFile) =>
			// 模型/thinking 完全由配置决定：这里只负责补 --model 预设（extraArgs 后值覆盖模式预设）；
			// sessionFile + vccCli 透传给简报的取证栏目（advisor 模式）
			launchSub(pi, question, context, advisorMode, [`--model ${shQuote(advisorModel)}`], {
				sessionFile,
				vccCli: advisor.vccCli,
			}),
		);
	} else if (advisor.missingModel) {
		// 配了 enabled: true 但没配模型：不开启，直接在会话里提示用户补配置
		notifyAdvisorMissingModel(pi);
	}

	// ---------- web_research（默认开启）----------
	setupWebResearch(pi, (question, context) => launchSub(pi, question, context, webResearchMode));

	// ---------- spawn_sub（任务模式，默认开启）----------
	setupSpawnSub(pi, (question, context) => launchSub(pi, question, context, taskMode));
}
