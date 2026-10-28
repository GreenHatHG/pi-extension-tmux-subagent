/**
 * Verification quick settings: the `/verification` command + footer status. The command is always
 * registered. Unlike advisor (restart to apply the switch), the verification gate reads its config
 * at decision time, so on/off applies immediately to the next settle.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveVerification, writeVerificationConfig } from "../core/config";
import { onEvent } from "../registry";

/** Repaint the footer status from the resolved settings (config plus the on-by-default rule). */
function paintStatus(ctx: ExtensionContext): void {
	const enabled = resolveVerification().enabled;
	const theme = ctx.ui.theme;
	try {
		ctx.ui.setStatus(
			"verification",
			enabled ? theme.fg("accent", "verification:on") : theme.fg("muted", "verification:off"),
		);
	} catch {
		/* stay quiet when the status bar is unavailable (display only) */
	}
}

/** Register the `/verification` command (toggle) and the footer status. */
export function setupVerificationSettings(pi: ExtensionAPI): void {
	pi.registerCommand("verification", {
		description: "Toggle the verification gate: unverified non-trivial changes block completion (applies immediately)",
		handler: async (_args, ctx) => {
			const next = !resolveVerification().enabled;
			try {
				writeVerificationConfig({ enabled: next });
			} catch (err) {
				ctx.ui.notify(
					`Failed to write verification config: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
				return;
			}
			ctx.ui.notify(
				next
					? "verification gate on: unverified non-trivial changes now block completion"
					: "verification gate off: completion is no longer blocked",
				"info",
			);
			paintStatus(ctx);
		},
	});

	const paint = (_event: unknown, ctx: ExtensionContext) => {
		paintStatus(ctx);
	};
	onEvent(
		pi,
		"session_start",
		{
			where: "tools/verification-settings.ts:footer status",
			note: "Show the verification gate's on/off state in the footer at session start",
		},
		paint,
	);
}
