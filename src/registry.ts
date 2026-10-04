/**
 * Event registrar: every pi.on(...) in the project goes through onEvent, so the registration
 * list is in one place (formatEventRegistrations() lists event, location and purpose).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface EventRegistration {
	/** pi event name (session_start / before_agent_start / ...). */
	event: string;
	/** Module and purpose id, e.g. "session/gate.ts:watchdog self-check". */
	where: string;
	/** When it fires and what it does. */
	note: string;
}

const registrations: EventRegistration[] = [];

/** Read-only registration list (for debugging/docs). */
export function eventRegistrations(): readonly EventRegistration[] {
	return registrations;
}

export function formatEventRegistrations(): string {
	return registrations.map((r) => `${r.event.padEnd(20)} ${r.where}\n${" ".repeat(20)} ${r.note}`).join("\n");
}

/** Only for doc display; the real signature comes from the pi.on overloads. */
type EventType = string;

/**
 * Record and register one event listener. where/note say when it fires and what it does, so the
 * list shows everything the extension listens to at a glance.
 */
export function onEvent(
	pi: ExtensionAPI,
	event: EventType,
	meta: { where: string; note: string },
	handler: unknown,
): void {
	registrations.push({ event: String(event), where: meta.where, note: meta.note });
	// pi.on overloads make Parameters<> pick only the last overload, so we cast instead of using generics
	(pi.on as (e: string, h: unknown) => unknown)(event, handler);
}
