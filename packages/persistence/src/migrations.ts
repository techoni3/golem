import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import {
	backupDatabase,
	cloneDatabase,
	health,
	verifyDatabase,
} from "./backup-health.js";
import type { SqliteConnection } from "./internals.js";
import {
	configure,
	currentVersion,
	latestVersion,
	migrationSet,
	now,
	numericPragma,
	sha256,
	tableExists,
} from "./schema.js";
import {
	type DatabaseScope,
	type MigrationMode,
	type MigrationPlan,
	type MigrationResult,
	PersistenceMigrationError,
} from "./types.js";

const fileSystem = fs as {
	readdirSync(target: string): readonly string[];
	rmSync(target: string, options: { force: true }): void;
};
const pathBoundary = path as {
	basename(target: string): string;
	dirname(target: string): string;
	join(...parts: readonly string[]): string;
};

function ensureMigrationLedger(database: SqliteConnection): void {
	database.exec(`
CREATE TABLE IF NOT EXISTS golem_migrations (
  id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`);
}

function appliedMigrations(database: SqliteConnection): {
	readonly exists: boolean;
	readonly rows: ReadonlyMap<string, string>;
} {
	if (!tableExists(database, "golem_migrations"))
		return Object.freeze({ exists: false, rows: new Map() });
	const rows = new Map<string, string>();
	try {
		for (const row of database
			.prepare<{ readonly id: unknown; readonly checksum: unknown }>(
				"SELECT id, checksum FROM golem_migrations ORDER BY id",
			)
			.all()) {
			if (
				typeof row.id !== "string" ||
				!row.id ||
				typeof row.checksum !== "string" ||
				!row.checksum ||
				rows.has(row.id)
			) {
				throw new PersistenceMigrationError(
					"migration_ledger_invalid",
					"migration ledger contains a malformed row",
				);
			}
			rows.set(row.id, row.checksum);
		}
	} catch (error) {
		if (error instanceof PersistenceMigrationError) throw error;
		throw new PersistenceMigrationError(
			"migration_ledger_invalid",
			`migration ledger is unreadable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return Object.freeze({ exists: true, rows });
}

function assertMigrationState(
	database: SqliteConnection,
	scope: DatabaseScope,
): ReadonlyMap<string, string> {
	const expected = migrationSet(scope);
	const ledger = appliedMigrations(database);
	const version = currentVersion(database);
	if (version > latestVersion(scope)) {
		throw new PersistenceMigrationError(
			"schema_too_new",
			`${scope} schema version ${version} is newer than supported version ${latestVersion(scope)}`,
		);
	}
	const known = new Set(expected.map((entry) => entry.id));
	for (const id of ledger.rows.keys()) {
		if (!known.has(id)) {
			throw new PersistenceMigrationError(
				"schema_too_new",
				`${scope} migration ledger contains an unknown migration: ${id}`,
			);
		}
	}
	for (const entry of expected) {
		const stored = ledger.rows.get(entry.id);
		if (stored && stored !== entry.checksum) {
			throw new PersistenceMigrationError(
				"checksum_drift",
				`${scope} migration checksum drift: ${entry.id}`,
			);
		}
	}
	return ledger.rows;
}

export function planFor(
	database: SqliteConnection,
	scope: DatabaseScope,
	mode: MigrationMode,
): MigrationPlan {
	const migrations = migrationSet(scope);
	const applied = assertMigrationState(database, scope);
	const pending = migrations.filter((entry) => !applied.has(entry.id));
	const plan = {
		scope,
		mode,
		currentVersion: currentVersion(database),
		targetVersion: latestVersion(scope),
		migrations: migrations.map(({ id, checksum }) => ({ id, checksum })),
		pending: pending.map(({ id, checksum }) => ({ id, checksum })),
		requiresBackup: pending.length > 0,
		estimatedBackupBytes:
			numericPragma(database, "page_count") *
			numericPragma(database, "page_size"),
	};
	const stablePlan = {
		scope: plan.scope,
		currentVersion: plan.currentVersion,
		targetVersion: plan.targetVersion,
		migrations: plan.migrations,
		pending: plan.pending,
		requiresBackup: plan.requiresBackup,
		estimatedBackupBytes: plan.estimatedBackupBytes,
	};
	return Object.freeze({
		...plan,
		planHash: sha256(JSON.stringify(stablePlan)),
	});
}

function migrationAlreadyProvidesBaseline(
	database: SqliteConnection,
	scope: DatabaseScope,
	id: string,
): boolean {
	return (
		scope === "tracker" &&
		id === "tracker/001-baseline" &&
		tableExists(database, "migration_audit")
	);
}

export function applyPlan(
	database: SqliteConnection,
	databasePath: string,
	plan: MigrationPlan,
): MigrationResult {
	if (plan.pending.length === 0) return Object.freeze({ ...plan, applied: [] });
	const backupPath = backupDatabase(database, databasePath);
	const definitions = migrationSet(plan.scope).filter((entry) =>
		plan.pending.some((pending) => pending.id === entry.id),
	);
	try {
		database.transaction(() => {
			ensureMigrationLedger(database);
			for (const definition of definitions) {
				if (
					!migrationAlreadyProvidesBaseline(database, plan.scope, definition.id)
				)
					database.exec(definition.sql);
				database
					.prepare(
						"INSERT INTO golem_migrations(id, checksum, applied_at) VALUES (?, ?, ?)",
					)
					.run(definition.id, definition.checksum, now());
			}
			database.pragma(`user_version = ${plan.targetVersion}`);
			const auditId = sha256(`${plan.scope}:${plan.planHash}:${now()}`).slice(
				0,
				32,
			);
			if (tableExists(database, "migration_audit"))
				database
					.prepare(
						"INSERT INTO migration_audit(id, scope, plan_hash, backup_path, applied_at) VALUES (?, ?, ?, ?, ?)",
					)
					.run(auditId, plan.scope, plan.planHash, backupPath, now());
		})();
	} catch (error) {
		throw new PersistenceMigrationError(
			"migration_failed",
			`${plan.scope} migration failed; source rolled back: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	verifyDatabase(databasePath);
	return Object.freeze({
		...plan,
		backupPath,
		applied: definitions.map((definition) => definition.id),
	});
}

export function dryRunPlan(
	database: SqliteConnection,
	databasePath: string,
	scope: DatabaseScope,
): MigrationPlan {
	const plan = planFor(database, scope, "dry-run");
	const clonePath = cloneDatabase(database, databasePath);
	let clone: SqliteConnection | undefined;
	try {
		clone = new Database(clonePath);
		configure(clone);
		const clonedPlan = planFor(clone, scope, "apply");
		const result = applyPlan(clone, clonePath, clonedPlan);
		const checked = health(clone);
		if (checked.integrity !== "ok" || checked.foreignKeyViolations !== 0)
			throw new PersistenceMigrationError(
				"migration_failed",
				`dry-run clone failed integrity=${checked.integrity} foreign_keys=${checked.foreignKeyViolations}`,
			);
		return Object.freeze({
			...plan,
			dryRun: {
				integrity: checked.integrity,
				foreignKeyViolations: checked.foreignKeyViolations,
				applied: result.applied,
			},
		});
	} finally {
		try {
			clone?.close();
		} catch {
			// cleanup only
		}
		try {
			fileSystem.rmSync(clonePath, { force: true });
			const cloneName = pathBoundary.basename(clonePath);
			for (const entry of fileSystem.readdirSync(
				pathBoundary.dirname(clonePath),
			)) {
				if (entry.startsWith(`${cloneName}.golem-backup-`))
					fileSystem.rmSync(
						pathBoundary.join(pathBoundary.dirname(clonePath), entry),
						{ force: true },
					);
			}
		} catch {
			// cleanup only
		}
	}
}
