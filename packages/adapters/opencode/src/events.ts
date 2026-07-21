import type { RuntimeSignalV1 } from "@golem/contracts";
import { opaqueId, stableTimestamp } from "./ids.js";
import type {
	OpenCodeAdapterOptions,
	OpenCodeEvent,
	OpenCodeRuntimeSignal,
	OpenCodeSessionInfo,
	OpenCodeSignalContext,
} from "./types.js";

type MutableSession = {
	readonly sessionId: string;
	readonly generationId: string;
	readonly child: boolean;
};

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function infoFor(event: OpenCodeEvent): OpenCodeSessionInfo | undefined {
	const properties = record(event.properties);
	const info = record(properties.info);
	const id =
		typeof info.id === "string"
			? info.id
			: typeof properties.sessionID === "string"
				? properties.sessionID
				: undefined;
	if (!id) return undefined;
	return {
		id,
		...(typeof info.parentID === "string" ? { parentID: info.parentID } : {}),
		...(typeof info.directory === "string"
			? { directory: info.directory }
			: {}),
		...(typeof info.title === "string" ? { title: info.title } : {}),
		...(typeof info.model === "string" ? { model: info.model } : {}),
	};
}

function statusFor(
	event: OpenCodeEvent,
): { id: string; status: string } | undefined {
	const properties = record(event.properties);
	const id =
		typeof properties.sessionID === "string" ? properties.sessionID : undefined;
	if (!id) return undefined;
	const raw = record(properties.status);
	const status =
		typeof raw.type === "string"
			? raw.type
			: typeof properties.status === "string"
				? properties.status
				: undefined;
	return status ? { id, status } : undefined;
}

function sourceTime(event: OpenCodeEvent): string | undefined {
	const properties = record(event.properties);
	const info = record(properties.info);
	const time = record(info.time);
	const value = time.updated ?? time.created ?? properties.timestamp;
	return typeof value === "number"
		? new Date(value).toISOString()
		: typeof value === "string"
			? value
			: undefined;
}

function modelFor(event: OpenCodeEvent): string | undefined {
	const properties = record(event.properties);
	const info = record(properties.info);
	const model = record(properties.model);
	for (const candidate of [
		info.model,
		properties.modelID,
		model.modelID,
		model.id,
	]) {
		if (typeof candidate === "string" && candidate.trim()) return candidate;
	}
	return undefined;
}

function normalizeSession(raw: string): string {
	return opaqueId("ses", raw);
}

function signalBase(
	context: OpenCodeSignalContext,
	event: OpenCodeEvent,
	eventKind: RuntimeSignalV1["event_kind"],
	payload: unknown,
	seed: string,
	ordinal: number,
): OpenCodeRuntimeSignal {
	const now = context.now ?? (() => new Date().toISOString());
	const receivedAt = stableTimestamp(undefined, now);
	const observedAt = stableTimestamp(sourceTime(event), now);
	const eventId = opaqueId(
		"evt",
		`${context.producerInstanceId}:${seed}:${ordinal}`,
	);
	const producerId = context.producerInstanceId;
	return {
		schema_version: "golem.runtime-signal/v1",
		event_id: eventId,
		event_kind: eventKind,
		producer: context.producer ?? "opencode-adapter",
		producer_instance_id: producerId,
		harness: "opencode",
		producer_sequence: ordinal,
		correlation_id: eventId,
		deduplication_key: `opencode:${seed}:${ordinal}`,
		clocks: {
			source_observed_at: observedAt,
			source_event_at: observedAt,
			received_at: receivedAt,
			materialized_at: receivedAt,
		},
		provenance: {
			source: "adapter",
			evidence_id: `opencode:${seed}`,
			confidence: "observed",
		},
		clear_fields: [],
		payload,
	} as unknown as OpenCodeRuntimeSignal;
}

export function signalForOpenCodeEvent(
	event: OpenCodeEvent,
	context: OpenCodeSignalContext,
	state: MutableSession | undefined,
	ordinal: number,
): OpenCodeRuntimeSignal | undefined {
	const properties = record(event.properties);
	const info = infoFor(event);
	const rawSessionId =
		info?.id ??
		(typeof properties.sessionID === "string"
			? properties.sessionID
			: undefined);
	if (event.type === "session.created") {
		if (!info || info.parentID) return undefined;
		const sessionId = normalizeSession(info.id);
		const generationId = opaqueId("gen", `${sessionId}:1`);
		return signalBase(
			context,
			event,
			"session.started",
			{
				kind: "session.started",
				generation: {
					project_id: context.projectId,
					session_id: sessionId,
					generation_id: generationId,
				},
				...(info.title || info.model
					? {
							metadata: {
								...(info.title ? { name: info.title } : {}),
								...(info.model ? { model: info.model } : {}),
							},
						}
					: {}),
			},
			`${event.type}:${info.id}`,
			ordinal,
		);
	}
	if (event.type === "session.resumed" && rawSessionId) {
		const sessionId = normalizeSession(rawSessionId);
		const generationId = opaqueId("gen", `${rawSessionId}:resume:${ordinal}`);
		return signalBase(
			context,
			event,
			"session.resumed",
			{
				kind: "session.resumed",
				generation: {
					project_id: context.projectId,
					session_id: sessionId,
					generation_id: generationId,
				},
				...(state ? { resumed_from_generation_id: state.generationId } : {}),
			},
			`${event.type}:${rawSessionId}`,
			ordinal,
		);
	}
	if (!rawSessionId || !state || state.child) return undefined;
	const sessionId = state.sessionId;
	const generation = {
		project_id: context.projectId,
		session_id: sessionId,
		generation_id: state.generationId,
	};
	if (event.type === "session.deleted" || event.type === "session.ended") {
		return signalBase(
			context,
			event,
			"session.ended",
			{
				kind: "session.ended",
				generation,
				disposition: "ended",
			},
			`${event.type}:${rawSessionId}`,
			ordinal,
		);
	}
	if (event.type === "session.status" || event.type === "session.idle") {
		const status =
			event.type === "session.idle" ? "idle" : statusFor(event)?.status;
		if (status === "busy" || status === "active")
			return signalBase(
				context,
				event,
				"session.activity",
				{ kind: "session.activity", generation, activity_kind: "work" },
				`${event.type}:${rawSessionId}:active`,
				ordinal,
			);
		if (status === "retry")
			return signalBase(
				context,
				event,
				"session.waiting",
				{ kind: "session.waiting", generation, reason: "OpenCode retry" },
				`${event.type}:${rawSessionId}:waiting`,
				ordinal,
			);
		if (status === "idle")
			return signalBase(
				context,
				event,
				"session.idle",
				{ kind: "session.idle", generation },
				`${event.type}:${rawSessionId}:idle`,
				ordinal,
			);
	}
	if (
		event.type === "session.updated" ||
		event.type === "model.updated" ||
		event.type === "message.updated"
	) {
		const model = modelFor(event);
		const title = info?.title;
		if (!model && !title) return undefined;
		return signalBase(
			context,
			event,
			"session.metadata_patched",
			{
				kind: "session.metadata_patched",
				generation,
				metadata: {
					...(title ? { name: title } : {}),
					...(model ? { model } : {}),
				},
			},
			`${event.type}:${rawSessionId}:${model ?? title}`,
			ordinal,
		);
	}
	if (
		event.type === "message.created" ||
		event.type === "chat.message" ||
		event.type === "tool.execute.after"
	)
		return signalBase(
			context,
			event,
			"session.activity",
			{
				kind: "session.activity",
				generation,
				activity_kind: event.type.includes("tool") ? "tool" : "response",
			},
			`${event.type}:${rawSessionId}`,
			ordinal,
		);
	return undefined;
}

export class OpenCodeEventAdapter {
	readonly #options: OpenCodeAdapterOptions;
	readonly #sessions = new Map<string, MutableSession>();
	#ordinal = 0;

	constructor(options: OpenCodeAdapterOptions) {
		this.#options = options;
	}

	consume(event: OpenCodeEvent): OpenCodeRuntimeSignal | undefined {
		const info = infoFor(event);
		const rawId =
			info?.id ??
			(typeof record(event.properties).sessionID === "string"
				? String(record(event.properties).sessionID)
				: undefined);
		if (event.type === "session.created" && info?.parentID) {
			this.#sessions.set(info.id, {
				sessionId: normalizeSession(info.id),
				generationId: opaqueId("gen", `${info.id}:child`),
				child: true,
			});
			return undefined;
		}
		const state = rawId ? this.#sessions.get(rawId) : undefined;
		const signal = signalForOpenCodeEvent(
			event,
			{
				projectId: this.#options.projectId,
				producerInstanceId: this.#options.producerInstanceId,
				...(this.#options.producer ? { producer: this.#options.producer } : {}),
				...(this.#options.now ? { now: this.#options.now } : {}),
			},
			state,
			++this.#ordinal,
		);
		if (event.type === "session.created" && info && signal) {
			const generationId = (
				signal.payload as { generation: { generation_id: string } }
			).generation.generation_id;
			this.#sessions.set(info.id, {
				sessionId: normalizeSession(info.id),
				generationId,
				child: false,
			});
		}
		if (event.type === "session.resumed" && rawId && signal) {
			const generationId = (
				signal.payload as { generation: { generation_id: string } }
			).generation.generation_id;
			this.#sessions.set(rawId, {
				sessionId: normalizeSession(rawId),
				generationId,
				child: false,
			});
		}
		if (event.type === "session.deleted" && rawId) this.#sessions.delete(rawId);
		return signal;
	}

	stateFor(rawSessionId: string): MutableSession | undefined {
		return this.#sessions.get(rawSessionId);
	}
}
