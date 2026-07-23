import type { RuntimeSignalV1 } from "@golem/contracts";
import { lifecycleDecision, lifecycleRank } from "@golem/domain";

import type { SqliteConnection } from "./internals.js";
import { sha256 } from "./schema.js";
import type {
	GenerationLifecycleState,
	Harness,
	PersistenceClock,
	RuntimeSessionAliasInput,
	RuntimeSessionApplyInput,
	RuntimeSessionApplyResult,
	RuntimeSessionCommandContext,
	RuntimeSessionGenerationView,
	RuntimeSessionStorage,
	RuntimeSessionView,
	SessionAliasKind,
} from "./types.js";

type JsonObject = Readonly<Record<string, unknown>>;

interface GenerationRow {
	generation_id: string;
	session_id: string;
	project_id: string;
	ordinal: number;
	harness: Harness;
	lifecycle_state: GenerationLifecycleState;
	lifecycle_provenance_json: string;
	field_provenance_json: string;
	source_observed_at: string;
	received_at: string;
	activity_at: string | null;
	materialized_at: string;
	ended_at: string | null;
}

interface GenerationProjectionRow {
	metadata_json: string;
	field_provenance_json: string;
	parent_generation_id: string | null;
	continuation: "resume" | null;
	actor_activity_at: string | null;
	observed_at: string | null;
	revision: number;
}

interface SessionProjectionRow {
	revision: number;
	metadata_json: string;
	field_provenance_json: string;
	role_json: string | null;
	actor_activity_at: string | null;
	observed_at: string | null;
}

function objectJson(value: string | null | undefined): JsonObject {
	if (!value) return {};
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as JsonObject)
			: {};
	} catch {
		return {};
	}
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, nested]) => [key, stableValue(nested)]),
	);
}

function json(value: unknown): string {
	return JSON.stringify(stableValue(value));
}

function terminal(value: GenerationLifecycleState): boolean {
	return value === "ended" || value === "errored" || value === "superseded";
}

function rank(value: GenerationLifecycleState): number {
	return lifecycleRank[value] ?? 0;
}

interface Version {
	source: string;
	tie: string;
}

function version(signal: RuntimeSignalV1): Version {
	return {
		source: signal.clocks.source_event_at ?? signal.clocks.source_observed_at,
		tie: `${signal.event_id}:${signal.producer_instance_id}`,
	};
}

function compareVersion(left: Version, right: Version): number {
	const source = left.source.localeCompare(right.source);
	if (source !== 0) return source;
	return left.tie.localeCompare(right.tie);
}

function provenance(version_: Version, signal: RuntimeSignalV1): JsonObject {
	return {
		eventId: signal.event_id,
		producerInstanceId: signal.producer_instance_id,
		sourceTime: version_.source,
		tieBreak: version_.tie,
	};
}

function readVersion(value: JsonObject): Version | undefined {
	if (
		typeof value.sourceTime !== "string" ||
		typeof value.tieBreak !== "string"
	)
		return undefined;
	return { source: value.sourceTime, tie: value.tieBreak };
}

function readFieldVersion(value: JsonObject, key: string): Version | undefined {
	const candidate = value[key];
	return candidate && typeof candidate === "object" && !Array.isArray(candidate)
		? readVersion(candidate as JsonObject)
		: undefined;
}

function isTerminalState(value: GenerationLifecycleState): boolean {
	return terminal(value);
}

function generationRef(
	signal: RuntimeSignalV1,
): { projectId: string; sessionId: string; generationId: string } | undefined {
	const payload = signal.payload;
	if ("generation" in payload)
		return {
			projectId: payload.generation.project_id,
			sessionId: payload.generation.session_id,
			generationId: payload.generation.generation_id,
		};
	return undefined;
}

function aliasKey(input: {
	projectId: string;
	harness: Harness;
	aliasKind: SessionAliasKind;
	producerId?: string;
	alias: string;
}): readonly unknown[] {
	return [
		input.projectId,
		input.harness,
		input.aliasKind,
		input.producerId ?? null,
		input.alias,
	];
}

export class RuntimeSessionRepository implements RuntimeSessionStorage {
	readonly #database: SqliteConnection;
	readonly #clock: PersistenceClock;

	constructor(database: SqliteConnection, clock: PersistenceClock) {
		this.#database = database;
		this.#clock = clock;
	}

	attachAlias(input: RuntimeSessionAliasInput): RuntimeSessionApplyResult {
		const transaction = this.#database.transaction(() => {
			const result = this.#attachAlias(input);
			if (result.disposition === "accepted" && result.sessionId)
				this.#recordAliasEffect(input, result.sessionId, result.generationId);
			return result;
		});
		return transaction();
	}

	apply(input: RuntimeSessionApplyInput): RuntimeSessionApplyResult {
		const transaction = this.#database.transaction(() => this.#apply(input));
		return transaction();
	}

	#apply(input: RuntimeSessionApplyInput): RuntimeSessionApplyResult {
		const signal = input.signal;
		const ref = generationRef(signal);
		if (!ref)
			return {
				disposition: "rejected",
				code: "runtime.session.invalid_payload",
			};
		const project = this.#database
			.prepare<{ project_id: string }>(
				"SELECT project_id FROM projects WHERE project_id = ?",
			)
			.get(ref.projectId);
		if (!project)
			return {
				disposition: "rejected",
				code: "runtime.session.project_unresolved",
				details: { projectId: ref.projectId },
			};
		if (input.alias) {
			if (
				input.alias.projectId !== ref.projectId ||
				input.alias.harness !== signal.harness
			)
				return {
					disposition: "review",
					code: "runtime.session.alias_scope_conflict",
				};
			const existing = this.#database
				.prepare<{ session_id: string | null; generation_id: string | null }>(
					"SELECT session_id, generation_id FROM session_aliases WHERE project_id = ? AND harness = ? AND alias_kind = ? AND COALESCE(producer_id, '') = COALESCE(?, '') AND alias = ?",
				)
				.get(...aliasKey(input.alias));
			if (existing && existing.session_id !== ref.sessionId)
				return {
					disposition: "review",
					code: "runtime.session.alias_conflict",
					details: { scope: "project_harness_producer" },
				};
			if (!existing && !input.alias.sessionId)
				return {
					disposition: "review",
					code: "runtime.session.alias_unresolved",
				};
			if (existing && existing.session_id === null)
				return {
					disposition: "review",
					code: "runtime.session.alias_unresolved",
				};
		}
		if (
			signal.payload.kind === "session.started" ||
			signal.payload.kind === "session.resumed"
		)
			return this.#start(signal, input.alias);
		const row = this.#database
			.prepare<GenerationRow>(
				"SELECT * FROM session_generations WHERE project_id = ? AND session_id = ? AND generation_id = ?",
			)
			.get(ref.projectId, ref.sessionId, ref.generationId);
		if (!row) {
			this.#queuePending(signal, ref);
			return {
				disposition: "review",
				code: "runtime.session.generation_pending",
				sessionId: ref.sessionId,
				generationId: ref.generationId,
			};
		}
		if (signal.payload.kind === "session.metadata_patched")
			return this.#patchMetadata(row, signal);
		if (
			signal.payload.kind === "session.activity" ||
			signal.payload.kind === "session.idle" ||
			signal.payload.kind === "session.waiting" ||
			signal.payload.kind === "session.ended"
		)
			return this.#lifecycle(row, signal);
		return {
			disposition: "rejected",
			code: "runtime.session.unsupported_event",
		};
	}

	#queuePending(
		signal: RuntimeSignalV1,
		ref: { projectId: string; sessionId: string; generationId: string },
	): void {
		this.#database
			.prepare(
				"INSERT OR REPLACE INTO session_pending_events(event_id, project_id, session_id, generation_id, event_json, source_observed_at, received_at, producer_instance_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				signal.event_id,
				ref.projectId,
				ref.sessionId,
				ref.generationId,
				json(signal),
				signal.clocks.source_event_at ?? signal.clocks.source_observed_at,
				signal.clocks.received_at,
				signal.producer_instance_id,
			);
	}

	#start(
		signal: RuntimeSignalV1,
		alias?: RuntimeSessionAliasInput,
	): RuntimeSessionApplyResult {
		const ref = generationRef(signal);
		if (!ref)
			return {
				disposition: "rejected",
				code: "runtime.session.invalid_payload",
			};
		const payload = signal.payload;
		if (
			payload.kind !== "session.started" &&
			payload.kind !== "session.resumed"
		)
			return {
				disposition: "rejected",
				code: "runtime.session.invalid_payload",
			};
		const existing = this.#database
			.prepare<GenerationRow>(
				"SELECT * FROM session_generations WHERE project_id = ? AND session_id = ? AND generation_id = ?",
			)
			.get(ref.projectId, ref.sessionId, ref.generationId);
		if (existing)
			return {
				disposition: "duplicate",
				code: "runtime.session.generation_duplicate",
				sessionId: ref.sessionId,
				generationId: ref.generationId,
			};
		if (payload.kind === "session.resumed") {
			const parentId = payload.resumed_from_generation_id;
			const parent =
				typeof parentId === "string" && parentId.length > 0
					? this.#database
							.prepare<{ generation_id: string }>(
								"SELECT generation_id FROM session_generations WHERE project_id = ? AND session_id = ? AND generation_id = ?",
							)
							.get(ref.projectId, ref.sessionId, parentId)
					: undefined;
			if (!parent) {
				this.#queuePending(signal, ref);
				return {
					disposition: "review",
					code: "runtime.session.generation_parent_pending",
					sessionId: ref.sessionId,
					generationId: ref.generationId,
				};
			}
		}
		const now = this.#clock.now();
		const v = version(signal);
		this.#database
			.prepare(
				"INSERT OR IGNORE INTO logical_sessions(session_id, project_id, provenance_json, created_at) VALUES (?, ?, ?, ?)",
			)
			.run(ref.sessionId, ref.projectId, json(provenance(v, signal)), now);
		const active = this.#database
			.prepare<
				Pick<
					GenerationRow,
					"generation_id" | "lifecycle_state" | "lifecycle_provenance_json"
				>
			>(
				"SELECT generation_id, lifecycle_state, lifecycle_provenance_json FROM session_generations WHERE project_id = ? AND session_id = ? AND lifecycle_state NOT IN ('ended','errored','superseded') ORDER BY ordinal DESC",
			)
			.get(ref.projectId, ref.sessionId);
		let createdState: GenerationLifecycleState = "starting";
		let createdLifecycle = provenance(v, signal);
		let createdEndedAt: string | null = null;
		if (active) {
			const prior = objectJson(active.lifecycle_provenance_json);
			const priorVersion = readVersion(prior);
			if (!priorVersion || compareVersion(v, priorVersion) > 0) {
				this.#database
					.prepare(
						"UPDATE session_generations SET lifecycle_state = 'superseded', lifecycle_provenance_json = ?, ended_at = ? WHERE generation_id = ?",
					)
					.run(json(provenance(v, signal)), v.source, active.generation_id);
			} else {
				createdState = "superseded";
				createdLifecycle = prior;
				createdEndedAt = priorVersion.source;
			}
		}
		const ordinal = Number(
			this.#database
				.prepare<{ next: number }>(
					"SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM session_generations WHERE project_id = ? AND session_id = ?",
				)
				.get(ref.projectId, ref.sessionId)?.next ?? 1,
		);
		const metadata =
			payload.kind === "session.started" ? (payload.metadata ?? {}) : {};
		const fieldProv = Object.fromEntries(
			Object.keys(metadata).map((key) => [key, provenance(v, signal)]),
		);
		const parent =
			payload.kind === "session.resumed"
				? (payload.resumed_from_generation_id ?? null)
				: null;
		this.#database
			.prepare(
				"INSERT INTO session_generations(generation_id, session_id, project_id, ordinal, harness, lifecycle_state, lifecycle_schema_version, lifecycle_provenance_json, field_schema_version, field_provenance_json, source_observed_at, received_at, activity_at, materialized_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, 'golem.lifecycle/v1', ?, 'golem.fields/v1', ?, ?, ?, NULL, ?, ?)",
			)
			.run(
				ref.generationId,
				ref.sessionId,
				ref.projectId,
				ordinal,
				signal.harness,
				createdState,
				json(createdLifecycle),
				json(fieldProv),
				signal.clocks.source_observed_at,
				signal.clocks.received_at,
				now,
				createdEndedAt,
			);
		this.#database
			.prepare(
				"INSERT INTO generation_projection(project_id, session_id, generation_id, revision, metadata_json, field_provenance_json, parent_generation_id, continuation, actor_activity_at, observed_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL, ?)",
			)
			.run(
				ref.projectId,
				ref.sessionId,
				ref.generationId,
				json(metadata),
				json(fieldProv),
				parent,
				parent ? "resume" : null,
				now,
			);
		const sessionRevision = this.#ensureSessionProjection(
			ref.projectId,
			ref.sessionId,
			metadata,
			fieldProv,
			now,
		);
		const started = this.#accepted(
			ref,
			sessionRevision,
			"runtime.session.generation_started",
			signal,
		);
		if (alias) {
			const aliasResult = this.#attachAlias(
				alias,
				ref.sessionId,
				ref.generationId,
			);
			if (aliasResult.disposition === "accepted")
				this.#recordAliasEffect(alias, ref.sessionId, ref.generationId);
		}
		this.#replayPending(ref.projectId, ref.sessionId);
		return started;
	}

	#replayPending(projectId: string, sessionId: string): void {
		const pending = this.#database
			.prepare<{ event_id: string; event_json: string }>(
				"SELECT event_id, event_json FROM session_pending_events WHERE project_id = ? AND session_id = ? ORDER BY source_observed_at, event_id, producer_instance_id",
			)
			.all(projectId, sessionId);
		for (const item of pending) {
			const pendingSignal = JSON.parse(item.event_json) as RuntimeSignalV1;
			const result = this.#apply({ signal: pendingSignal });
			if (result.disposition !== "review")
				this.#database
					.prepare("DELETE FROM session_pending_events WHERE event_id = ?")
					.run(item.event_id);
		}
	}

	#patchMetadata(
		row: GenerationRow,
		signal: RuntimeSignalV1,
	): RuntimeSessionApplyResult {
		if (terminal(row.lifecycle_state))
			return {
				disposition: "ignored",
				code: "runtime.session.terminal_immutable",
				sessionId: row.session_id,
				generationId: row.generation_id,
			};
		if (signal.payload.kind !== "session.metadata_patched")
			return {
				disposition: "rejected",
				code: "runtime.session.invalid_payload",
			};
		const projection = this.#database
			.prepare<GenerationProjectionRow>(
				"SELECT * FROM generation_projection WHERE project_id = ? AND session_id = ? AND generation_id = ?",
			)
			.get(row.project_id, row.session_id, row.generation_id);
		if (!projection)
			return {
				disposition: "rejected",
				code: "runtime.session.projection_missing",
			};
		const incoming = version(signal);
		const metadata = { ...objectJson(projection.metadata_json) };
		const provenanceMap = { ...objectJson(projection.field_provenance_json) };
		let changed = false;
		for (const [key, value] of Object.entries(signal.payload.metadata)) {
			const prior = readVersion(
				(provenanceMap[key] && typeof provenanceMap[key] === "object"
					? provenanceMap[key]
					: {}) as JsonObject,
			);
			if (!prior || compareVersion(incoming, prior) > 0) {
				metadata[key] = value;
				provenanceMap[key] = provenance(incoming, signal);
				changed = true;
			}
		}
		for (const key of signal.clear_fields) {
			const prior = readVersion(
				(provenanceMap[key] && typeof provenanceMap[key] === "object"
					? provenanceMap[key]
					: {}) as JsonObject,
			);
			if (!prior || compareVersion(incoming, prior) > 0) {
				delete metadata[key];
				provenanceMap[key] = provenance(incoming, signal);
				changed = true;
			}
		}
		if (!changed)
			return {
				disposition: "ignored",
				code: "runtime.session.field_stale",
				sessionId: row.session_id,
				generationId: row.generation_id,
				revision: projection.revision,
			};
		const now = this.#clock.now();
		const revision = projection.revision + 1;
		this.#database
			.prepare(
				"UPDATE generation_projection SET revision = ?, metadata_json = ?, field_provenance_json = ?, updated_at = ? WHERE project_id = ? AND session_id = ? AND generation_id = ?",
			)
			.run(
				revision,
				json(metadata),
				json(provenanceMap),
				now,
				row.project_id,
				row.session_id,
				row.generation_id,
			);
		this.#updateSessionProjection(
			row.project_id,
			row.session_id,
			metadata,
			provenanceMap,
			now,
		);
		return this.#accepted(
			{
				projectId: row.project_id,
				sessionId: row.session_id,
				generationId: row.generation_id,
			},
			revision,
			"runtime.session.metadata_patched",
			signal,
		);
	}

	#lifecycle(
		row: GenerationRow,
		signal: RuntimeSignalV1,
	): RuntimeSessionApplyResult {
		const projection = this.#database
			.prepare<GenerationProjectionRow>(
				"SELECT * FROM generation_projection WHERE project_id = ? AND session_id = ? AND generation_id = ?",
			)
			.get(row.project_id, row.session_id, row.generation_id);
		if (!projection)
			return {
				disposition: "rejected",
				code: "runtime.session.projection_missing",
			};
		const payload = signal.payload;
		const next: GenerationLifecycleState =
			payload.kind === "session.ended"
				? payload.disposition
				: payload.kind === "session.activity"
					? "active"
					: payload.kind === "session.idle"
						? "idle"
						: "waiting";
		const incoming = version(signal);
		const prior = readVersion(objectJson(row.lifecycle_provenance_json));
		const currentFields = objectJson(projection.field_provenance_json);
		const priorActivity = readFieldVersion(currentFields, "__activity");
		const activityApplies =
			payload.kind === "session.activity" &&
			(!priorActivity || compareVersion(incoming, priorActivity) > 0);
		const decision = lifecycleDecision(row.lifecycle_state, next);
		const lifecycleApplies =
			decision.disposition === "applied" &&
			(rank(next) > rank(row.lifecycle_state) ||
				(rank(next) === rank(row.lifecycle_state) &&
					(!prior || compareVersion(incoming, prior) > 0)));
		if (!lifecycleApplies && !activityApplies)
			return {
				disposition: "ignored",
				code: isTerminalState(row.lifecycle_state)
					? "runtime.session.terminal_immutable"
					: "runtime.session.lifecycle_stale",
				sessionId: row.session_id,
				generationId: row.generation_id,
				revision: projection.revision,
			};
		const now = this.#clock.now();
		const activity = activityApplies ? incoming.source : row.activity_at;
		const state = lifecycleApplies ? next : row.lifecycle_state;
		const activityPresent = Boolean(activity || priorActivity);
		const canonicalRevision =
			(isTerminalState(state) ? 3 : rank(state) > 0 ? 2 : 1) +
			(activityPresent ? 1 : 0);
		const revision = Math.max(projection.revision, canonicalRevision);
		const lifecycleProvenance = lifecycleApplies
			? provenance(incoming, signal)
			: objectJson(row.lifecycle_provenance_json);
		const endedAt = isTerminalState(state)
			? lifecycleApplies
				? incoming.source
				: row.ended_at
			: null;
		const fieldProvenance = {
			...currentFields,
			...(activityApplies ? { __activity: provenance(incoming, signal) } : {}),
		};
		this.#database
			.prepare(
				"UPDATE session_generations SET lifecycle_state = ?, lifecycle_provenance_json = ?, activity_at = ?, ended_at = ? WHERE project_id = ? AND session_id = ? AND generation_id = ?",
			)
			.run(
				state,
				json(lifecycleProvenance),
				activity,
				endedAt,
				row.project_id,
				row.session_id,
				row.generation_id,
			);
		this.#database
			.prepare(
				"UPDATE generation_projection SET revision = ?, field_provenance_json = ?, actor_activity_at = ?, updated_at = ? WHERE project_id = ? AND session_id = ? AND generation_id = ?",
			)
			.run(
				revision,
				json(fieldProvenance),
				activity,
				now,
				row.project_id,
				row.session_id,
				row.generation_id,
			);
		this.#touchSessionProjection(
			row.project_id,
			row.session_id,
			activityApplies ? activity : undefined,
			now,
			revision,
		);
		return this.#accepted(
			{
				projectId: row.project_id,
				sessionId: row.session_id,
				generationId: row.generation_id,
			},
			revision,
			activityApplies && !lifecycleApplies
				? "runtime.session.activity_after_terminal"
				: `runtime.session.lifecycle_${state}`,
			signal,
		);
	}

	#accepted(
		ref: { projectId: string; sessionId: string; generationId: string },
		revision: number,
		code: string,
		signal: RuntimeSignalV1,
	): RuntimeSessionApplyResult {
		const outboxId = sha256(
			`session:${signal.event_id}:${ref.sessionId}:${revision}`,
		).slice(0, 32);
		const now = this.#clock.now();
		this.#database
			.prepare(
				"INSERT OR IGNORE INTO runtime_outbox(id, destination, payload_json, status, created_at, attempts) VALUES (?, 'tracker', ?, 'pending', ?, 0)",
			)
			.run(
				outboxId,
				json({
					event_id: signal.event_id,
					event_kind: signal.event_kind,
					session_id: ref.sessionId,
					generation_id: ref.generationId,
					revision,
				}),
				now,
			);
		return {
			disposition: "accepted",
			code,
			sessionId: ref.sessionId,
			...(ref.generationId ? { generationId: ref.generationId } : {}),
			revision,
		};
	}

	#commandSignal(
		context: RuntimeSessionCommandContext,
		kind: RuntimeSignalV1["event_kind"],
		payload: unknown,
		clearFields: readonly string[] = [],
	): RuntimeSignalV1 {
		return {
			schema_version: "golem.runtime-signal/v1",
			event_id: context.eventId,
			event_kind: kind,
			producer: "session-command",
			producer_instance_id: context.producerInstanceId,
			harness: context.harness,
			correlation_id: context.eventId,
			deduplication_key: `session-command:${context.eventId}`,
			clocks: {
				source_observed_at: context.sourceObservedAt,
				received_at: context.receivedAt,
				materialized_at: context.receivedAt,
			},
			provenance: {
				source: "api",
				confidence: "verified",
				evidence_id: context.eventId,
			},
			clear_fields: [...clearFields],
			payload,
		} as unknown as RuntimeSignalV1;
	}

	#checkRevision(
		context: RuntimeSessionCommandContext,
	): RuntimeSessionApplyResult | undefined {
		const view = this.get(context.projectId, context.sessionId);
		if (!view)
			return {
				disposition: "rejected",
				code: "runtime.session.session_unresolved",
			};
		if (view.revision !== context.expectedRevision)
			return {
				disposition: "rejected",
				code: "runtime.session.revision_conflict",
				revision: view.revision,
				sessionId: context.sessionId,
				generationId: context.generationId,
			};
		return undefined;
	}

	rename(
		input: RuntimeSessionCommandContext & { readonly name: string },
	): RuntimeSessionApplyResult {
		const conflict = this.#checkRevision(input);
		if (conflict) return conflict;
		return this.apply({
			signal: this.#commandSignal(input, "session.metadata_patched", {
				kind: "session.metadata_patched",
				generation: {
					project_id: input.projectId,
					session_id: input.sessionId,
					generation_id: input.generationId,
				},
				metadata: { name: input.name },
			}),
		});
	}

	patchMetadata(
		input: RuntimeSessionCommandContext & {
			readonly metadata: JsonObject;
			readonly clearFields?: readonly string[];
		},
	): RuntimeSessionApplyResult {
		const conflict = this.#checkRevision(input);
		if (conflict) return conflict;
		return this.apply({
			signal: this.#commandSignal(
				input,
				"session.metadata_patched",
				{
					kind: "session.metadata_patched",
					generation: {
						project_id: input.projectId,
						session_id: input.sessionId,
						generation_id: input.generationId,
					},
					metadata: input.metadata,
				},
				input.clearFields ?? [],
			),
		});
	}

	end(
		input: RuntimeSessionCommandContext & {
			readonly disposition: "ended" | "errored" | "superseded";
		},
	): RuntimeSessionApplyResult {
		const conflict = this.#checkRevision(input);
		if (conflict) return conflict;
		return this.apply({
			signal: this.#commandSignal(input, "session.ended", {
				kind: "session.ended",
				generation: {
					project_id: input.projectId,
					session_id: input.sessionId,
					generation_id: input.generationId,
				},
				disposition: input.disposition,
			}),
		});
	}

	#ensureSessionProjection(
		projectId: string,
		sessionId: string,
		metadata: JsonObject,
		fields: JsonObject,
		now: string,
	): number {
		const before = this.#database
			.prepare<{ revision: number }>(
				"SELECT revision FROM session_projection WHERE project_id = ? AND session_id = ?",
			)
			.get(projectId, sessionId);
		if (before) {
			this.#database
				.prepare(
					"UPDATE session_projection SET revision = revision + 1, updated_at = ? WHERE project_id = ? AND session_id = ?",
				)
				.run(now, projectId, sessionId);
			return before.revision + 1;
		}
		this.#database
			.prepare(
				"INSERT OR IGNORE INTO session_projection(project_id, session_id, revision, metadata_json, field_provenance_json, role_json, actor_activity_at, observed_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, NULL, NULL, ?)",
			)
			.run(
				projectId,
				sessionId,
				json(metadata),
				json(fields),
				typeof metadata.role === "string" ? metadata.role : null,
				now,
			);
		return 1;
	}

	#updateSessionProjection(
		projectId: string,
		sessionId: string,
		metadata: JsonObject,
		fields: JsonObject,
		now: string,
	): void {
		this.#database
			.prepare(
				"UPDATE session_projection SET revision = revision + 1, metadata_json = ?, field_provenance_json = ?, role_json = ?, updated_at = ? WHERE project_id = ? AND session_id = ?",
			)
			.run(
				json(metadata),
				json(fields),
				typeof metadata.role === "string" ? metadata.role : null,
				now,
				projectId,
				sessionId,
			);
	}

	#touchSessionProjection(
		projectId: string,
		sessionId: string,
		activity: string | null | undefined,
		now: string,
		minimumRevision?: number,
	): void {
		const revision = minimumRevision
			? (this.#database
					.prepare<{ revision: number }>(
						"SELECT revision FROM session_projection WHERE project_id = ? AND session_id = ?",
					)
					.get(projectId, sessionId)?.revision ?? 0)
			: undefined;
		if (activity === undefined)
			this.#database
				.prepare(
					`UPDATE session_projection SET revision = ${revision === undefined ? "revision + 1" : `MAX(revision, ${revision})`}, updated_at = ? WHERE project_id = ? AND session_id = ?`,
				)
				.run(now, projectId, sessionId);
		else
			this.#database
				.prepare(
					`UPDATE session_projection SET revision = ${revision === undefined ? "revision + 1" : `MAX(revision, ${revision})`}, actor_activity_at = ?, updated_at = ? WHERE project_id = ? AND session_id = ?`,
				)
				.run(activity, now, projectId, sessionId);
	}

	#attachAlias(
		input: RuntimeSessionAliasInput,
		sessionId = input.sessionId,
		generationId = input.generationId,
	): RuntimeSessionApplyResult {
		if (!sessionId)
			return {
				disposition: "review",
				code: "runtime.session.alias_unresolved",
			};
		const session = this.#database
			.prepare<{ project_id: string }>(
				"SELECT project_id FROM logical_sessions WHERE project_id = ? AND session_id = ?",
			)
			.get(input.projectId, sessionId);
		if (!session)
			return {
				disposition: "review",
				code: "runtime.session.alias_unresolved",
			};
		if (generationId) {
			const generation = this.#database
				.prepare<{ project_id: string }>(
					"SELECT project_id FROM session_generations WHERE project_id = ? AND session_id = ? AND generation_id = ?",
				)
				.get(input.projectId, sessionId, generationId);
			if (!generation)
				return {
					disposition: "review",
					code: "runtime.session.alias_unresolved",
				};
		}
		const existing = this.#database
			.prepare<{ session_id: string | null; generation_id: string | null }>(
				"SELECT session_id, generation_id FROM session_aliases WHERE project_id = ? AND harness = ? AND alias_kind = ? AND COALESCE(producer_id, '') = COALESCE(?, '') AND alias = ?",
			)
			.get(...aliasKey(input));
		if (
			existing &&
			(existing.session_id !== sessionId ||
				(generationId &&
					existing.generation_id &&
					existing.generation_id !== generationId))
		)
			return { disposition: "review", code: "runtime.session.alias_conflict" };
		if (
			existing &&
			existing.session_id === sessionId &&
			(existing.generation_id ?? null) === (generationId ?? null)
		)
			return {
				disposition: "duplicate",
				code: "runtime.session.alias_duplicate",
				sessionId,
				...(generationId ? { generationId } : {}),
			};
		if (!existing)
			this.#database
				.prepare(
					"INSERT INTO session_aliases(project_id, harness, alias_kind, producer_id, alias, session_id, generation_id, source, provenance_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					input.projectId,
					input.harness,
					input.aliasKind,
					input.producerId ?? null,
					input.alias,
					sessionId,
					generationId ?? null,
					input.source,
					json(input.provenance),
					this.#clock.now(),
				);
		return {
			disposition: "accepted",
			code: "runtime.session.alias_attached",
			sessionId,
			...(generationId ? { generationId } : {}),
		};
	}

	#recordAliasEffect(
		input: RuntimeSessionAliasInput,
		sessionId: string,
		generationId?: string,
	): void {
		const now = this.#clock.now();
		const row = this.#database
			.prepare<{ revision: number }>(
				"SELECT revision FROM session_projection WHERE project_id = ? AND session_id = ?",
			)
			.get(input.projectId, sessionId);
		if (!row) return;
		const revision = row.revision + 1;
		this.#database
			.prepare(
				"UPDATE session_projection SET revision = ?, updated_at = ? WHERE project_id = ? AND session_id = ?",
			)
			.run(revision, now, input.projectId, sessionId);
		const identity = [
			input.projectId,
			input.harness,
			input.aliasKind,
			input.producerId ?? "",
			input.alias,
			sessionId,
			generationId ?? "",
		].join("|");
		const outboxId = sha256(`session.alias:${identity}:${revision}`).slice(
			0,
			32,
		);
		this.#database
			.prepare(
				"INSERT OR IGNORE INTO runtime_outbox(id, destination, payload_json, status, created_at, attempts) VALUES (?, 'tracker', ?, 'pending', ?, 0)",
			)
			.run(
				outboxId,
				json({
					event_id: `alias:${sha256(identity).slice(0, 24)}`,
					event_kind: "session.alias_attached",
					session_id: sessionId,
					generation_id: generationId,
					revision,
				}),
				now,
			);
	}

	observe(input: {
		projectId: string;
		sessionId: string;
		generationId?: string;
		observedAt: string;
	}): RuntimeSessionApplyResult {
		const transaction = this.#database.transaction(() => {
			const row = this.#database
				.prepare<SessionProjectionRow>(
					"SELECT * FROM session_projection WHERE project_id = ? AND session_id = ?",
				)
				.get(input.projectId, input.sessionId);
			if (!row)
				return {
					disposition: "rejected" as const,
					code: "runtime.session.session_unresolved",
				};
			const generation = input.generationId
				? this.#database
						.prepare<GenerationProjectionRow>(
							"SELECT * FROM generation_projection WHERE project_id = ? AND session_id = ? AND generation_id = ?",
						)
						.get(input.projectId, input.sessionId, input.generationId)
				: undefined;
			if (input.generationId && !generation)
				return {
					disposition: "rejected" as const,
					code: "runtime.session.generation_unresolved",
					sessionId: input.sessionId,
					generationId: input.generationId,
				};
			if (
				(row.observed_at && input.observedAt <= row.observed_at) ||
				(generation?.observed_at && input.observedAt <= generation.observed_at)
			)
				return {
					disposition: "ignored" as const,
					code: "runtime.session.observation_stale",
					sessionId: input.sessionId,
					...(input.generationId ? { generationId: input.generationId } : {}),
					revision: row.revision,
				};
			const now = this.#clock.now();
			const revision = row.revision + 1;
			const sessionFields = {
				...objectJson(row.field_provenance_json),
				__observed: {
					sourceTime: input.observedAt,
					tieBreak: `observe:${input.sessionId}`,
				},
			};
			this.#database
				.prepare(
					"UPDATE session_projection SET revision = ?, field_provenance_json = ?, observed_at = ?, updated_at = ? WHERE project_id = ? AND session_id = ?",
				)
				.run(
					revision,
					json(sessionFields),
					input.observedAt,
					now,
					input.projectId,
					input.sessionId,
				);
			if (generation && input.generationId) {
				const generationFields = {
					...objectJson(generation.field_provenance_json),
					__observed: {
						sourceTime: input.observedAt,
						tieBreak: `observe:${input.sessionId}`,
					},
				};
				this.#database
					.prepare(
						"UPDATE generation_projection SET revision = revision + 1, field_provenance_json = ?, observed_at = ?, updated_at = ? WHERE project_id = ? AND session_id = ? AND generation_id = ?",
					)
					.run(
						json(generationFields),
						input.observedAt,
						now,
						input.projectId,
						input.sessionId,
						input.generationId,
					);
			}
			const identity = `observe:${input.projectId}:${input.sessionId}:${input.generationId ?? "session"}:${input.observedAt}`;
			const outboxId = sha256(identity).slice(0, 32);
			this.#database
				.prepare(
					"INSERT OR IGNORE INTO runtime_outbox(id, destination, payload_json, status, created_at, attempts) VALUES (?, 'tracker', ?, 'pending', ?, 0)",
				)
				.run(
					outboxId,
					json({
						event_id: identity,
						event_kind: "session.observed",
						session_id: input.sessionId,
						generation_id: input.generationId,
						revision,
						observed_at: input.observedAt,
					}),
					now,
				);
			return {
				disposition: "accepted" as const,
				code: "runtime.session.observed",
				sessionId: input.sessionId,
				...(input.generationId ? { generationId: input.generationId } : {}),
				revision,
			};
		});
		return transaction();
	}

	findAlias(input: {
		projectId: string;
		harness: Harness;
		aliasKind: SessionAliasKind;
		producerId?: string;
		alias: string;
	}): Readonly<{ sessionId?: string; generationId?: string }> | undefined {
		const row = this.#database
			.prepare<{ session_id: string | null; generation_id: string | null }>(
				"SELECT session_id, generation_id FROM session_aliases WHERE project_id = ? AND harness = ? AND alias_kind = ? AND COALESCE(producer_id, '') = COALESCE(?, '') AND alias = ?",
			)
			.get(...aliasKey(input));
		if (!row) return undefined;
		return {
			...(row.session_id ? { sessionId: row.session_id } : {}),
			...(row.generation_id ? { generationId: row.generation_id } : {}),
		};
	}

	resolveLogicalSession(
		projectId: string,
		reference: string,
	): Readonly<{ sessionId: string; generationId: string }> | undefined {
		const candidates = new Set<string>();
		const direct = this.#database
			.prepare<{ readonly session_id: string }>(
				"SELECT session_id FROM logical_sessions WHERE project_id = ? AND session_id = ?",
			)
			.get(projectId, reference);
		if (direct) candidates.add(direct.session_id);
		for (const row of this.#database
			.prepare<{ readonly session_id: string }>(
				"SELECT DISTINCT session_id FROM session_aliases WHERE project_id = ? AND alias = ? AND session_id IS NOT NULL",
			)
			.all(projectId, reference))
			candidates.add(row.session_id);
		if (candidates.size !== 1) return undefined;
		const sessionId = [...candidates][0];
		if (!sessionId) return undefined;
		const session = this.get(projectId, sessionId);
		return session?.activeGenerationId
			? Object.freeze({ sessionId, generationId: session.activeGenerationId })
			: undefined;
	}

	get(projectId: string, sessionId: string): RuntimeSessionView | undefined {
		const session = this.#database
			.prepare<SessionProjectionRow>(
				"SELECT * FROM session_projection WHERE project_id = ? AND session_id = ?",
			)
			.get(projectId, sessionId);
		if (!session) return undefined;
		const rows = this.#database
			.prepare<GenerationRow & GenerationProjectionRow>(
				"SELECT g.*, p.metadata_json, p.field_provenance_json, p.parent_generation_id, p.continuation, p.actor_activity_at, p.observed_at, p.revision FROM session_generations g JOIN generation_projection p ON p.project_id = g.project_id AND p.session_id = g.session_id AND p.generation_id = g.generation_id WHERE g.project_id = ? AND g.session_id = ? ORDER BY g.ordinal",
			)
			.all(projectId, sessionId);
		const generations = rows.map(
			(row) =>
				({
					generationId: row.generation_id,
					sessionId: row.session_id,
					projectId: row.project_id,
					ordinal: row.ordinal,
					harness: row.harness,
					state: row.lifecycle_state,
					metadata: objectJson(row.metadata_json),
					fieldProvenance: objectJson(row.field_provenance_json),
					lifecycleProvenance: objectJson(row.lifecycle_provenance_json),
					...(row.parent_generation_id
						? {
								parentGenerationId: row.parent_generation_id,
								continuation: "resume" as const,
							}
						: {}),
					...(row.activity_at ? { activityAt: row.activity_at } : {}),
					...(row.observed_at ? { observedAt: row.observed_at } : {}),
					...(row.ended_at ? { endedAt: row.ended_at } : {}),
					revision: row.revision,
				}) satisfies RuntimeSessionGenerationView,
		);
		const active = generations.find(
			(generation) => !terminal(generation.state),
		);
		return {
			sessionId,
			projectId,
			revision: session.revision,
			metadata: objectJson(session.metadata_json),
			fieldProvenance: objectJson(session.field_provenance_json),
			...(session.role_json ? { role: session.role_json } : {}),
			...(session.actor_activity_at
				? { activityAt: session.actor_activity_at }
				: {}),
			...(session.observed_at ? { observedAt: session.observed_at } : {}),
			generationIds: generations.map((generation) => generation.generationId),
			...(active ? { activeGenerationId: active.generationId } : {}),
			generations,
		};
	}

	list(projectId: string): readonly RuntimeSessionView[] {
		return this.#database
			.prepare<{ session_id: string }>(
				"SELECT session_id FROM logical_sessions WHERE project_id = ? ORDER BY session_id",
			)
			.all(projectId)
			.flatMap((row) => {
				const value = this.get(projectId, row.session_id);
				return value ? [value] : [];
			});
	}
}
