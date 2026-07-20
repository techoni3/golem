import crypto from "node:crypto";
import type { SqliteConnection } from "./internals.js";
import type { DatabaseScope, MigrationDefinition } from "./types.js";

export const busyTimeoutMs = 2_500;
export const latestRuntimeVersion = 2;
export const latestTrackerVersion = 1;

function migrationChecksum(value: string): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}

function migration(id: string, sql: string): MigrationDefinition {
	return Object.freeze({ id, checksum: migrationChecksum(sql), sql });
}

export const runtimeMigrations: readonly MigrationDefinition[] = [
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
	migration(
		"runtime/002-watermarks-metadata-outbox-audit",
		`
ALTER TABLE runtime_events ADD COLUMN metadata_version TEXT NOT NULL DEFAULT 'golem.event/v1';
ALTER TABLE runtime_events ADD COLUMN disposition TEXT NOT NULL DEFAULT 'accepted';
ALTER TABLE runtime_outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runtime_outbox ADD COLUMN claim_owner TEXT;
ALTER TABLE runtime_outbox ADD COLUMN claim_token TEXT;
ALTER TABLE runtime_outbox ADD COLUMN claim_until TEXT;
ALTER TABLE runtime_outbox ADD COLUMN last_error TEXT;
CREATE TABLE producer_watermarks (producer_id TEXT PRIMARY KEY, watermark TEXT NOT NULL, metadata_version TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE metadata_versions (metadata_key TEXT PRIMARY KEY, version TEXT NOT NULL, disposition TEXT NOT NULL, recorded_at TEXT NOT NULL);
CREATE TABLE endpoint_fences (generation_id TEXT NOT NULL REFERENCES session_generations(generation_id), route_kind TEXT NOT NULL, fence INTEGER NOT NULL, allocated_at TEXT NOT NULL, PRIMARY KEY(generation_id, route_kind), UNIQUE(generation_id, route_kind, fence));
CREATE TABLE capability_observations (id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL REFERENCES endpoint_claims(endpoint_id), capability TEXT NOT NULL, qualified INTEGER NOT NULL, details_json TEXT NOT NULL, observed_at TEXT NOT NULL);
CREATE TABLE migration_runs (id TEXT PRIMARY KEY, scope TEXT NOT NULL, plan_hash TEXT NOT NULL, status TEXT NOT NULL, backup_path TEXT, started_at TEXT NOT NULL, completed_at TEXT);
CREATE TABLE migration_findings (id TEXT PRIMARY KEY, migration_run_id TEXT NOT NULL REFERENCES migration_runs(id), code TEXT NOT NULL, details_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE migration_decisions (id TEXT PRIMARY KEY, migration_run_id TEXT NOT NULL REFERENCES migration_runs(id), finding_id TEXT REFERENCES migration_findings(id), decision TEXT NOT NULL, decided_at TEXT NOT NULL);
CREATE TABLE legacy_snapshots (id TEXT PRIMARY KEY, source_kind TEXT NOT NULL, source_checksum TEXT NOT NULL, payload_json TEXT NOT NULL, captured_at TEXT NOT NULL, UNIQUE(source_kind, source_checksum));
CREATE VIEW live_sessions AS SELECT generation_id, session_id, project_id, harness, lifecycle_state FROM session_generations WHERE lifecycle_state NOT IN ('completed', 'failed', 'cancelled');
CREATE VIEW session_history AS SELECT generation_id, session_id, project_id, harness, lifecycle_state, created_at FROM session_generations;
CREATE VIEW runtime_diagnostics AS SELECT id, code, details_json, created_at FROM diagnostics;
CREATE INDEX runtime_outbox_claimable ON runtime_outbox(status, claim_until, created_at);
CREATE INDEX runtime_events_disposition ON runtime_events(disposition, received_at);
`,
	),
];

export const trackerMigrations: readonly MigrationDefinition[] = [
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

export function migrationSet(
	scope: DatabaseScope,
): readonly MigrationDefinition[] {
	return scope === "runtime" ? runtimeMigrations : trackerMigrations;
}

export function latestVersion(scope: DatabaseScope): number {
	return scope === "runtime" ? latestRuntimeVersion : latestTrackerVersion;
}

export function numericPragma(
	database: SqliteConnection,
	source: string,
): number {
	const result = database.pragma(source, { simple: true });
	const value = Array.isArray(result) ? result[0] : result;
	return typeof value === "number" ? value : Number(value);
}

export function textPragma(database: SqliteConnection, source: string): string {
	const result = database.pragma(source, { simple: true });
	const value = Array.isArray(result) ? result[0] : result;
	return String(value).toLowerCase();
}

export function configure(database: SqliteConnection): void {
	database.pragma("foreign_keys = ON");
	database.pragma("journal_mode = WAL");
	database.pragma(`busy_timeout = ${busyTimeoutMs}`);
	database.pragma("synchronous = FULL");
}

export function currentVersion(database: SqliteConnection): number {
	return numericPragma(database, "user_version");
}

export function tableExists(database: SqliteConnection, name: string): boolean {
	return Boolean(
		database
			.prepare<{ readonly name: string }>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
			)
			.get(name),
	);
}

export function hasTrackerTables(database: SqliteConnection): boolean {
	const result = database
		.prepare<{ readonly count: number }>(
			"SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT IN ('sqlite_sequence', 'golem_migrations', 'migration_audit')",
		)
		.get();
	return (result?.count ?? 0) > 0;
}

export function sha256(value: string): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}

export function now(): string {
	return new Date().toISOString();
}
