import crypto from "node:crypto";

import type { SqliteConnection } from "./internals.js";
import { now, sha256 } from "./schema.js";
import {
	type ClaimedOutboxRecord,
	RuntimeFailpointError,
	type RuntimeTransactionInput,
	type RuntimeTransactionResult,
} from "./types.js";

const cryptoBoundary = crypto as { randomUUID(): string };

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

export class RuntimeRepository {
	readonly #database: SqliteConnection;

	constructor(database: SqliteConnection) {
		this.#database = database;
	}

	record(input: RuntimeTransactionInput): RuntimeTransactionResult {
		const transaction = this.#database.transaction(() => {
			const inserted = this.#database
				.prepare(
					"INSERT OR IGNORE INTO runtime_events(event_id, deduplication_key, event_kind, payload_json, provenance_json, occurred_at, received_at, metadata_version, disposition) VALUES (?, ?, ?, ?, ?, ?, ?, 'golem.event/v1', 'accepted')",
				)
				.run(
					input.eventId,
					input.deduplicationKey,
					input.eventKind,
					json(input.payload),
					json(input.provenance),
					input.occurredAt,
					now(),
				);
			if (inserted.changes === 0) return { disposition: "duplicate" } as const;
			if (input.mutation.project) {
				const project = input.mutation.project;
				this.#database
					.prepare(
						"INSERT OR IGNORE INTO projects(project_id, name, created_at) VALUES (?, ?, ?)",
					)
					.run(project.projectId, project.name, now());
				this.#database
					.prepare(
						"INSERT OR IGNORE INTO project_locations(project_id, location, observed_at) VALUES (?, ?, ?)",
					)
					.run(project.projectId, project.location, now());
			}
			if (input.mutation.generation) {
				const generation = input.mutation.generation;
				this.#database
					.prepare(
						"INSERT OR IGNORE INTO logical_sessions(session_id, project_id, created_at) VALUES (?, ?, ?)",
					)
					.run(generation.sessionId, generation.projectId, now());
				this.#database
					.prepare(
						"INSERT OR IGNORE INTO session_generations(generation_id, session_id, project_id, harness, lifecycle_state, provenance_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						generation.generationId,
						generation.sessionId,
						generation.projectId,
						generation.harness,
						generation.state,
						json(input.provenance),
						now(),
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
					now(),
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
			const expiredAt = new Date(Date.now() - 1).toISOString();
			this.#database
				.prepare(
					"UPDATE runtime_outbox SET status = 'pending', claim_owner = NULL, claim_token = NULL, claim_until = NULL WHERE status = 'claimed' AND claim_until < ?",
				)
				.run(expiredAt);
			const rows = this.#database
				.prepare<{
					readonly id: string;
					readonly destination: "tracker" | "management";
					readonly payload_json: string;
					readonly attempts: number;
				}>(
					"SELECT id, destination, payload_json, attempts FROM runtime_outbox WHERE status = 'pending' ORDER BY created_at, id LIMIT ?",
				)
				.all(maximum);
			const claimUntil = new Date(Date.now() + leaseMs).toISOString();
			return rows.map((row) => {
				const claimToken = cryptoBoundary.randomUUID();
				const changed = this.#database
					.prepare(
						"UPDATE runtime_outbox SET status = 'claimed', claim_owner = ?, claim_token = ?, claim_until = ?, attempts = attempts + 1 WHERE id = ? AND status = 'pending'",
					)
					.run(workerId, claimToken, claimUntil, row.id).changes;
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
		return this.#database
			.prepare(
				"UPDATE runtime_outbox SET status = 'pending', claim_owner = NULL, claim_token = NULL, claim_until = NULL WHERE status = 'claimed' AND claim_until < ?",
			)
			.run(new Date().toISOString()).changes;
	}

	ack(id: string, claimToken: string): boolean {
		return (
			this.#database
				.prepare(
					"UPDATE runtime_outbox SET status = 'published', published_at = ?, claim_owner = NULL, claim_until = NULL WHERE id = ? AND status = 'claimed' AND claim_token = ?",
				)
				.run(now(), id, claimToken).changes === 1
		);
	}
}
