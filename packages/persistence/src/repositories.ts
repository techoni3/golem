import crypto from "node:crypto";

import type { SqliteConnection } from "./internals.js";
import { sha256 } from "./schema.js";
import type {
	ClaimedOutboxRecord,
	PersistenceClock,
	RuntimeOutboxFailure,
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

function terminal(state: string): boolean {
	return state === "ended" || state === "errored" || state === "superseded";
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
				"UPDATE runtime_outbox SET status = ?, claim_owner = NULL, claim_token = NULL, claim_until = NULL, next_attempt_at = ?, last_error = ?, permanent_failure_at = ? WHERE id = ? AND status = 'claimed' AND claim_token = ?",
			)
			.run(
				permanent ? "permanent_failure" : "pending",
				nextAttemptAt ?? null,
				error.slice(0, 1_024),
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
}
