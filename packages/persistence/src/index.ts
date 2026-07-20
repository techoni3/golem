import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ContractBoundary } from "@golem/contracts";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

interface FsModule {
	existsSync(target: string): boolean;
	mkdirSync(target: string, options: { recursive: true }): void;
	openSync(target: string, flags: "wx", mode: number): number;
	writeFileSync(target: number, value: string): void;
	closeSync(target: number): void;
	readFileSync(target: string, encoding: "utf8"): string;
	unlinkSync(target: string): void;
}

interface PathModule {
	dirname(target: string): string;
	join(...parts: readonly string[]): string;
}

interface CryptoModule {
	createHash(name: "sha256"): {
		update(value: string): { digest(encoding: "hex"): string };
	};
}

const fsBoundary = fs as FsModule;
const pathBoundary = path as PathModule;
const cryptoBoundary = crypto as CryptoModule;

const busyTimeoutMs = 2_500;
const latestRuntimeVersion = 1;
const latestTrackerVersion = 1;

export type DatabaseScope = "runtime" | "tracker";
export type MigrationMode = "apply" | "dry-run";
export type RuntimeFailpoint = "before_commit" | "after_commit";

export interface PersistenceBoundary {
	readonly contract: ContractBoundary;
}

export interface PersistencePaths {
	readonly runtimePath: string;
	readonly trackerPath: string;
	readonly lockPath?: string;
}

export interface SqliteStatement<Row = Record<string, unknown>> {
	run(...parameters: readonly unknown[]): {
		readonly changes: number;
		readonly lastInsertRowid: number | bigint;
	};
	get(...parameters: readonly unknown[]): Row | undefined;
	all(...parameters: readonly unknown[]): readonly Row[];
}

export interface SqliteConnection {
	pragma(source: string, options?: { readonly simple?: boolean }): unknown;
	exec(source: string): unknown;
	prepare<Row = Record<string, unknown>>(source: string): SqliteStatement<Row>;
	transaction<Args extends readonly unknown[], Result>(
		fn: (...arguments_: Args) => Result,
	): (...arguments_: Args) => Result;
	close(): void;
}

export interface MigrationDefinition {
	readonly id: string;
	readonly checksum: string;
	readonly sql: string;
}

export interface MigrationPlan {
	readonly scope: DatabaseScope;
	readonly mode: MigrationMode;
	readonly currentVersion: number;
	readonly targetVersion: number;
	readonly migrations: readonly Pick<MigrationDefinition, "id" | "checksum">[];
	readonly pending: readonly Pick<MigrationDefinition, "id" | "checksum">[];
	readonly requiresBackup: boolean;
	readonly estimatedBackupBytes: number;
	readonly planHash: string;
}

export interface MigrationResult extends MigrationPlan {
	readonly backupPath?: string;
	readonly applied: readonly string[];
}

export interface DatabaseHealth {
	readonly foreignKeys: boolean;
	readonly journalMode: string;
	readonly busyTimeoutMs: number;
	readonly synchronous: string | number;
	readonly integrity: "ok" | string;
	readonly foreignKeyViolations: number;
	readonly userVersion: number;
}

export interface PersistenceStatus {
	readonly owner: {
		readonly lockPath: string;
		readonly ownerId: string;
		readonly pid: number;
	};
	readonly runtime: DatabaseHealth;
	readonly tracker: DatabaseHealth & {
		readonly baseline: "managed" | "unmanaged";
	};
}

export interface RuntimeCanonicalMutation {
	readonly project?: {
		readonly projectId: string;
		readonly name: string;
		readonly location: string;
	};
	readonly generation?: {
		readonly generationId: string;
		readonly sessionId: string;
		readonly projectId: string;
		readonly harness: string;
		readonly state: string;
	};
}

export interface RuntimeTransactionInput {
	readonly eventId: string;
	readonly deduplicationKey: string;
	readonly eventKind: string;
	readonly payload: Readonly<Record<string, unknown>>;
	readonly provenance: Readonly<Record<string, unknown>>;
	readonly occurredAt: string;
	readonly mutation: RuntimeCanonicalMutation;
	readonly outbox: {
		readonly destination: "tracker" | "management";
		readonly payload: Readonly<Record<string, unknown>>;
	};
	readonly failpoint?: RuntimeFailpoint;
}

export interface RuntimeTransactionResult {
	readonly disposition: "accepted" | "duplicate";
	readonly outboxId?: string;
}

export class PersistenceMigrationError extends Error {
	readonly code:
		| "checksum_drift"
		| "schema_too_new"
		| "migration_failed"
		| "backup_failed";

	constructor(code: PersistenceMigrationError["code"], message: string) {
		super(message);
		this.name = "PersistenceMigrationError";
		this.code = code;
	}
}

export class PersistenceOwnerConflictError extends Error {
	readonly diagnostic: Readonly<Record<string, unknown>>;

	constructor(diagnostic: Readonly<Record<string, unknown>>) {
		super("persistence owner already holds the runtime lock");
		this.name = "PersistenceOwnerConflictError";
		this.diagnostic = diagnostic;
	}
}

export class RuntimeFailpointError extends Error {
	readonly failpoint: RuntimeFailpoint;

	constructor(failpoint: RuntimeFailpoint) {
		super(`runtime failpoint reached: ${failpoint}`);
		this.name = "RuntimeFailpointError";
		this.failpoint = failpoint;
	}
}

interface RuntimeTables {
	readonly runtime_events: {
		readonly event_id: string;
		readonly deduplication_key: string;
		readonly event_kind: string;
		readonly payload_json: string;
		readonly provenance_json: string;
		readonly occurred_at: string;
	};
	readonly runtime_outbox: {
		readonly id: string;
		readonly destination: string;
		readonly payload_json: string;
		readonly status: string;
	};
}

interface TrackerTables {
	readonly golem_migrations: {
		readonly id: string;
		readonly checksum: string;
		readonly applied_at: string;
	};
}

type SqliteDatabase = ConstructorParameters<
	typeof SqliteDialect
>[0]["database"];

function sha256(value: string): string {
	return cryptoBoundary.createHash("sha256").update(value).digest("hex");
}

function migration(id: string, sql: string): MigrationDefinition {
	return Object.freeze({ id, checksum: sha256(sql), sql });
}

const runtimeMigrations: readonly MigrationDefinition[] = [
	migration(
		"runtime/001-initial",
		`
CREATE TABLE runtime_events (
  event_id TEXT PRIMARY KEY,
  deduplication_key TEXT NOT NULL UNIQUE,
  event_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE project_locations (
  location_id INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  location TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE(project_id, location)
);
CREATE TABLE logical_sessions (
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  created_at TEXT NOT NULL
);
CREATE TABLE session_generations (
  generation_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES logical_sessions(session_id),
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  harness TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE session_aliases (
  alias TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES logical_sessions(session_id),
  generation_id TEXT REFERENCES session_generations(generation_id),
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(alias, source)
);
CREATE TABLE endpoint_claims (
  endpoint_id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES session_generations(generation_id),
  owner_fence TEXT NOT NULL,
  owner_instance_id TEXT NOT NULL,
  readiness TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  expires_at TEXT,
  UNIQUE(endpoint_id, owner_fence)
);
CREATE TABLE endpoint_capabilities (
  endpoint_id TEXT NOT NULL REFERENCES endpoint_claims(endpoint_id),
  capability TEXT NOT NULL,
  qualified INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(endpoint_id, capability)
);
CREATE TABLE commands (
  command_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE delivery_envelopes (
  delivery_id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL REFERENCES commands(command_id),
  endpoint_id TEXT NOT NULL REFERENCES endpoint_claims(endpoint_id),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE delivery_acknowledgements (
  delivery_id TEXT NOT NULL REFERENCES delivery_envelopes(delivery_id),
  acknowledgement_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL,
  PRIMARY KEY(delivery_id, acknowledgement_id)
);
CREATE TABLE projection_cursors (
  projection TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE runtime_outbox (
  id TEXT PRIMARY KEY,
  destination TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT
);
CREATE TABLE diagnostics (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE migration_audit (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  backup_path TEXT,
  applied_at TEXT NOT NULL
);
CREATE INDEX runtime_events_received_at ON runtime_events(received_at);
CREATE INDEX runtime_outbox_pending ON runtime_outbox(status, created_at);
`,
	),
];

const trackerMigrations: readonly MigrationDefinition[] = [
	migration(
		"tracker/001-baseline",
		`
CREATE TABLE migration_audit (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  backup_path TEXT,
  applied_at TEXT NOT NULL
);
`,
	),
];

function migrationSet(scope: DatabaseScope): readonly MigrationDefinition[] {
	return scope === "runtime" ? runtimeMigrations : trackerMigrations;
}

function ensureParent(target: string): void {
	fsBoundary.mkdirSync(pathBoundary.dirname(target), { recursive: true });
}

function now(): string {
	return new Date().toISOString();
}

function json(value: Readonly<Record<string, unknown>>): string {
	return JSON.stringify(value);
}

function numericPragma(database: SqliteConnection, source: string): number {
	const result = database.pragma(source, { simple: true });
	const value = Array.isArray(result) ? result[0] : result;
	return typeof value === "number" ? value : Number(value);
}

function textPragma(database: SqliteConnection, source: string): string {
	const result = database.pragma(source, { simple: true });
	const value = Array.isArray(result) ? result[0] : result;
	return String(value).toLowerCase();
}

function configure(database: SqliteConnection): void {
	database.pragma("foreign_keys = ON");
	database.pragma("journal_mode = WAL");
	database.pragma(`busy_timeout = ${busyTimeoutMs}`);
	database.pragma("synchronous = FULL");
}

function currentVersion(database: SqliteConnection): number {
	return numericPragma(database, "user_version");
}

function hasTrackerTables(database: SqliteConnection): boolean {
	const result = database
		.prepare<{ readonly count: number }>(
			"SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT IN ('sqlite_sequence', 'golem_migrations', 'migration_audit')",
		)
		.get();
	return (result?.count ?? 0) > 0;
}

function ensureMigrationLedger(database: SqliteConnection): void {
	database.exec(`
CREATE TABLE IF NOT EXISTS golem_migrations (
  id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`);
}

function appliedMigrations(
	database: SqliteConnection,
): ReadonlyMap<string, string> {
	const ledger = new Map<string, string>();
	try {
		for (const row of database
			.prepare<{ readonly id: string; readonly checksum: string }>(
				"SELECT id, checksum FROM golem_migrations ORDER BY id",
			)
			.all()) {
			ledger.set(row.id, row.checksum);
		}
	} catch {
		// An un-managed legacy tracker database has no Golem ledger yet.
	}
	return ledger;
}

function assertMigrationState(
	database: SqliteConnection,
	scope: DatabaseScope,
): ReadonlyMap<string, string> {
	const expected = migrationSet(scope);
	const version = currentVersion(database);
	const target =
		scope === "runtime" ? latestRuntimeVersion : latestTrackerVersion;
	if (version > target) {
		throw new PersistenceMigrationError(
			"schema_too_new",
			`${scope} schema version ${version} is newer than supported version ${target}`,
		);
	}
	const applied = appliedMigrations(database);
	for (const entry of expected) {
		const stored = applied.get(entry.id);
		if (stored && stored !== entry.checksum) {
			throw new PersistenceMigrationError(
				"checksum_drift",
				`${scope} migration checksum drift: ${entry.id}`,
			);
		}
	}
	return applied;
}

function planFor(
	database: SqliteConnection,
	scope: DatabaseScope,
	mode: MigrationMode,
): MigrationPlan {
	const migrations = migrationSet(scope);
	const applied = assertMigrationState(database, scope);
	const pending = migrations.filter((entry) => !applied.has(entry.id));
	const current = currentVersion(database);
	const target =
		scope === "runtime" ? latestRuntimeVersion : latestTrackerVersion;
	const pageCount = numericPragma(database, "page_count");
	const pageSize = numericPragma(database, "page_size");
	const plan = {
		scope,
		mode,
		currentVersion: current,
		targetVersion: target,
		migrations: migrations.map(({ id, checksum }) => ({ id, checksum })),
		pending: pending.map(({ id, checksum }) => ({ id, checksum })),
		requiresBackup: pending.length > 0,
		estimatedBackupBytes: pageCount * pageSize,
	};
	return Object.freeze({
		...plan,
		planHash: sha256(JSON.stringify(plan)),
	});
}

function sqlString(value: string): string {
	return `'${value.replace(/'/gu, "''")}'`;
}

function verifyDatabase(target: string): void {
	const verified = new Database(target, {
		readonly: true,
		fileMustExist: true,
	});
	try {
		const integrity = textPragma(verified, "integrity_check");
		const violations = verified
			.prepare("PRAGMA foreign_key_check")
			.all().length;
		if (integrity !== "ok" || violations > 0) {
			throw new PersistenceMigrationError(
				"backup_failed",
				`backup verification failed: integrity=${integrity} foreign_keys=${violations}`,
			);
		}
	} finally {
		verified.close();
	}
}

function backupDatabase(
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

function applyPlan(
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

function processIsGone(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ESRCH"
		);
	}
}

function acquireLock(lockPath: string, ownerId: string): void {
	ensureParent(lockPath);
	const metadata = { owner_id: ownerId, pid: process.pid, acquired_at: now() };
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const descriptor = fsBoundary.openSync(lockPath, "wx", 0o600);
			try {
				fsBoundary.writeFileSync(descriptor, `${JSON.stringify(metadata)}\n`);
			} finally {
				fsBoundary.closeSync(descriptor);
			}
			return;
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? error.code
					: undefined;
			if (code !== "EEXIST") throw error;
			let existing: Record<string, unknown> = { status: "unreadable" };
			try {
				existing = JSON.parse(
					fsBoundary.readFileSync(lockPath, "utf8"),
				) as Record<string, unknown>;
			} catch {
				// Preserve a malformed live lock rather than guessing ownership.
			}
			if (
				attempt === 0 &&
				typeof existing.pid === "number" &&
				processIsGone(existing.pid)
			) {
				fsBoundary.unlinkSync(lockPath);
				continue;
			}
			throw new PersistenceOwnerConflictError(existing);
		}
	}
}

function safeClose(database: SqliteConnection): void {
	try {
		database.close();
	} catch {
		// Closing an already-destroyed Kysely connection is safe cleanup.
	}
}

export class PersistenceOwner {
	readonly runtimeSql: Kysely<RuntimeTables>;
	readonly trackerSql: Kysely<TrackerTables>;
	readonly runtime!: SqliteConnection;
	readonly tracker!: SqliteConnection;
	readonly paths: Readonly<PersistencePaths>;
	readonly ownerId: string;
	readonly lockPath: string;
	#closed = false;
	#trackerBaseline: "managed" | "unmanaged";

	constructor(paths: PersistencePaths, ownerId: string) {
		this.paths = Object.freeze({ ...paths });
		this.ownerId = ownerId;
		this.lockPath = paths.lockPath ?? `${paths.runtimePath}.owner.lock`;
		acquireLock(this.lockPath, ownerId);
		try {
			ensureParent(paths.runtimePath);
			ensureParent(paths.trackerPath);
			this.runtime = new Database(paths.runtimePath);
			this.tracker = new Database(paths.trackerPath);
			configure(this.runtime);
			configure(this.tracker);
			this.runtimeSql = new Kysely<RuntimeTables>({
				dialect: new SqliteDialect({
					database: this.runtime as unknown as SqliteDatabase,
				}),
			});
			this.trackerSql = new Kysely<TrackerTables>({
				dialect: new SqliteDialect({
					database: this.tracker as unknown as SqliteDatabase,
				}),
			});
			const runtimePlan = planFor(this.runtime, "runtime", "apply");
			applyPlan(this.runtime, paths.runtimePath, runtimePlan);
			this.#trackerBaseline = hasTrackerTables(this.tracker)
				? "unmanaged"
				: "managed";
			if (this.#trackerBaseline === "managed") {
				const trackerPlan = planFor(this.tracker, "tracker", "apply");
				applyPlan(this.tracker, paths.trackerPath, trackerPlan);
			}
		} catch (error) {
			safeClose(this.runtime as SqliteConnection);
			safeClose(this.tracker as SqliteConnection);
			try {
				fsBoundary.unlinkSync(this.lockPath);
			} catch {
				// The lock may not have been acquired.
			}
			throw error;
		}
	}

	plan(scope: DatabaseScope, mode: MigrationMode = "dry-run"): MigrationPlan {
		return planFor(
			scope === "runtime" ? this.runtime : this.tracker,
			scope,
			mode,
		);
	}

	apply(scope: DatabaseScope): MigrationResult {
		const database = scope === "runtime" ? this.runtime : this.tracker;
		const databasePath =
			scope === "runtime" ? this.paths.runtimePath : this.paths.trackerPath;
		const result = applyPlan(database, databasePath, this.plan(scope, "apply"));
		if (scope === "tracker") this.#trackerBaseline = "managed";
		return result;
	}

	checkpointAndBackup(scope: DatabaseScope): string {
		const database = scope === "runtime" ? this.runtime : this.tracker;
		const databasePath =
			scope === "runtime" ? this.paths.runtimePath : this.paths.trackerPath;
		return backupDatabase(database, databasePath);
	}

	recordRuntimeTransaction(
		input: RuntimeTransactionInput,
	): RuntimeTransactionResult {
		const transaction = this.runtime.transaction(() => {
			const inserted = this.runtime
				.prepare(
					"INSERT OR IGNORE INTO runtime_events(event_id, deduplication_key, event_kind, payload_json, provenance_json, occurred_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
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
				this.runtime
					.prepare(
						"INSERT OR IGNORE INTO projects(project_id, name, created_at) VALUES (?, ?, ?)",
					)
					.run(project.projectId, project.name, now());
				this.runtime
					.prepare(
						"INSERT OR IGNORE INTO project_locations(project_id, location, observed_at) VALUES (?, ?, ?)",
					)
					.run(project.projectId, project.location, now());
			}
			if (input.mutation.generation) {
				const generation = input.mutation.generation;
				this.runtime
					.prepare(
						"INSERT OR IGNORE INTO logical_sessions(session_id, project_id, created_at) VALUES (?, ?, ?)",
					)
					.run(generation.sessionId, generation.projectId, now());
				this.runtime
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
			this.runtime
				.prepare(
					"INSERT INTO runtime_outbox(id, destination, payload_json, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
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

	status(): PersistenceStatus {
		return Object.freeze({
			owner: {
				lockPath: this.lockPath,
				ownerId: this.ownerId,
				pid: process.pid,
			},
			runtime: health(this.runtime),
			tracker: { ...health(this.tracker), baseline: this.#trackerBaseline },
		});
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		try {
			this.runtime.pragma("wal_checkpoint(PASSIVE)");
			this.tracker.pragma("wal_checkpoint(PASSIVE)");
			await Promise.all([this.runtimeSql.destroy(), this.trackerSql.destroy()]);
		} finally {
			safeClose(this.runtime);
			safeClose(this.tracker);
			try {
				fsBoundary.unlinkSync(this.lockPath);
			} catch {
				// A crash-recovery owner may already have removed a stale lock.
			}
		}
	}
}

function health(database: SqliteConnection): DatabaseHealth {
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

/** The only writable repository composition entry point for later control-plane wiring. */
export function openPersistenceForControlPlane(
	paths: PersistencePaths,
	ownerId = sha256(`${paths.runtimePath}:${process.pid}:${now()}`).slice(0, 24),
): PersistenceOwner {
	return new PersistenceOwner(paths, ownerId);
}

export const persistenceCompositionPort = Object.freeze({
	open: openPersistenceForControlPlane,
});

export const persistenceMigrations = Object.freeze({
	runtime: runtimeMigrations.map(({ id, checksum }) => ({ id, checksum })),
	tracker: trackerMigrations.map(({ id, checksum }) => ({ id, checksum })),
});
