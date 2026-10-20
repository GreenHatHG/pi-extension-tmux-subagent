/**
 * Write fence inside a sub-agent pane (PI_SUB_WRITE_WHITELIST set): write/edit tool calls may
 * only target the whitelisted file — the run's deliverable (result.md). Everything else is
 * blocked with a retryable error (block without terminate: the model sees why, fixes the path,
 * and retries in the same turn).
 *
 * Why: verification sub-agents have no write tool today, so the report can only be a long bash
 * redirection — which models skip, then call watchdog_decide("done") with no report written
 * (the root cause of the silent fake-success runs, diagnosed 2026-10-19 via the flight
 * recorder). Opening write/edit with this fence gives a normal cheap path to the deliverable;
 * the fence keeps "don't touch the project" intact.
 *
 * bash redirection is NOT fenced (builds/tests must write); that residual risk is unchanged and
 * covered by the system prompt + the ON_STOP deliverable check.
 */
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ENV_SUB_WRITE_WHITELIST } from "../core/env";
import { onEvent } from "../registry";

/** The whitelisted path, resolved to an absolute form; undefined when the fence is off. */
function whitelistPath(): string | undefined {
	const p = process.env[ENV_SUB_WRITE_WHITELIST]?.trim();
	return p ? resolve(p) : undefined;
}

/** True when a write/edit call to this path must pass the fence. Pure, exported for tests. */
export function pathIsAllowed(inputPath: string | undefined, whitelist: string): boolean {
	if (typeof inputPath !== "string" || !inputPath.trim()) return false;
	return resolve(inputPath) === whitelist;
}

/**
 * Register the fence. Only call inside a sub-agent pane whose launch injected the env var
 * (baseEnvArgs does for every pane); a no-op when it is unset (the main session).
 */
export function setupWriteFence(pi: ExtensionAPI): void {
	const whitelist = whitelistPath();
	if (!whitelist) return;

	onEvent(
		pi,
		"tool_call",
		{
			where: "session/write-fence.ts:write fence",
			note: "Inside a fenced sub-agent pane: write/edit may only target the whitelisted deliverable path",
		},
		(event: unknown) => {
			const e = event as { toolName?: string; input?: { path?: unknown } | undefined };
			if (e.toolName !== "write" && e.toolName !== "edit") return;
			const inputPath = e.input?.path;
			if (typeof inputPath === "string" && pathIsAllowed(inputPath, whitelist)) return;
			return {
				block: true,
				reason:
					`This sub-agent's writes are fenced to one file: ${whitelist}. ` +
					`The ${e.toolName} call targeted ${typeof inputPath === "string" ? inputPath : "(no path)"}, which is outside the fence. ` +
					`Write your deliverable to the fenced path instead.`,
			};
		},
	);
}
