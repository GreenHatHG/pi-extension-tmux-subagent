/**
 * In-process bootstrap for the web-research sub-agent. This code runs in the sub-agent's pi
 * process (the main session injects PI_SUB_WEB=1 via tmux -e), called by index when role.web is set.
 *
 * 1. Replace the persona section by structure (first paragraph) in before_agent_start, keep the
 *    other paragraphs native to pi, so upstream updates follow automatically. The research
 *    discipline section is not here: it is preset on the main-session side by
 *    --append-system-prompt.
 * 2. Narrow the tool set by source (see shouldKeep): keep builtin read/bash/edit/write,
 *    watchdog_decide and pi-web-access tools, drop everything else. Narrow at session_start, then
 *    assert once more in before_agent_start, so tools lazily registered after session_start can't
 *    be auto-included back into active.
 * 3. Dynamically activate pi-web-access; skip when it is already installed globally (tools are
 *    inherited from settings, and dynamic loading would register them twice); if activation fails,
 *    don't block startup, instead inject a first-turn failure note at session_start.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WATCHDOG_TOOL } from "../completion/profile";
import { onEvent } from "../registry";

/** This module's file path: jiti (CJS transform) injects __filename; pure ESM falls back to import.meta.url. */
function selfModulePath(): string {
	if (typeof __filename === "string") return __filename;
	return fileURLToPath(import.meta.url);
}

/** Root dir of this extension package (src/session/ up two levels): used to find a sibling checkout. */
function packageRoot(): string {
	return join(dirname(selfModulePath()), "..", "..");
}

/**
 * Resolve the pi-web-access extension entry without hard-coding an absolute path. Tries, in order:
 * 1. env PI_WEB_ACCESS_EXTENSION (if set, trust only it; don't silently fall back when the path is missing);
 * 2. Node resolving pi-web-access/package.json (a bare package name always fails, a subpath is
 *    required; read pi.extensions[0] as the entry);
 * 3. a sibling checkout (this package and pi-web-access side by side in one dir).
 * If all fail, return tried so the caller can put it into the failure reason injected into the
 * sub-agent's first turn.
 */
function resolveWebAccessExtension(): { path: string } | { tried: string[] } {
	const tried: string[] = [];

	const env = process.env.PI_WEB_ACCESS_EXTENSION?.trim();
	if (env) {
		return existsSync(env) ? { path: env } : { tried: [`PI_WEB_ACCESS_EXTENSION=${env} (path does not exist)`] };
	}

	try {
		const req = createRequire(selfModulePath());
		const pkgJsonPath = req.resolve("pi-web-access/package.json");
		const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as { pi?: { extensions?: string[] } };
		const p = join(dirname(pkgJsonPath), pkg.pi?.extensions?.[0] ?? "./index.ts");
		if (existsSync(p)) return { path: p };
		tried.push(`${p} (package.json resolved but the entry is missing)`);
	} catch {
		tried.push("require.resolve('pi-web-access/package.json') missed (pi-web-access is not in node_modules)");
	}

	const sibling = join(packageRoot(), "..", "pi-web-access", "index.ts");
	if (existsSync(sibling)) return { path: sibling };
	tried.push(`sibling checkout ${sibling} does not exist`);

	return { tried };
}

/** Check whether pi-web-access is installed globally (the packages list in settings.json). */
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
 * pi-web-access package dir (used to match tool source): a tool's sourceInfo.path is the extension
 * entry file, so prefix matching must use the package dir.
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

/** Research persona section: replaces the first paragraph of pi's default prompt (the coding-assistant persona) when reshaping the prompt. */
const WEB_RESEARCH_PERSONA = [
	"You are a web-research agent operating inside pi. Your brief contains one research question;",
	"answer it strictly from real results returned by your web tools. Read fetched pages yourself",
	"and distill findings into the deliverable with source URLs.",
].join(" ");

/**
 * Replace pi's default first paragraph (coding-assistant persona) with the research persona. Pure
 * structural targeting (the paragraph before the first blank line), no pi text matching, so
 * upgrades are unaffected; when customPrompt exists the first paragraph is user content, so skip.
 */
function swapPersona(base: string, hasCustomPrompt: boolean): string {
	if (hasCustomPrompt) return base;
	const idx = base.indexOf("\n\n");
	if (idx <= 0) return base;
	return `${WEB_RESEARCH_PERSONA}${base.slice(idx)}`;
}

/**
 * web-research sub-agent bootstrap entry (runs at factory time), called by index.ts when role.web is set.
 */
export async function bootstrapWebResearch(pi: ExtensionAPI): Promise<void> {
	// Tool names pi-web-access registers dynamically: proxy mod.default(pi) to catch its registerTool calls
	const webAccessToolNames = new Set<string>();
	// pi-web-access package dir: used to match by tool source path when narrowing
	const webAccessDir = resolveWebAccessDir();

	/**
	 * Keep-or-drop check: does this tool stay in the web-research sub-agent. Judge by source
	 * (sourceInfo), not by name.
	 * - builtin: keep only read/bash/edit/write (output may edit existing files besides creating result.md)
	 * - pi-web-access dir or dynamically registered names: keep all. On dynamic load tools register
	 *   into this extension, so a path cannot tell them apart; the registerTool proxy records names
	 *   into webAccessToolNames, names first, path as fallback
	 * - exception watchdog_decide: registered by pi-watchdog, whose package path varies by install, so keep by name
	 */
	const builtinTools = new Set(["read", "bash", "edit", "write"]);
	const shouldKeep = (tool: { name: string; sourceInfo?: { source?: string; path?: string } }): boolean => {
		const { source, path = "" } = tool.sourceInfo ?? {};
		if (source === "builtin") return builtinTools.has(tool.name);
		return (
			tool.name === WATCHDOG_TOOL ||
			webAccessToolNames.has(tool.name) ||
			(webAccessDir !== undefined && path.startsWith(`${webAccessDir}/`))
		);
	};

	/**
	 * Narrow and return the keep list (the prompt rebuild needs it: systemPromptOptions.selectedTools
	 * is a pre-handler snapshot, so in-handler narrowing is invisible to it).
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
			where: "session/web-bootstrap.ts:tool narrowing",
			note: `web-research sub-agent: narrow the tool set by source at session_start (builtin keeps only read/bash/edit/write + ${WATCHDOG_TOOL} + pi-web-access)`,
		},
		() => {
			try {
				narrow();
			} catch (err) {
				// Narrowing failed, fall back to all tools (still works, weaker isolation); don't block startup
				console.error("[web-research] tool narrowing failed:", err instanceof Error ? err.message : err);
			}
		},
	);

	// Registration must happen before the global-install early return: both persona reshaping and
	// narrowing need it. Base on event.systemPrompt (the native prompt snapshot pi rebuilds after
	// session_start narrowing).
	onEvent(
		pi,
		"before_agent_start",
		{
			where: "session/web-bootstrap.ts:persona reshape + second narrowing",
			note: "web-research sub-agent: replace the first paragraph of pi's default prompt with the research persona; narrow tools once more before the first turn (keeps lazy registration from being auto-included back)",
		},
		(event: { systemPrompt: string; systemPromptOptions?: { customPrompt?: unknown } }) => {
			// Narrow again: tools lazily registered after session_start get auto-included back, so press once more before the first turn
			try {
				narrow();
			} catch {
				/* already reported the error at session_start */
			}
			return { systemPrompt: swapPersona(event.systemPrompt, !!event.systemPromptOptions?.customPrompt) };
		},
	);

	if (isWebAccessGloballyInstalled()) return;

	const resolved = resolveWebAccessExtension();
	let failure: string | undefined;
	if ("tried" in resolved) {
		failure = `Could not find the pi-web-access extension (tried in order: ${resolved.tried.join("; ")}). Fix it one of two ways: install globally with pi install npm:pi-web-access, or set PI_WEB_ACCESS_EXTENSION to its entry file`;
	} else {
		try {
			// jiti's dynamic import accepts absolute paths (file URLs untested). Proxy registerTool to
			// record tool names, pass all other registration through as-is.
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
			failure = `Failed to dynamically load pi-web-access (${resolved.path}): ${err instanceof Error ? err.message : String(err)}`;
		}
	}
	if (!failure) return;

	// sendMessage is not available at load time (bindCore not bound), so hook session_start to
	// inject the first turn; clear the flag after one send, so reload/new won't inject again
	onEvent(
		pi,
		"session_start",
		{
			where: "session/web-bootstrap.ts:web bootstrap failure note",
			note: "web-research sub-agent bootstrap failed (pi-web-access not found/loaded): inject the failure note into the first turn so the sub-agent stops as the brief says",
		},
		() => {
			const f = failure;
			failure = undefined;
			if (!f) return;
			pi.sendMessage(
				{
					customType: "web-research-sub-boot",
					content: `web-research sub-agent bootstrap failed: ${f}\nThis session has no web tools. As the brief requires: write the failure reason into the deliverable and stop at once; don't try other ways to get online.`,
					display: true,
				},
				{ deliverAs: "nextTurn" },
			);
		},
	);
}
