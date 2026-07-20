import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

import { backupDatabase, health } from "./backup-health.js";
import type {
	RuntimeTables,
	SqliteConnection,
	TrackerTables,
} from "./internals.js";
import { acquireOwnerLock, releaseOwnerLock } from "./lock.js";
import { applyPlan, dryRunPlan, planFor } from "./migrations.js";
import { RuntimeRepository } from "./repositories.js";
import { configure, hasTrackerTables, now, sha256 } from "./schema.js";
import {
	type ClaimedOutboxRecord,
	type DatabaseScope,
	type MigrationMode,
	type MigrationPlan,
	type MigrationResult,
	PersistenceMigrationError,
	type PersistencePaths,
	type PersistenceStatus,
	type PersistenceWriteCapability,
	type RuntimeTransactionInput,
	type RuntimeTransactionResult,
} from "./types.js";

type SqliteDatabase = ConstructorParameters<
	typeof SqliteDialect
>[0]["database"];

const fileSystem = fs as {
	mkdirSync(target: string, options: { recursive: true; mode: number }): void;
};
const pathBoundary = path as { dirname(target: string): string };

function ensureParent(target: string): void {
	fileSystem.mkdirSync(pathBoundary.dirname(target), {
		recursive: true,
		mode: 0o700,
	});
}

function safeClose(database: SqliteConnection | undefined): void {
	try {
		database?.close();
	} catch {
		// Constructor cleanup only.
	}
}

class PersistenceOwner implements PersistenceWriteCapability {
	readonly #runtime: SqliteConnection;
	readonly #tracker: SqliteConnection;
	readonly #runtimeSql: Kysely<RuntimeTables>;
	readonly #trackerSql: Kysely<TrackerTables>;
	readonly #runtimeRepository: RuntimeRepository;
	readonly #paths: Readonly<PersistencePaths>;
	readonly #ownerId: string;
	readonly #lockPath: string;
	#closed = false;
	#trackerBaseline: "managed" | "unmanaged";

	constructor(paths: PersistencePaths, ownerId: string) {
		this.#paths = Object.freeze({ ...paths });
		this.#ownerId = ownerId;
		this.#lockPath = paths.lockPath ?? `${paths.runtimePath}.owner.lock`;
		acquireOwnerLock(this.#lockPath, ownerId);
		let runtime: SqliteConnection | undefined;
		let tracker: SqliteConnection | undefined;
		try {
			ensureParent(paths.runtimePath);
			ensureParent(paths.trackerPath);
			runtime = new Database(paths.runtimePath);
			tracker = new Database(paths.trackerPath);
			this.#runtime = runtime;
			this.#tracker = tracker;
			this.#runtimeSql = new Kysely<RuntimeTables>({
				dialect: new SqliteDialect({
					database: runtime as unknown as SqliteDatabase,
				}),
			});
			this.#trackerSql = new Kysely<TrackerTables>({
				dialect: new SqliteDialect({
					database: tracker as unknown as SqliteDatabase,
				}),
			});
			const runtimePlan = planFor(runtime, "runtime", "apply");
			this.#trackerBaseline = hasTrackerTables(tracker)
				? "unmanaged"
				: "managed";
			configure(runtime);
			applyPlan(runtime, paths.runtimePath, runtimePlan);
			if (this.#trackerBaseline === "managed") {
				configure(tracker);
				const trackerPlan = planFor(tracker, "tracker", "apply");
				applyPlan(tracker, paths.trackerPath, trackerPlan);
			}
			this.#runtimeRepository = new RuntimeRepository(runtime);
		} catch (error) {
			safeClose(runtime);
			safeClose(tracker);
			releaseOwnerLock(this.#lockPath);
			throw error;
		}
	}

	plan(scope: DatabaseScope, mode: MigrationMode = "dry-run"): MigrationPlan {
		const database = scope === "runtime" ? this.#runtime : this.#tracker;
		const databasePath =
			scope === "runtime" ? this.#paths.runtimePath : this.#paths.trackerPath;
		return mode === "dry-run"
			? dryRunPlan(database, databasePath, scope)
			: planFor(database, scope, "apply");
	}

	apply(scope: DatabaseScope, expectedPlanHash?: string): MigrationResult {
		const database = scope === "runtime" ? this.#runtime : this.#tracker;
		const databasePath =
			scope === "runtime" ? this.#paths.runtimePath : this.#paths.trackerPath;
		const approvedPlan = planFor(database, scope, "apply");
		if (expectedPlanHash && expectedPlanHash !== approvedPlan.planHash)
			throw new PersistenceMigrationError(
				"plan_mismatch",
				`${scope} migration plan no longer matches the approved dry-run`,
			);
		if (scope === "tracker" && this.#trackerBaseline === "unmanaged")
			configure(this.#tracker);
		const plan = planFor(database, scope, "apply");
		if (expectedPlanHash && expectedPlanHash !== plan.planHash)
			throw new PersistenceMigrationError(
				"plan_mismatch",
				`${scope} migration plan changed while preparing the source database`,
			);
		const result = applyPlan(database, databasePath, plan);
		if (scope === "tracker") this.#trackerBaseline = "managed";
		return result;
	}

	checkpointAndBackup(scope: DatabaseScope): string {
		return backupDatabase(
			scope === "runtime" ? this.#runtime : this.#tracker,
			scope === "runtime" ? this.#paths.runtimePath : this.#paths.trackerPath,
		);
	}

	recordRuntimeTransaction(
		input: RuntimeTransactionInput,
	): RuntimeTransactionResult {
		return this.#runtimeRepository.record(input);
	}

	claimRuntimeOutbox(
		workerId: string,
		limit: number,
		leaseMs?: number,
	): readonly ClaimedOutboxRecord[] {
		return this.#runtimeRepository.claim(workerId, limit, leaseMs);
	}

	replayRuntimeOutbox(): number {
		return this.#runtimeRepository.replay();
	}

	ackRuntimeOutbox(id: string, claimToken: string): boolean {
		return this.#runtimeRepository.ack(id, claimToken);
	}

	status(): PersistenceStatus {
		return Object.freeze({
			owner: {
				lockPath: this.#lockPath,
				ownerId: this.#ownerId,
				pid: process.pid,
			},
			runtime: health(this.#runtime),
			tracker: {
				...health(this.#tracker),
				baseline: this.#trackerBaseline,
			},
		});
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		try {
			this.#runtime.pragma("wal_checkpoint(PASSIVE)");
			if (this.#trackerBaseline === "managed")
				this.#tracker.pragma("wal_checkpoint(PASSIVE)");
			await Promise.all([
				this.#runtimeSql.destroy(),
				this.#trackerSql.destroy(),
			]);
		} finally {
			safeClose(this.#runtime);
			safeClose(this.#tracker);
			releaseOwnerLock(this.#lockPath);
		}
	}
}

/** Private owner construction; external callers receive only this narrow capability. */
export function openPersistenceForControlPlane(
	paths: PersistencePaths,
	ownerId = sha256(`${paths.runtimePath}:${process.pid}:${now()}`).slice(0, 24),
): PersistenceWriteCapability {
	return new PersistenceOwner(paths, ownerId);
}
