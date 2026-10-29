/**
 * Temp agent dir for the verification-gate tests, plus the ambient-env reset they all need.
 *
 * Two env vars decide what the gate does at setup time, and both come from the real process:
 * PI_CODING_AGENT_DIR (where the config file is read) and PI_SUBAGENT (main session or sub-agent
 * pane). A test run started from inside a sub-agent pane inherits PI_SUBAGENT=1, the gate takes its
 * sub-agent no-op path, and 13 tests fail for a reason that has nothing to do with the code.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GateEnv {
	/** The temp agent dir the config file lives in. */
	dir: string;
	/** Put the real env back and delete the temp dir. Call from afterEach. */
	restore(): void;
}

/** Config the gate reads by default in tests: on, and one changed file is enough to interest it. */
const DEFAULT_CONFIG = { verification: { enabled: true, minChangedFiles: 1 } };

/**
 * Point the gate at a fresh config file and force the main-session role. Call from beforeEach.
 * `config` is written as-is, so a test can switch the gate off or drop a section entirely.
 */
export function useGateEnv(config: unknown = DEFAULT_CONFIG): GateEnv {
	const dir = mkdtempSync(join(tmpdir(), "vgate-"));
	const before = {
		dir: process.env.PI_CODING_AGENT_DIR,
		sub: process.env.PI_SUBAGENT,
	};
	writeFileSync(join(dir, "subagent_advisor.json"), JSON.stringify(config));
	process.env.PI_CODING_AGENT_DIR = dir;
	delete process.env.PI_SUBAGENT;
	return {
		dir,
		restore() {
			restoreEnv("PI_CODING_AGENT_DIR", before.dir);
			restoreEnv("PI_SUBAGENT", before.sub);
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** Rewrite the config file of an existing gate env (for the tests that switch the gate off mid-test). */
export function writeGateConfig(env: GateEnv, config: unknown): void {
	writeFileSync(join(env.dir, "subagent_advisor.json"), JSON.stringify(config));
}

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}
