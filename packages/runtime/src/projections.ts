import type {
	RuntimeDiagnosticRecord,
	RuntimeEndpointView,
	RuntimeProjectionStorage,
	RuntimeSessionGenerationView,
	RuntimeSessionView,
} from "@golem/persistence";

export type RuntimeProjectionStream =
	| "runtime.live"
	| "runtime.history"
	| "runtime.diagnostics";

export interface RuntimeProjectionClock {
	now(): string;
}

export interface RuntimeProjectionQuery {
	readonly projectId?: string;
	readonly cursor?: number;
	readonly limit?: number;
	readonly state?: string;
}

export interface RuntimeProjectionPage {
	readonly [key: string]: unknown;
	readonly schema_version: "golem.runtime-projection/v1";
	readonly stream: RuntimeProjectionStream;
	readonly resource_revision: number;
	readonly cursor: number;
	readonly next_cursor?: number;
	readonly generated_at: string;
	readonly items: readonly Record<string, unknown>[];
	readonly explain: Readonly<Record<string, unknown>>;
	readonly observation: Readonly<Record<string, unknown>>;
	readonly drift: Readonly<Record<string, unknown>>;
}

export interface RuntimeProjectionPort {
	read(
		stream: RuntimeProjectionStream,
		query?: RuntimeProjectionQuery,
	): Record<string, unknown>;
	revision(stream: RuntimeProjectionStream): number;
	query(
		stream: RuntimeProjectionStream,
		query?: RuntimeProjectionQuery,
	): RuntimeProjectionPage;
}

export interface RuntimeLegacyDriftPort {
	compare?(
		stream: RuntimeProjectionStream,
		payload: Readonly<Record<string, unknown>>,
	): Readonly<Record<string, unknown>>;
}

const terminalStates = new Set(["ended", "errored", "superseded"]);
const safeIdentifierKey =
	/^(?:id|event(?:_id|_uuid)?|fence(?:_id)?|schema(?:_version)?|revision|resource_revision|cursor|sequence|ordinal|code|topic|watermark|project_id|session_id|generation_id|endpoint_id)$/iu;
const secretKey =
	/(?:token|credential|password|secret|api[_-]?key|authorization|env(?:ironment)?|prompt|(?:unrelated_)?path|pathname|file(?:name)?|directory|cwd|home|root)/iu;
const assignment =
	/\b(?:owner[_-]?token|access[_-]?token|openai[_-]?api[_-]?key|token|credential|password|secret|api[_-]?key|authorization)\s*[=:]\s*[^\s,;}]+/giu;
const environmentAssignment =
	/\b(?:HOME|PATH|PWD|USER|SHELL|GOLEM_HOME|NODE_PATH|[A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|API|AUTH)[A-Z0-9_]*)\s*=\s*[^\s,;}]+/gu;
const filesystemPath =
	/\/(?:Users|private\/tmp|tmp|var\/folders|home)\/[^\s,;}"]+/gu;
const bearer = /\bBearer\s+[A-Za-z0-9._-]+/giu;
const maxDiagnosticDepth = 5;
const maxDiagnosticBytes = 2_048;

function redact(value: unknown, depth = 0): unknown {
	if (depth > maxDiagnosticDepth) return "[DEPTH_REDACTED]";
	if (typeof value === "string")
		return value
			.replace(
				environmentAssignment,
				(match) => `${match.split("=")[0]}=[REDACTED]`,
			)
			.replace(assignment, (match) => `${match.split(/[=:]/u)[0]}=[REDACTED]`)
			.replace(bearer, "Bearer [REDACTED]")
			.replace(filesystemPath, "[PATH_REDACTED]")
			.slice(0, 512);
	if (Array.isArray(value))
		return value.slice(0, 64).map((entry) => redact(entry, depth + 1));
	if (value && typeof value === "object") {
		const output: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value).slice(0, 64))
			output[key] =
				!safeIdentifierKey.test(key) && secretKey.test(key)
					? "[REDACTED]"
					: redact(entry, depth + 1);
		return output;
	}
	return value;
}

function safeDiagnostic(value: unknown): unknown {
	const redacted = redact(value);
	try {
		const serialized = JSON.stringify(redacted);
		if (serialized.length <= maxDiagnosticBytes) return redacted;
		return { summary: "diagnostic truncated", bytes: serialized.length };
	} catch {
		return { summary: "diagnostic unavailable" };
	}
}

function boundedQuery(
	query: RuntimeProjectionQuery = {},
): Required<Pick<RuntimeProjectionQuery, "cursor" | "limit">> &
	RuntimeProjectionQuery {
	const cursor = query.cursor ?? 0;
	const limit = query.limit ?? 100;
	if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > 1_000_000)
		throw new Error(
			"runtime projection cursor must be a safe non-negative integer",
		);
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
		throw new Error(
			"runtime projection limit must be an integer from 1 to 100",
		);
	return { ...query, cursor, limit };
}

function endpointFacts(
	endpoints: readonly RuntimeEndpointView[],
): readonly Record<string, unknown>[] {
	return endpoints.map((endpoint) => ({
		endpoint_id: endpoint.endpointId,
		generation_id: endpoint.generationId,
		route_kind: endpoint.routeKind,
		revision: endpoint.revision,
		state: endpoint.state,
		owner_fence: endpoint.ownerFence,
		delivery_mode: endpoint.deliveryMode,
		readiness: endpoint.readiness,
		control_state: endpoint.controlState,
		consumer_ready: endpoint.consumerReady,
		consumption_observed: endpoint.consumptionObserved,
		delivery_observed: endpoint.deliveryObserved,
		delivery_failed: endpoint.deliveryFailed,
		capabilities: endpoint.capabilities.map((capability) => ({
			capability: capability.capability,
			adapter_id: capability.adapterId,
			adapter_version: capability.adapterVersion,
			qualification: capability.qualification,
			readiness: capability.readiness,
			delivery_mode: capability.deliveryMode,
			evidence_kind: capability.evidenceKind,
			observed_at: capability.observedAt,
		})),
	}));
}

function generationItem(
	session: RuntimeSessionView,
	generation: RuntimeSessionGenerationView,
	endpoints: readonly RuntimeEndpointView[],
): Record<string, unknown> {
	return {
		project_id: session.projectId,
		session_id: session.sessionId,
		generation_id: generation.generationId,
		ordinal: generation.ordinal,
		harness: generation.harness,
		state: generation.state,
		metadata: safeDiagnostic(generation.metadata),
		provenance: safeDiagnostic({
			lifecycle: generation.lifecycleProvenance,
			fields: generation.fieldProvenance,
		}),
		actor_activity_at: generation.activityAt ?? session.activityAt ?? null,
		observation: {
			observed_at: generation.observedAt ?? session.observedAt ?? null,
			read_only: true,
		},
		revision: generation.revision,
		endpoints: endpointFacts(endpoints),
	};
}

function page(
	stream: RuntimeProjectionStream,
	revision: number,
	generatedAt: string,
	items: readonly Record<string, unknown>[],
	query: RuntimeProjectionQuery,
	explain: Record<string, unknown>,
	observation: Record<string, unknown>,
	drift: Record<string, unknown>,
): RuntimeProjectionPage {
	const bounded = boundedQuery(query);
	const visible = items.slice(bounded.cursor, bounded.cursor + bounded.limit);
	const next =
		bounded.cursor + visible.length < items.length
			? bounded.cursor + visible.length
			: undefined;
	return Object.freeze({
		schema_version: "golem.runtime-projection/v1",
		stream,
		resource_revision: revision,
		cursor: bounded.cursor,
		...(next === undefined ? {} : { next_cursor: next }),
		generated_at: generatedAt,
		items: Object.freeze(visible),
		explain: Object.freeze(explain),
		observation: Object.freeze(observation),
		drift: Object.freeze(drift),
	});
}

export class RuntimeProjectionService implements RuntimeProjectionPort {
	readonly #storage: RuntimeProjectionStorage;
	readonly #clock: RuntimeProjectionClock;
	readonly #legacy: RuntimeLegacyDriftPort | undefined;

	constructor(options: {
		readonly storage: RuntimeProjectionStorage;
		readonly clock?: RuntimeProjectionClock;
		readonly legacy?: RuntimeLegacyDriftPort;
	}) {
		this.#storage = options.storage;
		this.#clock = options.clock ?? { now: () => new Date().toISOString() };
		this.#legacy = options.legacy;
	}

	revision(_stream: RuntimeProjectionStream): number {
		return this.#storage.revision();
	}

	query(
		stream: RuntimeProjectionStream,
		input: RuntimeProjectionQuery = {},
	): RuntimeProjectionPage {
		const query = boundedQuery(input);
		if (stream === "runtime.diagnostics") {
			const events = this.#storage.events();
			const diagnostics = this.#storage.diagnostics();
			const items = diagnostics.map((diagnostic: RuntimeDiagnosticRecord) => ({
				id: diagnostic.id,
				code: diagnostic.code,
				details: safeDiagnostic(diagnostic.details),
				created_at: diagnostic.createdAt,
			}));
			return page(
				stream,
				this.revision(stream),
				this.#clock.now(),
				items,
				query,
				{
					source: "runtime_events + diagnostics",
					accepted: events.filter((event) => event.disposition === "accepted")
						.length,
					rejected: events.filter((event) => event.disposition !== "accepted")
						.length,
				},
				{
					read_only: true,
					producer_watermarks: this.#storage.watermarks().map((watermark) => ({
						producer_id: watermark.producerId,
						watermark: watermark.watermark,
						received_at: watermark.receivedAt,
					})),
				},
				{ status: "not_configured" },
			);
		}
		const terminal = stream === "runtime.history";
		const items = this.#storage.sessions(query.projectId).flatMap((session) =>
			session.generations
				.filter(
					(generation) => terminal || !terminalStates.has(generation.state),
				)
				.filter(
					(generation) => !query.state || generation.state === query.state,
				)
				.map((generation) =>
					generationItem(
						session,
						generation,
						this.#storage.endpoints(generation.generationId),
					),
				),
		);
		const payload = page(
			stream,
			this.revision(stream),
			this.#clock.now(),
			items,
			query,
			{
				source: "canonical runtime session/generation projections",
				terminal_excluded_from_live: true,
				observation_does_not_change_actor_activity: true,
			},
			{ read_only: true },
			{ status: "not_configured" },
		);
		if (!this.#legacy?.compare) return payload;
		const drift = this.#legacy.compare(
			stream,
			payload as unknown as Record<string, unknown>,
		);
		return Object.freeze({ ...payload, drift: Object.freeze({ ...drift }) });
	}

	read(
		stream: RuntimeProjectionStream,
		query?: RuntimeProjectionQuery,
	): Record<string, unknown> {
		return this.query(stream, query);
	}
}

export function createRuntimeProjectionService(
	options: ConstructorParameters<typeof RuntimeProjectionService>[0],
): RuntimeProjectionService {
	return new RuntimeProjectionService(options);
}
