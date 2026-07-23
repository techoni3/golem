import crypto from "node:crypto";

import type { SqliteConnection } from "./internals.js";
import type {
	ClaimedCommittedPublicationRecord,
	CommittedPublicationCategory,
	CommittedPublicationRecord,
	CommittedPublicationStorage,
} from "./types.js";

interface PublicationRow {
	readonly id: string;
	readonly project_id: string;
	readonly category: CommittedPublicationCategory;
	readonly resource_type: string;
	readonly resource_id: string;
	readonly resource_revision: number;
	readonly project_revision: number;
	readonly schema_version: "golem.committed-invalidation/v1";
	readonly policy_version: number;
	readonly created_at: string;
	readonly claim_token: string | null;
}

function rowPublication(
	row: PublicationRow,
): CommittedPublicationRecord | ClaimedCommittedPublicationRecord {
	const base = Object.freeze({
		id: row.id,
		projectId: row.project_id,
		category: row.category,
		resourceType: row.resource_type,
		resourceId: row.resource_id,
		resourceRevision: row.resource_revision,
		projectRevision: row.project_revision,
		schemaVersion: row.schema_version,
		policyVersion: row.policy_version,
		createdAt: row.created_at,
	});
	return row.claim_token
		? Object.freeze({ ...base, claimToken: row.claim_token })
		: base;
}

/**
 * The only reader of GOL-80 committed invalidation rows.  Writers are SQLite
 * triggers inside the same domain transaction, so repository/adaptor callers
 * cannot forget to publish or publish after commit.
 */
export class CommittedPublicationRepository
	implements CommittedPublicationStorage
{
	readonly #database: SqliteConnection;

	constructor(database: SqliteConnection) {
		this.#database = database;
	}

	claim(input: {
		readonly workerId: string;
		readonly now: string;
		readonly claimUntil: string;
		readonly limit: number;
	}): readonly ClaimedCommittedPublicationRecord[] {
		if (
			!input.workerId ||
			!Number.isSafeInteger(input.limit) ||
			input.limit < 1 ||
			input.limit > 128
		)
			throw new Error("committed publication claim input is invalid");
		return this.#database
			.transaction(() => {
				this.recover(input.now);
				const rows = this.#database
					.prepare<PublicationRow>(
						`SELECT id, project_id, category, resource_type, resource_id,
              resource_revision, project_revision, schema_version,
              policy_version, created_at, claim_token
             FROM committed_publication_outbox
             WHERE status = 'pending'
             -- A project revision is the canonical cursor exposed by HTTP and
             -- WS. Timestamps may be equal (or supplied by a deterministic
             -- clock), so id ordering could publish revision N+1 before N.
             -- Scope first, then the committed revision, preserves the
             -- monotonic per-project replay contract without imposing a
             -- global cross-project sequence.
             ORDER BY project_id ASC, project_revision ASC, id ASC
             LIMIT ?`,
					)
					.all(input.limit);
				const claimed: ClaimedCommittedPublicationRecord[] = [];
				for (const row of rows) {
					const claimToken = `cpub_${crypto.randomUUID()}`;
					const changed = this.#database
						.prepare(
							`UPDATE committed_publication_outbox
               SET status = 'claimed', claim_owner = ?, claim_token = ?, claim_until = ?
               WHERE id = ? AND status = 'pending'`,
						)
						.run(input.workerId, claimToken, input.claimUntil, row.id);
					if (changed.changes !== 1) continue;
					claimed.push(
						rowPublication({
							...row,
							claim_token: claimToken,
						}) as ClaimedCommittedPublicationRecord,
					);
				}
				return Object.freeze(claimed);
			})
			.immediate();
	}

	recover(now: string): number {
		const result = this.#database
			.prepare(
				`UPDATE committed_publication_outbox
         SET status = 'pending', claim_owner = NULL, claim_token = NULL, claim_until = NULL
         WHERE status = 'claimed' AND claim_until <= ?`,
			)
			.run(now);
		return result.changes;
	}

	ack(input: {
		readonly id: string;
		readonly claimToken: string;
		readonly publishedAt: string;
	}): boolean {
		return (
			this.#database
				.prepare(
					`UPDATE committed_publication_outbox
           SET status = 'published', published_at = ?, claim_owner = NULL,
               claim_token = NULL, claim_until = NULL
           WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
				)
				.run(input.publishedAt, input.id, input.claimToken).changes === 1
		);
	}

	projectRevision(projectId: string): number {
		const row = this.#database
			.prepare<{ readonly revision: number }>(
				"SELECT revision FROM committed_project_revisions WHERE project_id = ?",
			)
			.get(projectId);
		return row?.revision ?? 0;
	}

	outboxCount(projectId: string): number {
		const row = this.#database
			.prepare<{ readonly count: number }>(
				"SELECT count(*) AS count FROM committed_publication_outbox WHERE project_id = ?",
			)
			.get(projectId);
		return Number(row?.count ?? 0);
	}
}
