import crypto from "node:crypto";

import type { SqliteConnection } from "./internals.js";
import type { DatabaseScope, MigrationDefinition } from "./types.js";

export const busyTimeoutMs = 2_500;
export const latestRuntimeVersion = 1;
export const latestTrackerVersion = 2;

function migrationChecksum(value: string): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}

function migration(id: string, sql: string): MigrationDefinition {
	return Object.freeze({ id, checksum: migrationChecksum(sql), sql });
}

/**
 * This branch has not shipped. Keep the first runtime migration canonical rather
 * than preserving a checksum for a rejected relational model.
 */
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
  source_observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  materialized_at TEXT NOT NULL,
  activity_at TEXT,
  metadata_version TEXT NOT NULL DEFAULT 'golem.event/v1',
  disposition TEXT NOT NULL DEFAULT 'accepted' CHECK(disposition IN ('accepted', 'duplicate', 'stale', 'illegal', 'quarantined'))
);
CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE project_locations (
  location_id TEXT PRIMARY KEY CHECK(length(location_id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  canonical_path TEXT NOT NULL,
  observed_path TEXT,
  relation TEXT NOT NULL CHECK(relation IN ('main', 'worktree', 'registered', 'legacy')),
  source_observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, canonical_path),
  UNIQUE(project_id, location_id)
);
CREATE TABLE location_aliases (
  project_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  alias_path TEXT NOT NULL,
  alias_kind TEXT NOT NULL CHECK(alias_kind IN ('path', 'symlink', 'worktree', 'legacy')),
  observed_at TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  PRIMARY KEY(project_id, alias_path, alias_kind),
  FOREIGN KEY(project_id, location_id) REFERENCES project_locations(project_id, location_id)
);
CREATE TABLE location_relations (
  project_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  related_location_id TEXT NOT NULL,
  relation_kind TEXT NOT NULL CHECK(relation_kind IN ('same_project', 'worktree_of', 'relocated_from', 'legacy_source')),
  observed_at TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  PRIMARY KEY(project_id, location_id, related_location_id, relation_kind),
  CHECK(location_id <> related_location_id),
  FOREIGN KEY(project_id, location_id) REFERENCES project_locations(project_id, location_id),
  FOREIGN KEY(project_id, related_location_id) REFERENCES project_locations(project_id, location_id)
);
CREATE TABLE logical_sessions (
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, session_id)
);
CREATE TABLE session_generations (
  generation_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal > 0),
  harness TEXT NOT NULL CHECK(harness IN ('claude', 'codex', 'opencode', 'pi')),
  lifecycle_state TEXT NOT NULL CHECK(lifecycle_state IN ('starting', 'idle', 'active', 'waiting', 'ending', 'ended', 'errored', 'superseded')),
  lifecycle_schema_version TEXT NOT NULL CHECK(lifecycle_schema_version = 'golem.lifecycle/v1'),
  lifecycle_provenance_json TEXT NOT NULL,
  field_schema_version TEXT NOT NULL CHECK(field_schema_version = 'golem.fields/v1'),
  field_provenance_json TEXT NOT NULL,
  source_observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  activity_at TEXT,
  materialized_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE(session_id, ordinal),
  UNIQUE(project_id, generation_id),
  UNIQUE(project_id, session_id, generation_id),
  FOREIGN KEY(project_id, session_id) REFERENCES logical_sessions(project_id, session_id),
  CHECK((lifecycle_state IN ('ended', 'errored', 'superseded') AND ended_at IS NOT NULL) OR (lifecycle_state NOT IN ('ended', 'errored', 'superseded') AND ended_at IS NULL))
);
CREATE TABLE session_aliases (
  project_id TEXT NOT NULL,
  harness TEXT NOT NULL CHECK(harness IN ('claude', 'codex', 'opencode', 'pi')),
  alias_kind TEXT NOT NULL CHECK(alias_kind IN ('native_conversation', 'native_run', 'legacy_canonical_id', 'supervisor_thread', 'bridge_session', 'migration_relation')),
  producer_id TEXT CHECK(producer_id IS NULL OR length(producer_id) > 0),
  alias TEXT NOT NULL CHECK(length(alias) > 0),
  session_id TEXT,
  generation_id TEXT,
  source TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id, session_id) REFERENCES logical_sessions(project_id, session_id),
  FOREIGN KEY(project_id, session_id, generation_id) REFERENCES session_generations(project_id, session_id, generation_id),
  CHECK(generation_id IS NULL OR session_id IS NOT NULL)
);
CREATE UNIQUE INDEX session_aliases_scoped_identity ON session_aliases(project_id, harness, alias_kind, COALESCE(producer_id, ''), alias);
CREATE TABLE producer_watermarks (
  producer_id TEXT PRIMARY KEY,
  watermark TEXT NOT NULL,
  source_observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  materialized_at TEXT NOT NULL,
  provenance_json TEXT NOT NULL
);
CREATE TABLE metadata_versions (
  metadata_key TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition IN ('accepted', 'stale', 'superseded', 'rejected')),
  source_observed_at TEXT NOT NULL,
  materialized_at TEXT NOT NULL,
  provenance_json TEXT NOT NULL
);
CREATE TABLE endpoint_claims (
  endpoint_id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES session_generations(generation_id),
  route_kind TEXT NOT NULL CHECK(route_kind IN ('control', 'delivery', 'observation')),
  revision INTEGER NOT NULL CHECK(revision >= 0),
  state TEXT NOT NULL CHECK(state IN ('claiming', 'healthy', 'degraded', 'released', 'expired', 'superseded')),
  owner_fence INTEGER NOT NULL CHECK(owner_fence > 0),
  owner_instance_id TEXT NOT NULL CHECK(length(owner_instance_id) > 0),
  delivery_mode TEXT NOT NULL CHECK(delivery_mode IN ('pull', 'native_channel', 'prompt_bridge', 'managed_app_server', 'next_turn')),
  readiness_state TEXT NOT NULL CHECK(readiness_state IN ('ready', 'held_busy', 'held_waiting', 'pull_only', 'next_turn', 'unsupported', 'unhealthy', 'uninitialized')),
  control_state TEXT NOT NULL CHECK(control_state IN ('enabled', 'held', 'disabled')),
  claimed_at TEXT NOT NULL,
  heartbeat_at TEXT,
  expires_at TEXT,
  superseded_at TEXT,
  CHECK((state = 'superseded' AND superseded_at IS NOT NULL) OR (state <> 'superseded'))
);
CREATE UNIQUE INDEX endpoint_claims_one_live_route ON endpoint_claims(generation_id, route_kind) WHERE state IN ('claiming', 'healthy', 'degraded');
CREATE UNIQUE INDEX endpoint_claims_fence ON endpoint_claims(generation_id, route_kind, owner_fence);
CREATE TABLE endpoint_fences (
  generation_id TEXT NOT NULL REFERENCES session_generations(generation_id),
  route_kind TEXT NOT NULL CHECK(route_kind IN ('control', 'delivery', 'observation')),
  fence INTEGER NOT NULL CHECK(fence > 0),
  allocated_at TEXT NOT NULL,
  owner_instance_id TEXT NOT NULL,
  PRIMARY KEY(generation_id, route_kind, fence)
);
CREATE TABLE capability_observations (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES endpoint_claims(endpoint_id),
  capability TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  qualification_state TEXT NOT NULL CHECK(qualification_state IN ('supported', 'experimental', 'unsupported', 'unknown')),
  delivery_mode TEXT NOT NULL CHECK(delivery_mode IN ('pull', 'native_channel', 'prompt_bridge', 'managed_app_server', 'next_turn')),
  readiness_state TEXT NOT NULL CHECK(readiness_state IN ('ready', 'held_busy', 'held_waiting', 'pull_only', 'next_turn', 'unsupported', 'unhealthy', 'uninitialized')),
  evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('probe', 'configured', 'observed', 'operator')),
  evidence_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  expires_at TEXT,
  UNIQUE(endpoint_id, capability, evidence_kind, observed_at)
);
CREATE TABLE commands (
  command_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('accepted', 'rejected', 'executing', 'succeeded', 'failed', 'cancelled')),
  created_at TEXT NOT NULL
);
CREATE TABLE delivery_envelopes (
  delivery_id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL REFERENCES commands(command_id),
  endpoint_id TEXT NOT NULL REFERENCES endpoint_claims(endpoint_id),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'delivered', 'acknowledged', 'failed', 'cancelled', 'expired')),
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
  sequence INTEGER NOT NULL CHECK(sequence >= 0),
  updated_at TEXT NOT NULL
);
CREATE TABLE runtime_outbox (
  id TEXT PRIMARY KEY,
  destination TEXT NOT NULL CHECK(destination IN ('tracker', 'management')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'published', 'permanent_failure')),
  created_at TEXT NOT NULL,
  published_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0 AND attempts <= 5),
  claim_owner TEXT,
  claim_token TEXT,
  claim_until TEXT,
  retry_started_at TEXT,
  next_attempt_at TEXT,
  last_error TEXT,
  permanent_failure_at TEXT,
  CHECK((status = 'claimed' AND claim_owner IS NOT NULL AND claim_token IS NOT NULL AND claim_until IS NOT NULL) OR status <> 'claimed'),
  CHECK((status = 'permanent_failure' AND permanent_failure_at IS NOT NULL) OR status <> 'permanent_failure')
);
CREATE TABLE diagnostics (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE migration_audit (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('runtime', 'tracker')),
  plan_hash TEXT NOT NULL,
  backup_path TEXT,
  applied_at TEXT NOT NULL
);
CREATE TABLE migration_runs (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('runtime', 'tracker')),
  plan_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('planned', 'dry_run', 'applying', 'applied', 'failed', 'rolled_back')),
  backup_path TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE migration_findings (
  id TEXT PRIMARY KEY,
  migration_run_id TEXT NOT NULL REFERENCES migration_runs(id),
  code TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE migration_decisions (
  id TEXT PRIMARY KEY,
  migration_run_id TEXT NOT NULL REFERENCES migration_runs(id),
  finding_id TEXT REFERENCES migration_findings(id),
  decision TEXT NOT NULL CHECK(decision IN ('approved', 'rejected', 'deferred', 'applied', 'rolled_back')),
  decided_at TEXT NOT NULL
);
CREATE TABLE legacy_snapshots (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  source_checksum TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  UNIQUE(source_kind, source_checksum)
);
CREATE VIEW live_sessions AS
  SELECT generation_id, session_id, project_id, harness, lifecycle_state, ordinal, activity_at
  FROM session_generations
  WHERE lifecycle_state NOT IN ('ended', 'errored', 'superseded');
CREATE VIEW session_history AS
  SELECT generation_id, session_id, project_id, harness, lifecycle_state, ordinal, source_observed_at, activity_at, materialized_at, ended_at
  FROM session_generations;
CREATE VIEW runtime_diagnostics AS SELECT id, code, details_json, created_at FROM diagnostics;
CREATE INDEX runtime_events_received_at ON runtime_events(received_at);
CREATE INDEX runtime_outbox_claimable ON runtime_outbox(status, next_attempt_at, created_at);
CREATE INDEX capability_observations_endpoint ON capability_observations(endpoint_id, capability, observed_at);
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
	migration(
		"tracker/002-durable-delivery-bus",
		`
CREATE TABLE tracker_envelopes (
  id TEXT PRIMARY KEY CHECK(length(id) > 0),
  root_id TEXT NOT NULL REFERENCES tracker_envelopes(id),
  parent_id TEXT REFERENCES tracker_envelopes(id),
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) > 0),
  fingerprint TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  reply_to_recipient_id TEXT,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  endpoint_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'delivered', 'acknowledged', 'retrying', 'dead_letter', 'expired', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK(max_attempts BETWEEN 1 AND 20),
  deadline_at TEXT,
  next_attempt_at TEXT,
  claim_owner TEXT,
  claim_token TEXT,
  claim_until TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  acknowledged_at TEXT,
  last_error TEXT,
  CHECK((status = 'claimed' AND claim_owner IS NOT NULL AND claim_token IS NOT NULL AND claim_until IS NOT NULL) OR status <> 'claimed')
);
CREATE INDEX tracker_envelopes_claimable ON tracker_envelopes(status, next_attempt_at, created_at);
CREATE INDEX tracker_envelopes_recipient ON tracker_envelopes(recipient_id, status);
CREATE TABLE tracker_envelope_acknowledgements (
  envelope_id TEXT NOT NULL REFERENCES tracker_envelopes(id) ON DELETE CASCADE,
  acknowledgement_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL,
  PRIMARY KEY(envelope_id, acknowledgement_id)
);
CREATE TABLE tracker_bus_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  deduplication_key TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL,
  topic TEXT NOT NULL,
  class TEXT NOT NULL CHECK(class IN ('tracker', 'lifecycle', 'custom')),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX tracker_bus_events_topic_sequence ON tracker_bus_events(topic, sequence);
CREATE TABLE tracker_subscriptions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  classes_json TEXT NOT NULL,
  cursor_sequence INTEGER NOT NULL DEFAULT 0 CHECK(cursor_sequence >= 0),
  manual INTEGER NOT NULL CHECK(manual IN (0, 1)),
  status TEXT NOT NULL CHECK(status IN ('active', 'offline', 'suspended')),
  created_at TEXT NOT NULL,
  UNIQUE(recipient_id, name)
);
CREATE INDEX tracker_subscriptions_topic_cursor ON tracker_subscriptions(topic, cursor_sequence, status);
CREATE TABLE tracker_passive_slots (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  category TEXT NOT NULL,
  baseline_json TEXT NOT NULL,
  value_json TEXT NOT NULL,
  event_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(recipient_id, ticket_id, category)
);
CREATE INDEX tracker_passive_slots_recipient ON tracker_passive_slots(recipient_id, sequence);
CREATE TABLE tracker_passive_cursors (
  recipient_id TEXT PRIMARY KEY,
  cursor_sequence INTEGER NOT NULL DEFAULT 0 CHECK(cursor_sequence >= 0),
  pending_json TEXT,
  pending_to_sequence INTEGER,
  lease_id TEXT,
  lease_until TEXT,
  updated_at TEXT NOT NULL,
  CHECK((pending_json IS NULL AND pending_to_sequence IS NULL) OR (pending_json IS NOT NULL AND pending_to_sequence IS NOT NULL)),
  CHECK((lease_id IS NULL AND lease_until IS NULL) OR (lease_id IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE TABLE tracker_delivery_audit (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX tracker_delivery_audit_subject ON tracker_delivery_audit(subject_id, created_at);
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

/** Legacy tracker data has tables but no checked Golem ledger; do not mutate it on open. */
export function hasManagedTrackerSchema(database: SqliteConnection): boolean {
	return (
		tableExists(database, "golem_migrations") &&
		tableExists(database, "tracker_envelopes") &&
		tableExists(database, "tracker_bus_events")
	);
}

export function sha256(value: string): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}
