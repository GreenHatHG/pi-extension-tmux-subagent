/**
 * 事件注册器：全项目所有 pi.on(...) 都必须走这里的 onEvent。
 * 目的：注册清单集中可查——不用在散落各处的 setup 代码里找监听了什么，
 * formatEventRegistrations() 一眼看完「哪个事件、哪里注册的、干什么用」。
 *
 * onEvent 只是登记 + 透传给 pi.on，注册时序与直接调用 pi.on 完全一致，
 * 不改变任何事件语义。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface EventRegistration {
	/** pi 事件名（session_start / before_agent_start / ...） */
	event: string;
	/** 注册所在的模块与用途标识，如 "session/gate.ts:watchdog 自检" */
	where: string;
	/** 一句话说明：何时触发、做什么 */
	note: string;
}

const registrations: EventRegistration[] = [];

/** 只读注册清单（调试/文档用） */
export function eventRegistrations(): readonly EventRegistration[] {
	return registrations;
}

export function formatEventRegistrations(): string {
	return registrations.map((r) => `${r.event.padEnd(20)} ${r.where}\n${" ".repeat(20)} ${r.note}`).join("\n");
}

/** 类型字段仅供文档展示；handler 透传给 pi.on，签名由 pi.on 的重载约束 */
type EventType = string;

/**
 * 登记并注册一个事件监听。每个事件在项目内只应出现一次注册点，where/note 写清楚
 * 触发时机与作用，便于新人一眼看懂整个扩展监听了什么。
 */
export function onEvent(
	pi: ExtensionAPI,
	event: EventType,
	meta: { where: string; note: string },
	handler: unknown,
): void {
	registrations.push({ event: String(event), where: meta.where, note: meta.note });
	// 透传：event/handler 的真实签名由 pi.on 的重载保证；这里为了记录元信息统一签名
	//（pi.on 的重载形态让 Parameters<> 只取到末位重载，无法直接泛型化）
	(pi.on as (e: string, h: unknown) => unknown)(event, handler);
}
