import fs from "node:fs";

import Database from "better-sqlite3";

import type { SqliteConnection } from "./internals.js";
import { currentVersion, numericPragma, textPragma } from "./schema.js";
import { type DatabaseHealth, PersistenceMigrationError } from "./types.js";

const fileSystem = fs as {
	rmSync(target: string, options: { force: true }): void;
};

function sqlString(value: string): string {
	return `'${value.replace(/'/gu, "''")}'`;
}

export function health(database: SqliteConnection): DatabaseHealth {
	return Object.freeze({
		foreignKeys: numericPragma(database, "foreign_keys") === 1,
		journalMode: textPragma(database, "journal_mode"),
		busyTimeoutMs: numericPragma(database, "busy_timeout"),
		synchronous: textPragma(database, "synchronous"),
		integrity: textPragma(database, "integrity_check"),
		foreignKeyViolations: database.prepare("PRAGMA foreign_key_check").all()
			.length,
		userVersion: currentVersion(database),
	});
}

export function verifyDatabase(target: string): DatabaseHealth {
	const verified = new Database(target, {
		readonly: true,
		fileMustExist: true,
	});
	try {
		const result = health(verified);
		if (result.integrity !== "ok" || result.foreignKeyViolations > 0) {
			throw new PersistenceMigrationError(
				"backup_failed",
				`database verification failed: integrity=${result.integrity} foreign_keys=${result.foreignKeyViolations}`,
			);
		}
		return result;
	} finally {
		verified.close();
	}
}

export function backupDatabase(
	database: SqliteConnection,
	databasePath: string,
): string {
	const backupPath = `${databasePath}.golem-backup-${Date.now()}.db`;
	try {
		database.pragma("wal_checkpoint(PASSIVE)");
		database.exec(`VACUUM INTO ${sqlString(backupPath)}`);
		verifyDatabase(backupPath);
		return backupPath;
	} catch (error) {
		if (error instanceof PersistenceMigrationError) throw error;
		throw new PersistenceMigrationError(
			"backup_failed",
			`backup failed before migration: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** A consistent SQLite clone without checkpointing or otherwise mutating source files. */
export function cloneDatabase(
	database: SqliteConnection,
	databasePath: string,
): string {
	const clonePath = `${databasePath}.golem-dry-run-${process.pid}-${Date.now()}.db`;
	database.exec(`VACUUM INTO ${sqlString(clonePath)}`);
	return clonePath;
}

export function removeClone(target: string): void {
	try {
		fileSystem.rmSync(target, { force: true });
		fileSystem.rmSync(`${target}.golem-backup-${Date.now()}.db`, {
			force: true,
		});
	} catch {
		// Dry-run cleanup must not hide an immutable-source result.
	}
}
