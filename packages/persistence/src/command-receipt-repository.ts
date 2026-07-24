import type { Kysely } from "kysely";

import type { SqliteConnection, TrackerTables } from "./internals.js";
import { SyncKyselyTrackerStore } from "./kysely-sync.js";
import type {
	CommandGatewayStorage,
	CommandReceiptRecord,
	CommandReceiptStorage,
} from "./types.js";

interface CommandReceiptRow {
	readonly command_id: string;
	readonly idempotency_key: string;
	readonly command_kind: string;
	readonly actor_id: string;
	readonly project_id: string;
	readonly resource_type: string;
	readonly resource_id: string;
	readonly correlation_id: string;
	readonly fingerprint: string;
	readonly outcome_status: string;
	readonly reason_code: string | null;
	readonly operation_id: string | null;
	readonly result_json: string | null;
	readonly committed_at: string;
}

function json(value: unknown): string {
	return JSON.stringify(value);
}

function rowReceipt(row: CommandReceiptRow): CommandReceiptRecord {
	const parsed = (() => {
		try {
			const value = JSON.parse(row.result_json ?? "{}") as unknown;
			return value && typeof value === "object" && !Array.isArray(value)
				? (value as Readonly<Record<string, unknown>>)
				: {};
		} catch {
			return {};
		}
	})();
	return Object.freeze({
		command_id: row.command_id,
		idempotency_key: row.idempotency_key,
		command_kind: row.command_kind,
		actor_id: row.actor_id,
		project_id: row.project_id,
		resource_type: row.resource_type,
		resource_id: row.resource_id,
		correlation_id: row.correlation_id,
		fingerprint: row.fingerprint,
		outcome_status:
			row.outcome_status as CommandReceiptRecord["outcome_status"],
		...(row.reason_code ? { reason_code: row.reason_code } : {}),
		...(row.operation_id ? { operation_id: row.operation_id } : {}),
		result: parsed,
		committed_at: row.committed_at,
	});
}

/**
 * Durable command receipt repository.  The command gateway records one
 * terminal outcome per (project_id, idempotency_key) here, in the same tracker
 * transaction as the domain mutation, so a restart-safe replay returns the
 * original typed outcome without re-running any side effect.
 *
 * Retained rows never contain bearer/cookie/CSRF, raw prompt, fence token, or
 * storage path (see GOL-79 migration/rollback constraints).  Only the canonical
 * fingerprint of the request payload is stored.
 */
export class CommandReceiptRepository implements CommandReceiptStorage {
	readonly #store: SyncKyselyTrackerStore;

	constructor(queries: Kysely<TrackerTables>, database: SqliteConnection) {
		this.#store = new SyncKyselyTrackerStore(queries, database);
	}

	find(
		projectId: string,
		idempotencyKey: string,
	): CommandReceiptRecord | undefined {
		const row = this.#store.get<CommandReceiptRow>(
			this.#store.queries
				.selectFrom("command_receipts")
				.selectAll()
				.where("project_id", "=", projectId)
				.where("idempotency_key", "=", idempotencyKey)
				.limit(1),
		);
		return row ? rowReceipt(row) : undefined;
	}

	record(input: CommandReceiptRecord): void {
		this.#store.run(
			this.#store.queries.insertInto("command_receipts").values({
				command_id: input.command_id,
				idempotency_key: input.idempotency_key,
				command_kind: input.command_kind,
				actor_id: input.actor_id,
				project_id: input.project_id,
				resource_type: input.resource_type,
				resource_id: input.resource_id,
				correlation_id: input.correlation_id,
				fingerprint: input.fingerprint,
				outcome_status: input.outcome_status,
				reason_code: input.reason_code ?? null,
				operation_id: input.operation_id ?? null,
				result_json: json(input.result),
				committed_at: input.committed_at,
			}),
		);
	}

	transaction<Result>(fn: () => Result): Result {
		return this.#store.transaction(() => fn());
	}

	gateway(): CommandGatewayStorage {
		const receipts: CommandReceiptStorage = this;

		return Object.freeze({
			receipts,
			transaction: <Result>(fn: () => Result): Result => this.transaction(fn),
		});
	}
}
