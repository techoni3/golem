import type { CompiledQuery, Kysely } from "kysely";

import type { SqliteConnection, TrackerTables } from "./internals.js";

type Compilable = { compile(): CompiledQuery };

/**
 * Synchronous better-sqlite3 execution for typed Kysely builders.
 *
 * The tracker contract is intentionally synchronous because the shipped
 * dashboard facade is synchronous.  Query text is still produced exclusively
 * by Kysely against the private TrackerTables map; this adapter only bridges
 * Kysely's compiled query to the owner-held SQLite connection.
 */
export class SyncKyselyTrackerStore {
	readonly #database: SqliteConnection;
	readonly #queries: Kysely<TrackerTables>;

	constructor(queries: Kysely<TrackerTables>, database: SqliteConnection) {
		this.#queries = queries;
		this.#database = database;
	}

	get queries(): Kysely<TrackerTables> {
		return this.#queries;
	}

	run(query: Compilable): {
		readonly changes: number;
		readonly lastInsertRowid: number | bigint;
	} {
		const compiled = query.compile();
		return this.#database.prepare(compiled.sql).run(...compiled.parameters);
	}

	get<Row = Record<string, unknown>>(query: Compilable): Row | undefined {
		const compiled = query.compile();
		return this.#database
			.prepare<Row>(compiled.sql)
			.get(...compiled.parameters);
	}

	all<Row = Record<string, unknown>>(query: Compilable): readonly Row[] {
		const compiled = query.compile();
		return this.#database
			.prepare<Row>(compiled.sql)
			.all(...compiled.parameters);
	}

	transaction<Result>(fn: () => Result): Result {
		return this.#database.transaction(() => fn()).immediate();
	}
}
