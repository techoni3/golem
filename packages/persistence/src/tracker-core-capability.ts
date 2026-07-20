import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

import type { TrackerTables } from "./internals.js";
import { TrackerCoreRepository } from "./tracker-core-repository.js";
import type { TrackerCoreStorageCapability } from "./types.js";

type SqliteDatabase = ConstructorParameters<
	typeof SqliteDialect
>[0]["database"];

/**
 * Migration-neutral tracker attachment used by the shipped dashboard.  The
 * legacy opener owns schema discovery/migration; this capability only opens a
 * second typed connection after that opener has completed.  It never opens the
 * runtime database, acquires the persistence owner lock, or applies a plan.
 */
class TrackerCoreCapability extends TrackerCoreRepository {
	readonly #database: import("./internals.js").SqliteConnection;
	readonly #queries: Kysely<TrackerTables>;

	constructor(database: import("./internals.js").SqliteConnection) {
		const queries = new Kysely<TrackerTables>({
			dialect: new SqliteDialect({
				database: database as unknown as SqliteDatabase,
			}),
		});
		super(queries, database);
		this.#database = database;
		this.#queries = queries;
		// Connection-local only; no schema or migration mutation.
		database.pragma("busy_timeout = 5000");
	}

	async close(): Promise<void> {
		try {
			await this.#queries.destroy();
		} finally {
			this.#database.close();
		}
	}
}

export interface TrackerCoreCapabilityHandle
	extends TrackerCoreStorageCapability {
	close(): Promise<void>;
}

/** Open the typed tracker capability on an already-managed tracker database. */
export function openTrackerCoreCapability(
	trackerPath: string,
): TrackerCoreCapabilityHandle {
	return new TrackerCoreCapability(
		new Database(
			trackerPath,
		) as unknown as import("./internals.js").SqliteConnection,
	);
}
