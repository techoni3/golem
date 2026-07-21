import crypto from "node:crypto";
import { RuntimeEndpointRepository } from "./endpoint-repository.js";
import type { SqliteConnection } from "./internals.js";
import { sha256 } from "./schema.js";
import { RuntimeSessionRepository } from "./session-repository.js";
import type {
	ClaimedOutboxRecord,
	PersistenceClock,
	ProjectIdentitySource,
	RuntimeEndpointStorage,
	RuntimeMaterializationInput,
	RuntimeMaterializationResult,
	RuntimeOutboxFailure,
	RuntimeOutboxHealth,
	RuntimeProjectLocationInput,
	RuntimeProjectLocationView,
	RuntimeProjectObservationInput,
	RuntimeProjectObservationResult,
	RuntimeProjectStorage,
	RuntimeProjectView,
	RuntimeSessionStorage,
	RuntimeTransactionInput,
	RuntimeTransactionResult,
} from "./types.js";
import { RuntimeFailpointError } from "./types.js";

const cryptoBoundary = crypto as { randomUUID(): string };
const maxOutboxAttempts = 5;

function json(value: Readonly<Record<string, unknown>>): string {
	return JSON.stringify(value);
}

function boundedLimit(limit: number): number {
	if (!Number.isInteger(limit) || limit < 1 || limit > 100)
		throw new Error(
			"runtime outbox claim limit must be an integer from 1 to 100",
		);
	return limit;
}

function retryDelayMs(attempts: number): number {
	return Math.min(60_000, 1_000 * 2 ** Math.max(0, attempts - 1));
}

function redactOutboxError(value: string): string {
	return value
		.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED]@")
		.replace(/\bBearer\s+[A-Za-z0-9._-]+/giu, "Bearer [REDACTED]")
		.replace(
			/\b(token|authorization|password|secret)=([^\s&]+)/giu,
			"$1=[REDACTED]",
		)
		.replace(/\/[A-Za-z0-9._~\-/]{12,}/gu, "[PATH]")
		.slice(0, 512);
}

function terminal(state: string): boolean {
	return state === "ended" || state === "errored" || state === "superseded";
}

function objectJson(
	value: string | null | undefined,
): Readonly<Record<string, unknown>> {
	if (!value) return {};
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Readonly<Record<string, unknown>>)
			: {};
	} catch {
		return {};
	}
}

function projectId(): string {
	return `prj_${cryptoBoundary.randomUUID()}`;
}

interface ProjectRow {
	readonly project_id: string;
	readonly name: string;
	readonly created_at: string;
}

interface LocationRow {
	readonly location_id: string;
	readonly project_id: string;
	readonly canonical_path: string;
	readonly observed_path: string | null;
	readonly relation: RuntimeProjectLocationInput["relation"];
}

interface LocationStateRow {
	readonly status: "active" | "retired" | "unregistered";
	readonly last_confirmed_at: string | null;
	readonly provenance_json: string;
}

/** Transactional project/location repository behind the runtime owner. */
export class RuntimeProjectRepository implements RuntimeProjectStorage {
	readonly #database: SqliteConnection;
	readonly #clock: PersistenceClock;

	constructor(database: SqliteConnection, clock: PersistenceClock) {
		this.#database = database;
		this.#clock = clock;
	}

	#view(projectIdValue: string): RuntimeProjectView | undefined {
		const project = this.#database
			.prepare<ProjectRow>(
				"SELECT project_id, name, created_at FROM projects WHERE project_id = ?",
			)
			.get(projectIdValue);
		if (!project) return undefined;
		const metadata = this.#database
			.prepare<{
				readonly name_source: ProjectIdentitySource;
				readonly metadata_json: string;
			}>(
				"SELECT name_source, metadata_json FROM project_metadata WHERE project_id = ?",
			)
			.get(projectIdValue);
		const identityKeys = this.#database
			.prepare<{ readonly identity_key: string }>(
				"SELECT identity_key FROM project_identity_keys WHERE project_id = ? ORDER BY identity_key",
			)
			.all(projectIdValue)
			.map((row) => row.identity_key);
		const locations = this.#database
			.prepare<LocationRow>(
				"SELECT location_id, project_id, canonical_path, observed_path, relation FROM project_locations WHERE project_id = ? ORDER BY created_at, location_id",
			)
			.all(projectIdValue)
			.map((row): RuntimeProjectLocationView => {
				const state = this.#database
					.prepare<LocationStateRow>(
						"SELECT status, last_confirmed_at, provenance_json FROM project_location_state WHERE project_id = ? AND location_id = ?",
					)
					.get(row.project_id, row.location_id);
				return Object.freeze({
					locationId: row.location_id,
					canonicalPath: row.canonical_path,
					...(row.observed_path ? { observedPath: row.observed_path } : {}),
					relation: row.relation,
					status: state?.status ?? "active",
					...(state?.last_confirmed_at
						? { lastConfirmedAt: state.last_confirmed_at }
						: {}),
					provenance: objectJson(state?.provenance_json),
				});
			});
		return Object.freeze({
			projectId: project.project_id,
			name: project.name,
			nameSource: metadata?.name_source ?? "legacy_import",
			metadata: objectJson(metadata?.metadata_json),
			identityKeys: Object.freeze(identityKeys),
			locations: Object.freeze(locations),
		});
	}

	get(projectIdValue: string): RuntimeProjectView | undefined {
		return this.#view(projectIdValue);
	}

	findByCanonicalPath(canonicalPath: string): RuntimeProjectView | undefined {
		const row = this.#database
			.prepare<{ readonly project_id: string }>(
				"SELECT project_id FROM project_locations WHERE canonical_path = ?",
			)
			.get(canonicalPath);
		return row ? this.#view(row.project_id) : undefined;
	}

	findByIdentityKey(identityKey: string): RuntimeProjectView | undefined {
		const row = this.#database
			.prepare<{ readonly project_id: string }>(
				"SELECT project_id FROM project_identity_keys WHERE identity_key = ?",
			)
			.get(identityKey);
		return row ? this.#view(row.project_id) : undefined;
	}

	#ensureMetadata(
		projectIdValue: string,
		name: string,
		source: ProjectIdentitySource,
		metadata: Readonly<Record<string, unknown>>,
		provenance: Readonly<Record<string, unknown>>,
		now: string,
	): void {
		const existing = this.#database
			.prepare<{ readonly name_source: ProjectIdentitySource }>(
				"SELECT name_source FROM project_metadata WHERE project_id = ?",
			)
			.get(projectIdValue);
		const manual = existing?.name_source === "register";
		if (!existing) {
			this.#database
				.prepare(
					"INSERT INTO project_metadata(project_id, name_source, metadata_json, provenance_json, updated_at) VALUES (?, ?, ?, ?, ?)",
				)
				.run(projectIdValue, source, json(metadata), json(provenance), now);
		} else {
			this.#database
				.prepare(
					"UPDATE project_metadata SET name_source = ?, metadata_json = ?, provenance_json = ?, updated_at = ? WHERE project_id = ?",
				)
				.run(
					manual ? "register" : source,
					json(metadata),
					json(provenance),
					now,
					projectIdValue,
				);
		}
		if (!manual || source === "register")
			this.#database
				.prepare("UPDATE projects SET name = ? WHERE project_id = ?")
				.run(name, projectIdValue);
	}

	#ensureLocation(
		projectIdValue: string,
		location: RuntimeProjectLocationInput,
		provenance: Readonly<Record<string, unknown>>,
		now: string,
	): string {
		const existingPath = this.#database
			.prepare<LocationRow>(
				"SELECT location_id, project_id, canonical_path, observed_path, relation FROM project_locations WHERE canonical_path = ?",
			)
			.get(location.canonicalPath);
		if (existingPath && existingPath.project_id !== projectIdValue)
			throw new Error("runtime.project.identity_conflict");
		const existingLocation = this.#database
			.prepare<LocationRow>(
				"SELECT location_id, project_id, canonical_path, observed_path, relation FROM project_locations WHERE project_id = ? AND location_id = ?",
			)
			.get(projectIdValue, location.locationId);
		if (
			existingLocation &&
			existingLocation.canonical_path !== location.canonicalPath
		)
			throw new Error("runtime.project.location_conflict");
		const resolvedLocation = existingLocation ?? existingPath;
		if (!resolvedLocation) {
			this.#database
				.prepare(
					"INSERT INTO project_locations(location_id, project_id, canonical_path, observed_path, relation, source_observed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					location.locationId,
					projectIdValue,
					location.canonicalPath,
					location.observedPath ?? null,
					location.relation,
					location.observedAt,
					now,
				);
		}
		const resolvedLocationId = resolvedLocation?.location_id ?? location.locationId;
		this.#database
			.prepare(
				"INSERT INTO project_location_state(project_id, location_id, status, last_confirmed_at, provenance_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, location_id) DO UPDATE SET status = excluded.status, last_confirmed_at = excluded.last_confirmed_at, provenance_json = excluded.provenance_json",
			)
			.run(
				projectIdValue,
				resolvedLocationId,
				location.status ?? "active",
				now,
				json(provenance),
			);
		this.#database
			.prepare(
				"INSERT OR IGNORE INTO location_aliases(project_id, location_id, alias_path, alias_kind, observed_at, provenance_json) VALUES (?, ?, ?, 'path', ?, ?)",
			)
			.run(
				projectIdValue,
				resolvedLocationId,
				location.canonicalPath,
				now,
				json(provenance),
			);
		if (location.observedPath)
			this.#database
				.prepare(
					"INSERT OR IGNORE INTO location_aliases(project_id, location_id, alias_path, alias_kind, observed_at, provenance_json) VALUES (?, ?, ?, 'path', ?, ?)",
				)
				.run(
					projectIdValue,
					resolvedLocationId,
					location.observedPath,
					now,
					json(provenance),
				);
		return resolvedLocationId;
	}

	#identityKey(
		projectIdValue: string,
		identityKey: string | undefined,
		source: ProjectIdentitySource,
		provenance: Readonly<Record<string, unknown>>,
		now: string,
	): void {
		if (!identityKey) return;
		const existing = this.#database
			.prepare<{ readonly project_id: string }>(
				"SELECT project_id FROM project_identity_keys WHERE identity_key = ?",
			)
			.get(identityKey);
		if (existing && existing.project_id !== projectIdValue)
			throw new Error("runtime.project.identity_conflict");
		this.#database
			.prepare(
				"INSERT INTO project_identity_keys(project_id, identity_key, source, provenance_json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, identity_key) DO UPDATE SET source = excluded.source, provenance_json = excluded.provenance_json, updated_at = excluded.updated_at",
			)
			.run(projectIdValue, identityKey, source, json(provenance), now);
	}

	#worktreeAlias(
		projectIdValue: string,
		locationId: string,
		identityKey: string | undefined,
		provenance: Readonly<Record<string, unknown>>,
		now: string,
	): void {
		if (!identityKey?.startsWith("git-common:", 0)) return;
		this.#database
			.prepare(
				"INSERT OR IGNORE INTO location_aliases(project_id, location_id, alias_path, alias_kind, observed_at, provenance_json) VALUES (?, ?, ?, 'worktree', ?, ?)",
			)
			.run(projectIdValue, locationId, identityKey, now, json(provenance));
	}

	#writeOutbox(
		projectIdValue: string,
		event: string,
		payload: Readonly<Record<string, unknown>>,
		now: string,
	): string {
		const outboxId = sha256(
			`project:${projectIdValue}:${event}:${JSON.stringify(payload)}`,
		).slice(0, 32);
		this.#database
			.prepare(
				"INSERT OR IGNORE INTO runtime_outbox(id, destination, payload_json, status, created_at, attempts) VALUES (?, 'management', ?, 'pending', ?, 0)",
			)
			.run(outboxId, json(payload), now);
		return outboxId;
	}

	#writeProjectEvent(
		projectIdValue: string,
		event: string,
		payload: Readonly<Record<string, unknown>>,
		provenance: Readonly<Record<string, unknown>>,
		now: string,
	): string {
		const identity = `${projectIdValue}:${event}:${JSON.stringify(payload)}`;
		const eventId = `evt_${sha256(identity).slice(0, 32)}`;
		this.#database
			.prepare(
				"INSERT OR IGNORE INTO runtime_events(event_id, deduplication_key, event_kind, payload_json, provenance_json, source_observed_at, received_at, materialized_at, activity_at, metadata_version, disposition) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'golem.runtime-signal/v1', 'accepted')",
			)
			.run(
				eventId,
				`project:${identity}`,
				event,
				json(payload),
				json(provenance),
				now,
				now,
				now,
				now,
			);
		return eventId;
	}

	observe(
		input: RuntimeProjectObservationInput,
	): RuntimeProjectObservationResult {
		return this.#database.transaction(() => {
			const now = this.#clock.now();
			const existingEvent = this.#database
				.prepare<{ readonly event_id: string }>(
					"SELECT event_id FROM runtime_events WHERE event_id = ? OR deduplication_key = ?",
				)
				.get(input.eventId, input.deduplicationKey);
			if (existingEvent) {
				const existing = this.#database
					.prepare<{
						readonly project_id: string;
						readonly location_id: string;
					}>(
						"SELECT project_id, location_id FROM project_locations WHERE canonical_path = ?",
					)
					.get(input.location.canonicalPath);
				return Object.freeze({
					disposition: "duplicate" as const,
					projectId: existing?.project_id ?? input.projectId ?? "",
					locationId: existing?.location_id ?? input.location.locationId,
				});
			}
			const byIdentity = input.identityKey
				? this.findByIdentityKey(input.identityKey)
				: undefined;
			const byPath = this.findByCanonicalPath(input.location.canonicalPath);
			if (byIdentity && byPath && byIdentity.projectId !== byPath.projectId)
				throw new Error("runtime.project.identity_conflict");
			const resolvedProjectId =
				input.projectId ??
				byIdentity?.projectId ??
				byPath?.projectId ??
				projectId();
			if (input.projectId && byPath && byPath.projectId !== input.projectId)
				throw new Error("runtime.project.identity_conflict");
			this.#database
				.prepare(
					"INSERT OR IGNORE INTO projects(project_id, name, created_at) VALUES (?, ?, ?)",
				)
				.run(resolvedProjectId, input.name, now);
			this.#ensureMetadata(
				resolvedProjectId,
				input.name,
				input.source,
				input.metadata ?? {},
				input.provenance,
				now,
			);
			const locationId = this.#ensureLocation(
				resolvedProjectId,
				input.location,
				input.provenance,
				now,
			);
			this.#worktreeAlias(
				resolvedProjectId,
				locationId,
				input.identityKey,
				input.provenance,
				now,
			);
			this.#identityKey(
				resolvedProjectId,
				input.identityKey,
				input.source,
				input.provenance,
				now,
			);
			this.#database
				.prepare(
					"INSERT INTO runtime_events(event_id, deduplication_key, event_kind, payload_json, provenance_json, source_observed_at, received_at, materialized_at, activity_at, metadata_version, disposition) VALUES (?, ?, 'project.observed', ?, ?, ?, ?, ?, ?, 'golem.runtime-signal/v1', 'accepted')",
				)
				.run(
					input.eventId,
					input.deduplicationKey,
					json(input.payload),
					json(input.provenance),
					input.occurredAt,
					now,
					now,
					input.occurredAt,
				);
			const outboxId = this.#writeOutbox(
				resolvedProjectId,
				"project.observed",
				{
					event_id: input.eventId,
					project_id: resolvedProjectId,
					location_id: locationId,
				},
				now,
			);
			return Object.freeze({
				disposition: "accepted" as const,
				projectId: resolvedProjectId,
				locationId,
				outboxId,
			});
		})() as RuntimeProjectObservationResult;
	}

	attachLocation(input: {
		readonly projectId: string;
		readonly name?: string;
		readonly location: RuntimeProjectLocationInput;
		readonly identityKey?: string;
		readonly metadata?: Readonly<Record<string, unknown>>;
		readonly source: ProjectIdentitySource;
	}): RuntimeProjectView {
		return this.#database.transaction(() => {
			const now = this.#clock.now();
			if (!this.#view(input.projectId))
				throw new Error("runtime.project.not_found");
			const provenance = {
				source: input.source,
				evidence: input.location.evidence,
			};
			this.#ensureMetadata(
				input.projectId,
				input.name ?? this.#view(input.projectId)?.name ?? input.projectId,
				input.source,
				input.metadata ?? {},
				provenance,
				now,
			);
			const locationId = this.#ensureLocation(
				input.projectId,
				input.location,
				provenance,
				now,
			);
			this.#worktreeAlias(
				input.projectId,
				locationId,
				input.identityKey,
				provenance,
				now,
			);
			this.#identityKey(
				input.projectId,
				input.identityKey,
				input.source,
				provenance,
				now,
			);
			const eventId = this.#writeProjectEvent(
				input.projectId,
				"project.location.attached",
				{ project_id: input.projectId, location_id: locationId },
				provenance,
				now,
			);
			this.#writeOutbox(
				input.projectId,
				"project.location.attached",
				{
					event_id: eventId,
					project_id: input.projectId,
					location_id: locationId,
				},
				now,
			);
			return this.#view(input.projectId) as RuntimeProjectView;
		})() as RuntimeProjectView;
	}

	retireLocation(
		projectIdValue: string,
		locationId: string,
		reason: string,
	): RuntimeProjectView {
		return this.#database.transaction(() => {
			const now = this.#clock.now();
			if (!this.#view(projectIdValue))
				throw new Error("runtime.project.not_found");
			const changed = this.#database
				.prepare(
					"UPDATE project_location_state SET status = 'retired', provenance_json = ? WHERE project_id = ? AND location_id = ?",
				)
				.run(
					json({ source: "register", reason }),
					projectIdValue,
					locationId,
				).changes;
			if (changed !== 1) throw new Error("runtime.project.location_not_found");
			const eventId = this.#writeProjectEvent(
				projectIdValue,
				"project.location.retired",
				{ project_id: projectIdValue, location_id: locationId, reason },
				{ source: "register", reason },
				now,
			);
			this.#writeOutbox(
				projectIdValue,
				"project.location.retired",
				{
					event_id: eventId,
					project_id: projectIdValue,
					location_id: locationId,
					reason,
				},
				now,
			);
			return this.#view(projectIdValue) as RuntimeProjectView;
		})() as RuntimeProjectView;
	}

	rename(
		projectIdValue: string,
		name: string,
		source: ProjectIdentitySource = "register",
	): RuntimeProjectView {
		return this.#database.transaction(() => {
			const current = this.#view(projectIdValue);
			if (!current) throw new Error("runtime.project.not_found");
			const now = this.#clock.now();
			this.#ensureMetadata(
				projectIdValue,
				name,
				source,
				current.metadata,
				{ source },
				now,
			);
			const eventId = this.#writeProjectEvent(
				projectIdValue,
				"project.renamed",
				{ project_id: projectIdValue, name },
				{ source },
				now,
			);
			this.#writeOutbox(
				projectIdValue,
				"project.renamed",
				{ event_id: eventId, project_id: projectIdValue, name },
				now,
			);
			return this.#view(projectIdValue) as RuntimeProjectView;
		})() as RuntimeProjectView;
	}
}

interface ClaimedOutboxRow {
	readonly id: string;
	readonly destination: "tracker" | "management";
	readonly payload_json: string;
	readonly attempts: number;
}

interface ExpiredOutboxRow {
	readonly id: string;
	readonly claim_token: string;
}

export class RuntimeRepository {
	readonly #database: SqliteConnection;
	readonly #clock: PersistenceClock;

	constructor(database: SqliteConnection, clock: PersistenceClock) {
		this.#database = database;
		this.#clock = clock;
	}

	runtimeProjectStorage(): RuntimeProjectStorage {
		return new RuntimeProjectRepository(this.#database, this.#clock);
	}

	runtimeSessionStorage(): RuntimeSessionStorage {
		return new RuntimeSessionRepository(this.#database, this.#clock);
	}

	runtimeEndpointStorage(): RuntimeEndpointStorage {
		return new RuntimeEndpointRepository(this.#database, this.#clock);
	}

	record(input: RuntimeTransactionInput): RuntimeTransactionResult {
		const transaction = this.#database.transaction(() => {
			// Producer time comes from the signal; only receipt/materialization use
			// the owner-injected clock so delayed delivery remains explainable.
			const receivedAt = this.#clock.now();
			const materializedAt = this.#clock.now();
			const inserted = this.#database
				.prepare(
					"INSERT OR IGNORE INTO runtime_events(event_id, deduplication_key, event_kind, payload_json, provenance_json, source_observed_at, received_at, materialized_at, activity_at, metadata_version, disposition) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'golem.event/v1', 'accepted')",
				)
				.run(
					input.eventId,
					input.deduplicationKey,
					input.eventKind,
					json(input.payload),
					json(input.provenance),
					input.occurredAt,
					receivedAt,
					materializedAt,
					input.occurredAt,
				);
			if (inserted.changes === 0) return { disposition: "duplicate" } as const;
			if (input.mutation.project) {
				const project = input.mutation.project;
				this.#database
					.prepare(
						"INSERT OR IGNORE INTO projects(project_id, name, created_at) VALUES (?, ?, ?)",
					)
					.run(project.projectId, project.name, materializedAt);
				this.#database
					.prepare(
						"INSERT OR IGNORE INTO project_locations(location_id, project_id, canonical_path, observed_path, relation, source_observed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						project.locationId,
						project.projectId,
						project.canonicalPath,
						project.observedPath ?? null,
						project.relation,
						input.occurredAt,
						materializedAt,
					);
			}
			if (input.mutation.generation) {
				const generation = input.mutation.generation;
				this.#database
					.prepare(
						"INSERT OR IGNORE INTO logical_sessions(session_id, project_id, provenance_json, created_at) VALUES (?, ?, ?, ?)",
					)
					.run(
						generation.sessionId,
						generation.projectId,
						json(input.provenance),
						materializedAt,
					);
				this.#database
					.prepare(
						"INSERT OR IGNORE INTO session_generations(generation_id, session_id, project_id, ordinal, harness, lifecycle_state, lifecycle_schema_version, lifecycle_provenance_json, field_schema_version, field_provenance_json, source_observed_at, received_at, activity_at, materialized_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						generation.generationId,
						generation.sessionId,
						generation.projectId,
						generation.ordinal,
						generation.harness,
						generation.state,
						generation.lifecycleProvenance.schemaVersion,
						json(generation.lifecycleProvenance.details),
						generation.fieldProvenance.schemaVersion,
						json(generation.fieldProvenance.details),
						input.occurredAt,
						receivedAt,
						input.occurredAt,
						materializedAt,
						terminal(generation.state) ? materializedAt : null,
					);
			}
			const outboxId = sha256(
				`${input.eventId}:${input.outbox.destination}`,
			).slice(0, 32);
			this.#database
				.prepare(
					"INSERT INTO runtime_outbox(id, destination, payload_json, status, created_at, attempts) VALUES (?, ?, ?, 'pending', ?, 0)",
				)
				.run(
					outboxId,
					input.outbox.destination,
					json(input.outbox.payload),
					materializedAt,
				);
			if (input.failpoint === "before_commit")
				throw new RuntimeFailpointError("before_commit");
			return { disposition: "accepted", outboxId } as const;
		});
		const result = transaction();
		if (result.disposition === "accepted" && input.failpoint === "after_commit")
			throw new RuntimeFailpointError("after_commit");
		return result;
	}

	/**
	 * The materializer's atomic boundary: source event, producer watermark,
	 * canonical mutation, explanation, and optional cross-store outbox record.
	 * A lower-or-equal producer sequence is retained as an auditable stale event
	 * but cannot mutate canonical rows or enqueue delivery.
	 */
	materialize(
		input: RuntimeMaterializationInput,
	): RuntimeMaterializationResult {
		return this.#database.transaction(() => {
			const receivedAt = this.#clock.now();
			const materializedAt = this.#clock.now();
			const currentWatermark = this.#database
				.prepare<{ readonly watermark: string }>(
					"SELECT watermark FROM producer_watermarks WHERE producer_id = ?",
				)
				.get(input.producer.id);
			const priorSequence = currentWatermark
				? Number(/^([0-9]+):/u.exec(currentWatermark.watermark)?.[1])
				: undefined;
			const stale =
				input.producer.sequence !== undefined &&
				priorSequence !== undefined &&
				Number.isSafeInteger(priorSequence) &&
				input.producer.sequence <= priorSequence;
			const disposition = stale ? "stale" : input.disposition;
			const inserted = this.#database
				.prepare(
					"INSERT OR IGNORE INTO runtime_events(event_id, deduplication_key, event_kind, payload_json, provenance_json, source_observed_at, received_at, materialized_at, activity_at, metadata_version, disposition) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'golem.runtime-signal/v1', ?)",
				)
				.run(
					input.eventId,
					input.deduplicationKey,
					input.eventKind,
					json(input.payload),
					json(input.provenance),
					input.occurredAt,
					receivedAt,
					materializedAt,
					disposition === "accepted" ? input.occurredAt : null,
					disposition,
				);
			if (inserted.changes === 0)
				return Object.freeze({ disposition: "duplicate" as const });

			this.#database
				.prepare(
					"INSERT OR REPLACE INTO diagnostics(id, code, details_json, created_at) VALUES (?, ?, ?, ?)",
				)
				.run(
					sha256(`${input.eventId}:${input.explanation.code}`).slice(0, 32),
					input.explanation.code,
					json({
						event_id: input.eventId,
						disposition,
						...input.explanation.details,
					}),
					materializedAt,
				);

			if (disposition !== "accepted")
				return Object.freeze({
					disposition: disposition as "stale" | "illegal",
					materializedAt,
				});

			if (input.producer.sequence !== undefined) {
				const watermark = `${input.producer.sequence}:${input.eventId}`;
				this.#database
					.prepare(
						"INSERT INTO producer_watermarks(producer_id, watermark, source_observed_at, received_at, materialized_at, provenance_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(producer_id) DO UPDATE SET watermark = excluded.watermark, source_observed_at = excluded.source_observed_at, received_at = excluded.received_at, materialized_at = excluded.materialized_at, provenance_json = excluded.provenance_json",
					)
					.run(
						input.producer.id,
						watermark,
						input.occurredAt,
						receivedAt,
						materializedAt,
						json(input.provenance),
					);
			}
			if (input.mutation?.project) {
				const project = input.mutation.project;
				this.#database
					.prepare(
						"INSERT OR IGNORE INTO projects(project_id, name, created_at) VALUES (?, ?, ?)",
					)
					.run(project.projectId, project.name, materializedAt);
				this.#database
					.prepare(
						"INSERT OR IGNORE INTO project_locations(location_id, project_id, canonical_path, observed_path, relation, source_observed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						project.locationId,
						project.projectId,
						project.canonicalPath,
						project.observedPath ?? null,
						project.relation,
						input.occurredAt,
						materializedAt,
					);
			}
			let outboxId: string | undefined;
			if (input.outbox) {
				outboxId = sha256(`${input.eventId}:${input.outbox.destination}`).slice(
					0,
					32,
				);
				this.#database
					.prepare(
						"INSERT INTO runtime_outbox(id, destination, payload_json, status, created_at, attempts) VALUES (?, ?, ?, 'pending', ?, 0)",
					)
					.run(
						outboxId,
						input.outbox.destination,
						json(input.outbox.payload),
						materializedAt,
					);
			}
			return Object.freeze({
				disposition: "accepted" as const,
				...(outboxId ? { outboxId } : {}),
				materializedAt,
			});
		})();
	}

	#failClaim(
		id: string,
		claimToken: string,
		error: string,
	): RuntimeOutboxFailure | undefined {
		const row = this.#database
			.prepare<{
				readonly attempts: number;
			}>(
				"SELECT attempts FROM runtime_outbox WHERE id = ? AND status = 'claimed' AND claim_token = ?",
			)
			.get(id, claimToken);
		if (!row) return undefined;
		const permanent = row.attempts >= maxOutboxAttempts;
		const at = this.#clock.now();
		const nextAttemptAt = permanent
			? undefined
			: this.#clock.after(retryDelayMs(row.attempts));
		this.#database
			.prepare(
				"UPDATE runtime_outbox SET status = ?, claim_owner = NULL, claim_token = NULL, claim_until = NULL, retry_started_at = ?, next_attempt_at = ?, last_error = ?, permanent_failure_at = ? WHERE id = ? AND status = 'claimed' AND claim_token = ?",
			)
			.run(
				permanent ? "permanent_failure" : "pending",
				permanent ? null : at,
				nextAttemptAt ?? null,
				redactOutboxError(error),
				permanent ? at : null,
				id,
				claimToken,
			);
		return Object.freeze({
			status: permanent ? "permanent_failure" : "pending",
			attempts: row.attempts,
			...(nextAttemptAt ? { nextAttemptAt } : {}),
			...(permanent ? { permanentFailureAt: at } : {}),
		});
	}

	#replayExpiredClaims(): number {
		const now = this.#clock.now();
		const expired = this.#database
			.prepare<ExpiredOutboxRow>(
				"SELECT id, claim_token FROM runtime_outbox WHERE status = 'claimed' AND claim_until < ? ORDER BY claim_until, id",
			)
			.all(now);
		let replayed = 0;
		for (const row of expired)
			if (this.#failClaim(row.id, row.claim_token, "claim lease expired"))
				replayed += 1;
		return replayed;
	}

	claim(
		workerId: string,
		limit: number,
		leaseMs = 30_000,
	): readonly ClaimedOutboxRecord[] {
		if (!workerId.trim() || !Number.isInteger(leaseMs) || leaseMs < 1)
			throw new Error(
				"runtime outbox claim requires a worker id and positive lease",
			);
		const maximum = boundedLimit(limit);
		return this.#database.transaction(() => {
			this.#replayExpiredClaims();
			const now = this.#clock.now();
			const rows = this.#database
				.prepare<ClaimedOutboxRow>(
					"SELECT id, destination, payload_json, attempts FROM runtime_outbox WHERE status = 'pending' AND attempts < ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at, id LIMIT ?",
				)
				.all(maxOutboxAttempts, now, maximum);
			const claimUntil = this.#clock.after(leaseMs);
			return rows.map((row) => {
				const claimToken = cryptoBoundary.randomUUID();
				const changed = this.#database
					.prepare(
						"UPDATE runtime_outbox SET status = 'claimed', claim_owner = ?, claim_token = ?, claim_until = ?, next_attempt_at = NULL, attempts = attempts + 1 WHERE id = ? AND status = 'pending' AND attempts < ?",
					)
					.run(
						workerId,
						claimToken,
						claimUntil,
						row.id,
						maxOutboxAttempts,
					).changes;
				if (changed !== 1)
					throw new Error("runtime outbox claim lost its transaction lease");
				return Object.freeze({
					id: row.id,
					destination: row.destination,
					payload: JSON.parse(row.payload_json) as Readonly<
						Record<string, unknown>
					>,
					claimToken,
					attempts: row.attempts + 1,
				});
			});
		})();
	}

	replay(): number {
		return this.#database.transaction(() => this.#replayExpiredClaims())();
	}

	ack(id: string, claimToken: string): boolean {
		return (
			this.#database
				.prepare(
					"UPDATE runtime_outbox SET status = 'published', published_at = ?, claim_owner = NULL, claim_token = NULL, claim_until = NULL, next_attempt_at = NULL WHERE id = ? AND status = 'claimed' AND claim_token = ?",
				)
				.run(this.#clock.now(), id, claimToken).changes === 1
		);
	}

	fail(
		id: string,
		claimToken: string,
		error: string,
	): RuntimeOutboxFailure | undefined {
		if (!error.trim())
			throw new Error("runtime outbox failure requires an error");
		return this.#database.transaction(() =>
			this.#failClaim(id, claimToken, error),
		)();
	}

	health(): RuntimeOutboxHealth {
		const now = this.#clock.now();
		const row = this.#database
			.prepare<{
				readonly pending: number;
				readonly claimed: number;
				readonly published: number;
				readonly permanent_failures: number;
				readonly oldest_retry_at: string | null;
				readonly last_success_at: string | null;
			}>(
				"SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END) AS claimed, SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published, SUM(CASE WHEN status = 'permanent_failure' THEN 1 ELSE 0 END) AS permanent_failures, MIN(CASE WHEN status = 'pending' AND retry_started_at IS NOT NULL THEN retry_started_at END) AS oldest_retry_at, MAX(published_at) AS last_success_at FROM runtime_outbox",
			)
			.get();
		const oldestRetryAt = row?.oldest_retry_at ?? undefined;
		return Object.freeze({
			pending: Number(row?.pending ?? 0),
			claimed: Number(row?.claimed ?? 0),
			published: Number(row?.published ?? 0),
			permanentFailures: Number(row?.permanent_failures ?? 0),
			...(oldestRetryAt
				? {
						oldestRetryAgeMs: Math.max(
							0,
							Date.parse(now) - Date.parse(oldestRetryAt),
						),
					}
				: {}),
			...(row?.last_success_at ? { lastSuccessAt: row.last_success_at } : {}),
		});
	}
}
