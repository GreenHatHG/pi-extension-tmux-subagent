/**
 * Tests for the sub-agent write fence: exact-path allow, everything else blocked, and the
 * env-gated registration (fence off without the env var). Pure logic is tested directly; the
 * tool_call wiring uses the same mock shape as the verification-gate coordination tests.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { pathIsAllowed, setupWriteFence } from "../src/session/write-fence";

let dir: string;
const oldEnv = process.env.PI_SUB_WRITE_WHITELIST;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wfence-"));
});

afterEach(() => {
	if (oldEnv === undefined) delete process.env.PI_SUB_WRITE_WHITELIST;
	else process.env.PI_SUB_WRITE_WHITELIST = oldEnv;
	rmSync(dir, { recursive: true, force: true });
});

describe("pathIsAllowed", () => {
	test("exact absolute match passes", () => {
		const target = join(dir, "result.md");
		expect(pathIsAllowed(target, target)).toBe(true);
	});

	test("relative and non-normalized forms of the same file pass", () => {
		const target = `${dir}/result.md`;
		// resolve() folds ./ and ../, so a model writing ./result.md with the right cwd still passes.
		expect(pathIsAllowed(`${dir}/./result.md`, target)).toBe(true);
		expect(pathIsAllowed(`${dir}/sub/../result.md`, target)).toBe(true);
	});

	test("a different file in the same dir is blocked", () => {
		expect(pathIsAllowed(join(dir, "other.ts"), join(dir, "result.md"))).toBe(false);
	});

	test("a prefix-string path is not an escape hatch", () => {
		// The fence compares resolved paths, not string prefixes: ...result.md.bak must not pass.
		expect(pathIsAllowed(`${dir}/result.md.bak`, join(dir, "result.md"))).toBe(false);
	});

	test("missing/empty path is blocked", () => {
		expect(pathIsAllowed(undefined, "/tmp/x/result.md")).toBe(false);
		expect(pathIsAllowed("", "/tmp/x/result.md")).toBe(false);
		expect(pathIsAllowed("   ", "/tmp/x/result.md")).toBe(false);
	});
});

/** Mock pi: capture the tool_call handler the fence registers. */
function mockPi() {
	let handler: ((event: unknown) => unknown) | undefined;
	const pi = {
		on: (event: string, h: unknown) => {
			if (event === "tool_call") handler = h as typeof handler;
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		call: (toolName: string, path?: string) => handler?.({ toolName, input: path === undefined ? {} : { path } }),
	};
}

describe("setupWriteFence", () => {
	test("whitelisted path passes through, other paths get a block result with a reason", () => {
		const target = join(dir, "result.md");
		process.env.PI_SUB_WRITE_WHITELIST = target;
		const rt = mockPi();
		setupWriteFence(rt.pi);
		expect(rt.call("write", target)).toBeUndefined();
		const blocked = rt.call("edit", join(dir, "src/index.ts")) as { block: boolean; reason: string };
		expect(blocked.block).toBe(true);
		expect(blocked.reason).toContain(target);
		expect(blocked.reason).toContain("fenced");
	});

	test("non-write/edit tools are untouched", () => {
		process.env.PI_SUB_WRITE_WHITELIST = join(dir, "result.md");
		const rt = mockPi();
		setupWriteFence(rt.pi);
		// bash must stay fully open (builds/tests write artifacts): the fence never sees it.
		expect(rt.call("bash", join(dir, "src/index.ts"))).toBeUndefined();
		expect(rt.call("read", join(dir, "anything"))).toBeUndefined();
	});

	test("no env var: no handler registered, writes unrestricted", () => {
		delete process.env.PI_SUB_WRITE_WHITELIST;
		const rt = mockPi();
		setupWriteFence(rt.pi);
		expect(rt.call("write", "/etc/passwd")).toBeUndefined();
	});
});
