import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { SOCKET } from "./tmux";

/** 本模块文件路径：jiti（CJS 变换）注入 __filename；纯 ESM 上下文退回 import.meta.url */
function selfModulePath(): string {
	if (typeof __filename === "string") return __filename;
	return fileURLToPath(import.meta.url);
}

/**
 * 解析 pi-web-access 扩展入口，不写死任何绝对路径。依次尝试：
 * 1. 环境变量 PI_WEB_ACCESS_EXTENSION：显式覆盖，设了就只信它（不存在时不静默回退）；
 * 2. Node 解析 pi-web-access/package.json：覆盖 npm 安装副本（含 ~/.pi/agent/npm/node_modules
 *    同级场景）。裸包名解析必败（pi-web-access 无 main/exports 字段），必须带子路径；入口读
 *    其 package.json 的 pi.extensions[0]——npm 发布副本指向 dist/，本地 checkout 是 index.ts；
 * 3. 同级 checkout：本包与 pi-web-access 的本地开发副本并排放在同一目录（如 ~/Projects/ 下）。
 * 全部失败返回 tried 记录，由调用方拼进失败原因注入子 agent 首回合。
 */
function resolveWebAccessExtension(): { path: string } | { tried: string[] } {
	const tried: string[] = [];

	const env = process.env.PI_WEB_ACCESS_EXTENSION?.trim();
	if (env) {
		return existsSync(env) ? { path: env } : { tried: [`PI_WEB_ACCESS_EXTENSION=${env}（路径不存在）`] };
	}

	try {
		const req = createRequire(selfModulePath());
		const pkgJsonPath = req.resolve("pi-web-access/package.json");
		const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as { pi?: { extensions?: string[] } };
		const p = join(dirname(pkgJsonPath), pkg.pi?.extensions?.[0] ?? "./index.ts");
		if (existsSync(p)) return { path: p };
		tried.push(`${p}（package.json 已解析但入口缺失）`);
	} catch {
		tried.push("require.resolve('pi-web-access/package.json') 未命中（pi-web-access 不在 node_modules 中）");
	}

	const sibling = join(dirname(selfModulePath()), "..", "pi-web-access", "index.ts");
	if (existsSync(sibling)) return { path: sibling };
	tried.push(`同级 checkout ${sibling} 不存在`);

	return { tried };
}

/** 引导环境变量：存在即表示本进程是 web-research 子 agent，factory 在 load 阶段激活联网工具 */
export const WEB_RESEARCH_ENV = "PI_SUB_WEB";

/** 检查 pi-web-access 是否已全局安装（settings.json 的 packages 列表），覆盖 npm: 与本地路径两种形式 */
function isWebAccessGloballyInstalled(): boolean {
	try {
		const settings = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf-8")) as {
			packages?: unknown[];
		};
		return (
			Array.isArray(settings.packages) &&
			settings.packages.some((p) => typeof p === "string" && p.includes("pi-web-access"))
		);
	} catch {
		return false;
	}
}

/**
 * pi-web-access 安装目录（工具收窄时按来源判定用）：包目录本身。工具的 sourceInfo.path
 * 是扩展入口文件（全局安装为 .../pi-web-access/index.ts，本地 checkout 同理），所以
 * 前缀匹配必须用包目录，不能像包管理器那样取上级。
 */
function resolveWebAccessDir(): string | undefined {
	const env = process.env.PI_WEB_ACCESS_EXTENSION?.trim();
	if (env) return dirname(env);
	try {
		const req = createRequire(selfModulePath());
		return dirname(req.resolve("pi-web-access/package.json"));
	} catch {
		/* fallthrough */
	}
	const sibling = join(dirname(selfModulePath()), "..", "pi-web-access");
	return existsSync(sibling) ? sibling : undefined;
}

/**
 * 提示词与简报不点名联网工具：子 agent 的 tools list 里本来就有真实名字与完整描述
 * （pi-web-access 自带），点名只会漂移。这里只补 pi 默认提示词没有的研究纪律。
 */
export const WEB_RESEARCH_APPEND_PROMPT = `Additional rules for this web-research session:
- Never fabricate results, quotes, or URLs. Every claim in your deliverable must trace to a tool result and cite its source URL. If evidence is insufficient, say so plainly.
- Evidence priority: tool outputs > user-provided context > your inference. Mark unverified points.
- Budget calls: fetch only pages you will actually cite; fetch defaults to readable (mode "answer" is disabled) — read fetched pages yourself.
- bash is only for auxiliary search/retrieval work (e.g. processing tool output text). Never use it as a network client or a substitute for the web tools.
- Deliverable protocol (from your brief): write conclusions with source URLs to the result.md path given there.`;

/**
 * web-research 模式下子 agent pi 的预设 flag：用 pi 公开 CLI 参数 --append-system-prompt
 * 注入研究纪律段（args help 文档化的稳定接口）。pi 把它汇入 loader 的 appendSystemPrompt，
 * 插入位置由 pi 自己决定（docs 段后、project_context 与 cwd 前），升级自动跟随。
 */
export function webResearchPresetFlags(): string[] {
	return ["--append-system-prompt", WEB_RESEARCH_APPEND_PROMPT];
}

/** web-research 模式的简报模板：问题 + 背景 + 当前日期 + 工具策略 + 交付物 + 边界 */
export function buildWebResearchBrief(
	question: string,
	context: string | undefined,
	artifactPath: string,
	useWatchdog: boolean,
): string {
	const today = new Date().toISOString().slice(0, 10);
	const completion = useWatchdog
		? `
## 收尾
- 全部完成后（交付物已写完、无其他内容要输出时）把 stop_watchdog 作为最后一个动作调用
`
		: "";
	return `# 网络调研简报

## 问题
${question}

## 已知背景（主会话提供，本简报是你唯一的上下文来源）
${context?.trim() || "（无）"}

## 当前日期
${today}（判断时效性与 recencyFilter 取值时用）

## 工具策略
- 全部联网操作用你 tools list 里的联网工具（pi-web-access 提供）完成
- fetch 默认 readable（answer 模式已禁用），页面由你自己阅读；只抓会引用的页面
- 长内容别整页读入：单个事实用存取检索工具的 findText 定位，整段正文按 responseId 取回
- 若本会话没有任何联网工具，说明联网引导失败：把失败原因写入交付物并直接停止，不要尝试其他联网手段

## 交付物
- 结论写入 ${artifactPath}：结论优先，每条附来源 URL，标注未核实的内容
${completion}
## 边界
- bash 只用于搜索/检索相关的辅助工作（如处理工具输出的文本），不得作为联网手段
- tmux 命令永远带 -L ${SOCKET}（专用 socket）；禁止对默认 tmux server 执行任何 kill 操作`;
}

// ---------- 子 agent 引导（factory 阶段执行，index.ts 在 setupSelfCheck 提前 return 之前调用） ----------

/**
 * 研究人格段：整形提示词时替换 pi 默认提示词的首段（编码助手人格）。
 */
const WEB_RESEARCH_PERSONA =
	"You are a web-research agent operating inside pi. Your brief contains one research question; " +
	"answer it strictly from real results returned by your web tools. Read fetched pages yourself " +
	"and distill findings into the deliverable with source URLs.";

/**
 * 换人格：把 pi 默认提示词的首段（编码助手人格）替换为研究人格。纯结构定位——取首个
 * 空行前的段落，不匹配任何 pi 文案；pi 升级改措辞/段落数都不受影响。loader 自定义
 * 提示词（customPrompt）存在时首段是用户内容，跳过替换。
 */
function swapPersona(base: string, hasCustomPrompt: boolean): string {
	if (hasCustomPrompt) return base;
	const idx = base.indexOf("\n\n");
	if (idx <= 0) return base;
	return WEB_RESEARCH_PERSONA + base.slice(idx);
}

/**
 * web-research 子 agent 引导：检测到 WEB_RESEARCH_ENV 即：
 * 1. 研究纪律段经 pi 公开 CLI 参数 --append-system-prompt 注入（webResearchPresetFlags，
 *    插入位置由 pi 决定）；人格段在 before_agent_start 按结构（首段）替换，其余段落
 *    （工具列表、guidelines、docs 段、project_context、skills、cwd）保持 pi 原生，
 *    上游更新自动跟随。-p 批处理与交互式都会触发该事件。
 * 2. 工具集按来源收窄（代替写死名字的 --tools 白名单，见文件头注释）：保留 read/bash/edit/write、
 *    stop_watchdog 与 pi-web-access 提供的全部工具，其余（edit/grep/find/ls/powershell、
 *    spawn_sub/web_research/advisor 等）全部撤下。已全局安装时工具来自全局包路径；动态加载时
 *    工具注册进本扩展的记录，sourceInfo.path 随本扩展文件。收窄在 session_start（bindCore
 *    已绑定、所有扩展已加载）执行；before_agent_start 再断言一次，防 session_start 之后
 *    懒注册的工具被 auto-include 加回 active。
 * 3. 动态激活 pi-web-access。已全局安装时跳过（工具继承自 settings，动态加载会重复
 *    注册）；激活失败不阻断启动，改为 session_start 时注入首回合失败说明。
 */
export async function bootstrapWebResearch(pi: ExtensionAPI): Promise<void> {
	if (!process.env[WEB_RESEARCH_ENV]?.trim()) return;

	// pi-web-access 动态注册的工具名名单：mod.default(pi) 经代理执行，截获其
	// registerTool 调用（收窄时名单优先、路径兑底；不依赖 PI_SUBAGENT 门禁兜底）。
	const webAccessToolNames = new Set<string>();
	// pi-web-access 安装目录：全局安装（settings packages）时工具的 sourceInfo.path 指向
	// 该目录下的文件；npm 布局下安装根是包目录的上级（node_modules/<name>/..）。
	const webAccessDir = resolveWebAccessDir();

	/**
	 * 收窄判定：这个工具该不该留在 web-research 子 agent。
	 * 按来源（sourceInfo）判，不按名字判 —— 上游改工具名/加工具自动跟随。
	 * - builtin：只留 read/bash/edit/write（web-research 产出除新建 result.md 外也可能修订已有文件）
	 * - pi-web-access 目录（全局安装）或动态注册的名单：全留 —— 动态加载时工具注册进本
	 *   扩展的记录，sourceInfo.path 与本包自有工具同目录，无法靠路径区分；故 mod.default(pi)
	 *   外包 registerTool 代理，把 pi-web-access 实际注册的工具名记入 webAccessToolNames，
	 *   名单优先、路径兑底；本包自有工具（spawn_sub/web_research/advisor）全部撤。
	 * 例外：stop_watchdog 注册自 pi-watchdog 包，但它的包路径因安装方式而异（本地
	 * checkout/npm），且就一个名字、极稳定 —— 按名单留，不解析路径。
	 */
	const shouldKeep = (tool: { name: string; sourceInfo?: { source?: string; path?: string } }): boolean => {
		const { source, path } = tool.sourceInfo ?? {};
		if (source === "builtin") return ["read", "bash", "edit", "write"].includes(tool.name);
		if (tool.name === "stop_watchdog") return true;
		if (webAccessToolNames.has(tool.name)) return true;
		const p = path ?? "";
		return webAccessDir !== undefined && p.startsWith(`${webAccessDir}/`);
	};

	/**
	 * 收窄执行：session_start（bindCore 已绑定、所有扩展已加载）用 setActiveTools 覆写；
	 * before_agent_start 再断言一次，防 session_start 之后懒注册的工具被 auto-include
	 * 加回 active（_refreshToolRegistry 对新注册名会 push 进 active，见 agent-session.js）。
	 * 返回 keep 名单供提示词重建取数（systemPromptOptions.selectedTools 是 handler 前快照，
	 * in-handler 收窄对它不可见）。
	 */
	const narrow = (): string[] => {
		const all = pi.getAllTools();
		const keep = all.filter(shouldKeep).map((t) => t.name);
		pi.setActiveTools(keep);
		return keep;
	};
	pi.on("session_start", () => {
		try {
			narrow();
		} catch (err) {
			// 收窄失败退化为全量工具（功能可用，隔离性变弱），不阻断启动
			console.error("[web-research] tool narrowing failed:", err instanceof Error ? err.message : err);
		}
	});

	// 注册必须在全局安装 early-return 之前：人格整形与工具收窄两条路径都需要。
	// 纪律段已由 --append-system-prompt 预置进 base，此处只换人格；基座用 event.systemPrompt
	// （session_start 收窄后 pi 经 setActiveToolsByName 重建的 pi 原生提示词快照）。
	pi.on("before_agent_start", (event) => {
		// 再收窄：session_start 之后懒注册的工具会被 auto-include 加回 active，
		// 首回合开始前再压一次（收窄失败时静默，不阻断提示词整形）
		try {
			narrow();
		} catch {
			/* session_start 阶段已报过错 */
		}
		return { systemPrompt: swapPersona(event.systemPrompt, !!event.systemPromptOptions.customPrompt) };
	});

	if (isWebAccessGloballyInstalled()) return;

	const resolved = resolveWebAccessExtension();
	let failure: string | undefined;
	if ("tried" in resolved) {
		failure =
			`找不到 pi-web-access 扩展（依次尝试：${resolved.tried.join("；")}）。` +
			"修复方式任选其一：pi install npm:pi-web-access 全局安装；或设置 PI_WEB_ACCESS_EXTENSION 指向其入口文件";
	} else {
		try {
			// jiti 的动态 import 已验证接受绝对路径（file URL 反而未验证，不引入）。
			// 代理 registerTool：pi-web-access 注册的工具名记入 webAccessToolNames，
			// 其余注册行为原样透传（其余工具不受影响）。
			const mod = (await import(resolved.path)) as { default: (pi: ExtensionAPI) => void };
			const realRegisterTool = pi.registerTool.bind(pi);
			const proxied = new Proxy(pi, {
				get(target, prop, receiver) {
					if (prop === "registerTool") {
						return (def: Parameters<typeof realRegisterTool>[0]) => {
							webAccessToolNames.add(def.name);
							return realRegisterTool(def);
						};
					}
					const v = Reflect.get(target, prop, receiver);
					return typeof v === "function" ? v.bind(target) : v;
				},
			});
			mod.default(proxied as ExtensionAPI);
		} catch (err) {
			failure = `动态加载 pi-web-access（${resolved.path}）出错：${err instanceof Error ? err.message : String(err)}`;
		}
	}
	if (!failure) return;

	// sendMessage 在 load 阶段不可用（bindCore 未绑定），挂到 session_start 注入首回合；
	// reload/new 会重发 session_start，发一次即清标记
	pi.on("session_start", () => {
		const f = failure;
		failure = undefined;
		if (!f) return;
		pi.sendMessage(
			{
				customType: "web-research-sub-boot",
				content: `web-research 子 agent 启动引导失败：${f}\n本会话没有联网工具。按简报要求：把失败原因写入交付物并直接停止，不要尝试其他联网手段。`,
				display: true,
			},
			{ deliverAs: "nextTurn" },
		);
	});
}

// ---------- web_research 工具注册（主会话，默认开启） ----------

/**
 * 拉起 web-research 子 agent 的回调：由 index.ts 注入（包一层 launchSub，负责 mode
 * 与引导环境变量的注入）。web-research.ts 不接触 tmux 与 shell 细节。
 */
export type WebResearchLaunch = (
	question: string,
	context: string | undefined,
) => Promise<{ ok: boolean; text: string; ops?: string }>;

/**
 * 注册 web_research 工具（默认开启，无配置门槛）。与 spawn_sub 同一条 tmux 流程，
 * 只是换了 brief 模板、子 agent 工具集、系统提示词，并注入联网引导环境变量。
 */
export function setupWebResearch(pi: ExtensionAPI, launch: WebResearchLaunch): void {
	pi.registerTool({
		name: "web_research",
		label: "联网调研",
		description:
			"Delegate a web-research task to an isolated pi sub-agent in tmux. The sub-agent runs the web searches and " +
			"page fetches itself; only distilled conclusions with source URLs enter this conversation. The full deliverable is " +
			"written to a system-generated path (/tmp/pi-sub-<session>/result.md), whose exact value is given in the tool response. " +
			"Do not put the deliverable path in `question` — the brief the sub-agent receives already carries it",
		promptSnippet: "delegate web search/fetch to an isolated tmux sub-agent; only distilled conclusions return",
		// 强导向：主会话默认不带任何联网工具（联网能力只存在于 web-research 子 agent），
		// 一切搜索/抓取都必须走这里，防止原始网页内容进入主会话上下文。
		promptGuidelines: [
			"web_research: ALL web search and page fetch goes through this tool — the main session has no direct web access by design; raw search results and page content must never enter this conversation.",
			"web_research: distill everything the sub-agent needs into the context parameter — the precise question, known URLs, facts so far, constraints (language, recency, depth).",
			"web_research: not for local questions answerable from files in this repo — keep those in the main session.",
		],
		parameters: Type.Object({
			question: Type.String({
				description:
					"The research question, stated precisely: what a good answer looks like (depth, language, recency, acceptance criteria)",
			}),
			context: Type.Optional(
				Type.String({
					description:
						"Self-contained context the sub-agent needs: URLs, conclusions so far, user preferences or constraints. " +
						"It has zero memory of this conversation — anything not written here is unknown to it",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const r = await launch(params.question, params.context);
			return {
				content: [{ type: "text", text: r.text }],
				details: { ops: r.ops },
			};
		},
		renderResult(result, _options, theme, _context) {
			const ops = (result.details as { ops?: string } | undefined)?.ops;
			if (!ops) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}
			return new Text(theme.fg("muted", `已启动联网调研子 agent（复制到任意终端围观）：\n${ops}`), 0, 0);
		},
	});
}
