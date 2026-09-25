/**
 * web-research 子 agent 的进程内引导。这段代码运行在子 agent 的 pi 进程里
 * （主会话经 tmux -e 注入 PI_SUB_WEB=1），与主会话侧的其余接线分属两个执行
 * 上下文——session/ 目录专门表达这个边界。
 *
 * 职责：检测到 PI_SUB_WEB 即
 * 1. 人格段在 before_agent_start 按结构（首段）替换，其余段落（工具列表、guidelines、
 *    docs 段、project_context、skills、cwd）保持 pi 原生，上游更新自动跟随。
 *    -p 批处理与交互式都会触发该事件。研究纪律段不在这里：它经 pi 公开 CLI 参数
 *    --append-system-prompt 由主会话侧预置（modes/presets.ts）。
 * 2. 工具集按来源收窄（代替写死名字的 --tools 白名单）：保留 read/bash/edit/write、
 *    stop_watchdog 与 pi-web-access 提供的全部工具，其余（edit/grep/find/ls/
 *    powershell、spawn_sub/web_research/advisor 等）全部撤下。已全局安装时工具来自
 *    全局包路径；动态加载时工具注册进本扩展的记录，sourceInfo.path 随本扩展文件。
 *    收窄在 session_start（bindCore 已绑定、所有扩展已加载）执行；before_agent_start
 *    再断言一次，防 session_start 之后懒注册的工具被 auto-include 加回 active。
 * 3. 动态激活 pi-web-access。已全局安装时跳过（工具继承自 settings，动态加载会重复
 *    注册）；激活失败不阻断启动，改为 session_start 时注入首回合失败说明。
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ENV_SUB_WEB } from "../core/env";
import { onEvent } from "../registry";

/** 本模块文件路径：jiti（CJS 变换）注入 __filename；纯 ESM 上下文退回 import.meta.url */
function selfModulePath(): string {
	if (typeof __filename === "string") return __filename;
	return fileURLToPath(import.meta.url);
}

/** 本扩展包的根目录（src/session/ 向上两级）：用于「同级 checkout」的查找 */
function packageRoot(): string {
	return join(dirname(selfModulePath()), "..", "..");
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

	const sibling = join(packageRoot(), "..", "pi-web-access", "index.ts");
	if (existsSync(sibling)) return { path: sibling };
	tried.push(`同级 checkout ${sibling} 不存在`);

	return { tried };
}

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
	const sibling = join(packageRoot(), "..", "pi-web-access");
	return existsSync(sibling) ? sibling : undefined;
}

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
 * web-research 子 agent 引导入口（factory 阶段执行，index.ts 在 setupSelfCheck 的
 * 子 agent 提前 return 之前调用）。
 */
export async function bootstrapWebResearch(pi: ExtensionAPI): Promise<void> {
	if (!process.env[ENV_SUB_WEB]?.trim()) return;

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
	onEvent(
		pi,
		"session_start",
		{
			where: "session/web-bootstrap.ts:工具收窄",
			note: "web-research 子 agent：session_start 时按来源收窄工具集（builtin 只留 read/bash/edit/write + stop_watchdog + pi-web-access）",
		},
		() => {
			try {
				narrow();
			} catch (err) {
				// 收窄失败退化为全量工具（功能可用，隔离性变弱），不阻断启动
				console.error("[web-research] tool narrowing failed:", err instanceof Error ? err.message : err);
			}
		},
	);

	// 注册必须在全局安装 early-return 之前：人格整形与工具收窄两条路径都需要。
	// 纪律段已由 --append-system-prompt 预置进 base，此处只换人格；基座用 event.systemPrompt
	// （session_start 收窄后 pi 经 setActiveToolsByName 重建的 pi 原生提示词快照）。
	onEvent(
		pi,
		"before_agent_start",
		{
			where: "session/web-bootstrap.ts:人格整形 + 二次收窄",
			note: "web-research 子 agent：把 pi 默认提示词首段替换为研究人格；首回合前再压一次工具收窄（防懒注册被 auto-include 加回）",
		},
		(event: { systemPrompt: string; systemPromptOptions?: { customPrompt?: unknown } }) => {
			// 再收窄：session_start 之后懒注册的工具会被 auto-include 加回 active，
			// 首回合开始前再压一次（收窄失败时静默，不阻断提示词整形）
			try {
				narrow();
			} catch {
				/* session_start 阶段已报过错 */
			}
			return { systemPrompt: swapPersona(event.systemPrompt, !!event.systemPromptOptions?.customPrompt) };
		},
	);

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
	onEvent(
		pi,
		"session_start",
		{
			where: "session/web-bootstrap.ts:联网引导失败说明",
			note: "web-research 子 agent 引导失败（找不到/加载不了 pi-web-access）时：把失败说明注入首回合，让子 agent 按简报停止",
		},
		() => {
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
		},
	);
}
