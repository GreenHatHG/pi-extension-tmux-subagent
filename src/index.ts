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
 * - tools/：主会话侧的三个工具（spawn_sub / advisor / web_research）；advisor 的 /advisor
 *   快捷设置命令与页脚状态在 tools/advisor-settings.ts（始终注册）
 * - ui/：主会话 TUI 呈现（/attach 实时围观窗口，attach 到 pi-sub 上的子 agent pane）
 * - session/：子 agent 进程内的门禁、自检与联网引导（PI_SUBAGENT=1 / PI_SUB_WEB=1
 *   时生效，与主会话分属两个执行上下文）
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveAdvisor, resolveAdvisorModel } from "./core/config";
import { shQuote } from "./core/tmux";
import { launchSub } from "./launch/launch";
import { advisorMode, taskMode, webResearchMode } from "./modes/types";
import { setupSelfCheck } from "./session/gate";
import { bootstrapWebResearch } from "./session/web-bootstrap";
import { notifyAdvisorMissingModel, setupAdvisor, setupAdvisorModelGuard } from "./tools/advisor";
import { type SessionAdvisor, setupAdvisorSettings } from "./tools/advisor-settings";
import { setupSpawnSub } from "./tools/spawn-sub";
import { setupWebResearch } from "./tools/web-research";
import { setupAttachCommand } from "./ui/attach-command";

export default async function (pi: ExtensionAPI) {
	// web-research 子 agent 引导：必须在 setupSelfCheck 的子 agent 提前 return 之前执行。
	// 主会话进程无 PI_SUB_WEB，直接空操作；web-research 子 agent 进程在 load 阶段
	// 动态激活 pi-web-access 工具集（见 session/web-bootstrap.ts）。
	await bootstrapWebResearch(pi);

	// 子 agent pane 内（启动时经 tmux -e 注入 PI_SUBAGENT=1）不注册任何工具，直接返回：
	// 门禁无条件生效（防嵌套委派），watchdog 缺位的自检钩子是否注册由 setupSelfCheck
	// 按 PI_WATCHDOG 注入与否决定，见 session/gate.ts。
	if (setupSelfCheck(pi)) return;

	// ---------- /attach 实时围观窗口 ----------
	// 在用户自己的 tmux 里 new-window，attach 到 pi-sub 的某个子 agent 会话：
	// 主会话侧查看子 agent 执行过程的唯一入口（真实画面、可交互、随时 detach）。
	setupAttachCommand(pi);

	// ---------- advisor（可选功能，默认不注册：未配置时主模型看不到这个工具） ----------
	// enabled 蕴含 model 非空（resolveAdvisor 保证）：沿用默认模型就没有 advisor 的意义
	const advisor = resolveAdvisor();
	const advisorSession: SessionAdvisor = { enabled: advisor.enabled, model: advisor.model };
	// 过滤器必须先于页脚/启动提示注册：session_start 时先根据 ctx.model 更新状态，
	// 再让后续 handler 展示最终状态。
	if (advisor.enabled && advisor.model) {
		setupAdvisorModelGuard(pi, advisor.disabledModels, advisorSession);
	}
	// 快捷设置命令始终注册（与 enabled 无关）：否则关掉 advisor 后就没有入口把它重新打开
	setupAdvisorSettings(pi, advisorSession);
	if (advisor.enabled && advisor.model) {
		const sessionModel = advisor.model;
		setupAdvisor(pi, sessionModel, (question, context, sessionFile) => {
			// 模型/思考档位每次调用现读配置（/advisor 面板改了下一次调用即生效）；
			// 读不到（被清空）则回退会话启动时的模型。sessionFile + vccCli 透传给简报取证栏目。
			const model = resolveAdvisorModel() ?? sessionModel;
			return launchSub(pi, question, context, advisorMode, [`--model ${shQuote(model)}`], {
				sessionFile,
				vccCli: advisor.vccCli,
			});
		});
	} else if (advisor.missingModel) {
		// 配了 enabled: true 但没配模型：不开启，直接在会话里提示用户补配置
		notifyAdvisorMissingModel(pi);
	}

	// ---------- web_research（默认开启）----------
	setupWebResearch(pi, (question, context) => launchSub(pi, question, context, webResearchMode));

	// ---------- spawn_sub（任务模式，默认开启）----------
	setupSpawnSub(pi, (question, context) => launchSub(pi, question, context, taskMode));
}
