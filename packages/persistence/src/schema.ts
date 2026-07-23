import crypto from "node:crypto";

import type { SqliteConnection } from "./internals.js";
import type { DatabaseScope, MigrationDefinition } from "./types.js";

export const busyTimeoutMs = 2_500;
export const latestRuntimeVersion = 1;
export const latestTrackerVersion = 8;

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
CREATE UNIQUE INDEX project_locations_canonical_path_unique
  ON project_locations(canonical_path);
CREATE TABLE project_metadata (
  project_id TEXT PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
  name_source TEXT NOT NULL CHECK(name_source IN ('git', 'marker', 'register', 'legacy_import', 'hook')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  provenance_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE project_identity_keys (
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  identity_key TEXT NOT NULL UNIQUE CHECK(length(identity_key) > 0),
  source TEXT NOT NULL CHECK(source IN ('git', 'marker', 'register', 'legacy_import', 'hook')),
  provenance_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, identity_key)
);
CREATE TABLE project_location_state (
  project_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'retired', 'unregistered')),
  last_confirmed_at TEXT,
  provenance_json TEXT NOT NULL,
  PRIMARY KEY(project_id, location_id),
  FOREIGN KEY(project_id, location_id) REFERENCES project_locations(project_id, location_id) ON DELETE CASCADE
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
  consumer_ready INTEGER NOT NULL DEFAULT 0 CHECK(consumer_ready IN (0, 1)),
  consumption_observed INTEGER NOT NULL DEFAULT 0 CHECK(consumption_observed IN (0, 1)),
  delivery_observed INTEGER NOT NULL DEFAULT 0 CHECK(delivery_observed IN (0, 1)),
  delivery_failed INTEGER NOT NULL DEFAULT 0 CHECK(delivery_failed IN (0, 1)),
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
CREATE TABLE session_projection (
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  field_provenance_json TEXT NOT NULL DEFAULT '{}',
  role_json TEXT,
  actor_activity_at TEXT,
  observed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, session_id),
  FOREIGN KEY(project_id, session_id) REFERENCES logical_sessions(project_id, session_id) ON DELETE CASCADE
);
CREATE TABLE generation_projection (
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  field_provenance_json TEXT NOT NULL DEFAULT '{}',
  parent_generation_id TEXT,
  continuation TEXT,
  actor_activity_at TEXT,
  observed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, session_id, generation_id),
  FOREIGN KEY(project_id, session_id, generation_id) REFERENCES session_generations(project_id, session_id, generation_id) ON DELETE CASCADE
);
CREATE INDEX session_projection_revision ON session_projection(project_id, revision, session_id);
CREATE INDEX generation_projection_revision ON generation_projection(project_id, session_id, revision, generation_id);
CREATE TABLE session_pending_events (
  event_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  event_json TEXT NOT NULL,
  source_observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  producer_instance_id TEXT NOT NULL
);
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
	migration(
		"tracker/003-live-tracker-core",
		`
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY, seq INTEGER NOT NULL, project_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'work-item', title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'todo',
  phase TEXT, priority TEXT, labels TEXT NOT NULL DEFAULT '[]',
  stream_id TEXT, parent_id TEXT, wave INTEGER, assignee TEXT,
  created_by TEXT NOT NULL DEFAULT 'human', dispatched_to TEXT,
  dispatched_at TEXT, source_ref TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, rank INTEGER NOT NULL DEFAULT 0,
  state_changed_at TEXT, done_at TEXT, archived_at TEXT,
  pseq INTEGER, display_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_tickets_project ON tickets(project_id);
CREATE INDEX IF NOT EXISTS idx_tickets_state ON tickets(state);
CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets(assignee);
CREATE INDEX IF NOT EXISTS idx_tickets_dispatched_to ON tickets(dispatched_to);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_display ON tickets(display_id) WHERE display_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author TEXT NOT NULL, body TEXT NOT NULL, quote TEXT, prefix TEXT,
  suffix TEXT, section TEXT, section_id TEXT, tag TEXT NOT NULL DEFAULT 'note',
  status TEXT NOT NULL DEFAULT 'open', dispatch_state TEXT NOT NULL DEFAULT 'undispatched',
  parent_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_ticket ON comments(ticket_id);
CREATE TABLE IF NOT EXISTS streams (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'parallel', description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_streams_project ON streams(project_id);
CREATE TABLE IF NOT EXISTS links (
  from_ticket TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  to_ticket TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  type TEXT NOT NULL, PRIMARY KEY(from_ticket, to_ticket, type)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, event_uuid TEXT, ticket_id TEXT,
  project_id TEXT, topic TEXT, class TEXT NOT NULL DEFAULT 'tracker',
  type TEXT NOT NULL, actor TEXT, actor_kind TEXT NOT NULL DEFAULT 'system',
  actor_label TEXT, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ticket ON events(ticket_id);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_uuid ON events(event_uuid) WHERE event_uuid IS NOT NULL;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS project_prefixes (project_id TEXT PRIMARY KEY, prefix TEXT NOT NULL UNIQUE);
		`,
	),
	migration(
		"tracker/004-management-services",
		`
CREATE TABLE management_roles (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK(length(trim(name)) > 0 AND length(name) <= 128),
  scope TEXT NOT NULL CHECK(scope IN ('project', 'session', 'generation')),
  definition_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);
CREATE TABLE management_role_assignments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT,
  generation_id TEXT,
  role_id TEXT NOT NULL REFERENCES management_roles(id) ON DELETE CASCADE,
  actor TEXT NOT NULL CHECK(length(trim(actor)) > 0),
  idempotency_key TEXT NOT NULL CHECK(length(trim(idempotency_key)) > 0),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, idempotency_key)
);
CREATE TABLE management_gates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('approval', 'input')),
  status TEXT NOT NULL CHECK(status IN ('awaiting', 'approved', 'denied', 'cancelled')),
  question TEXT NOT NULL CHECK(length(trim(question)) > 0 AND length(question) <= 4096),
  assignee TEXT NOT NULL CHECK(length(trim(assignee)) > 0),
  verdict_json TEXT,
  idempotency_key TEXT NOT NULL CHECK(length(trim(idempotency_key)) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, idempotency_key),
  CHECK((status = 'awaiting' AND verdict_json IS NULL) OR (status <> 'awaiting' AND verdict_json IS NOT NULL))
);
CREATE TABLE management_ideas (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK(length(trim(body)) > 0 AND length(body) <= 16384),
  status TEXT NOT NULL CHECK(status IN ('pending', 'popped', 'promoted')),
  promoted_ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL CHECK(length(trim(idempotency_key)) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, idempotency_key),
  CHECK((status = 'promoted' AND promoted_ticket_id IS NOT NULL) OR (status <> 'promoted'))
);
CREATE TABLE management_assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL CHECK(length(relative_path) > 0 AND relative_path NOT LIKE '/%' AND relative_path NOT LIKE '%..%'),
  mime_type TEXT NOT NULL CHECK(mime_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0 AND byte_size <= 10485760),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, ticket_id, relative_path)
);
CREATE TABLE management_operations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT,
  generation_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('chat', 'brief', 'interrupt', 'halt', 'control')),
  command TEXT NOT NULL CHECK(length(trim(command)) > 0 AND length(command) <= 128),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'ineligible', 'delivered')),
  actor TEXT NOT NULL CHECK(length(trim(actor)) > 0),
  idempotency_key TEXT NOT NULL CHECK(length(trim(idempotency_key)) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, idempotency_key)
);
CREATE TABLE management_audit (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  actor TEXT NOT NULL CHECK(length(trim(actor)) > 0),
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE management_outbox (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'published')),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, idempotency_key)
);
CREATE INDEX management_roles_project ON management_roles(project_id, name);
CREATE INDEX management_gates_project_status ON management_gates(project_id, status, created_at);
CREATE INDEX management_ideas_project_status ON management_ideas(project_id, status, created_at);
CREATE INDEX management_operations_project_created ON management_operations(project_id, created_at);
CREATE INDEX management_audit_project_created ON management_audit(project_id, created_at);
`,
	),
	migration(
		"tracker/005-comment-dispatches",
		`
CREATE TABLE IF NOT EXISTS comment_dispatches (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  batch_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'delivered', 'addressed', 'cancelled')),
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  addressed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_comment_dispatches_comment ON comment_dispatches(comment_id);
CREATE INDEX IF NOT EXISTS idx_comment_dispatches_ticket_session_status ON comment_dispatches(ticket_id, session_id, status);
CREATE INDEX IF NOT EXISTS idx_comment_dispatches_pending ON comment_dispatches(status) WHERE status IN ('pending', 'delivered');
`,
	),
	migration(
		"tracker/006-browser-principal-policy",
		`
CREATE TABLE browser_principal_bindings (
  id TEXT PRIMARY KEY CHECK(length(id) >= 8),
  actor_id TEXT NOT NULL CHECK(length(trim(actor_id)) > 0),
  role TEXT NOT NULL CHECK(role IN ('operator', 'viewer')),
  default_project_id TEXT NOT NULL CHECK(length(trim(default_project_id)) > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE browser_principal_scopes (
  binding_id TEXT NOT NULL REFERENCES browser_principal_bindings(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL CHECK(length(trim(project_id)) > 0),
  PRIMARY KEY(binding_id, project_id)
);
CREATE TABLE browser_principal_credentials (
  adapter TEXT NOT NULL CHECK(adapter IN ('bearer', 'mcp', 'internal')),
  credential_digest TEXT NOT NULL CHECK(length(credential_digest) = 64),
  binding_id TEXT NOT NULL REFERENCES browser_principal_bindings(id) ON DELETE CASCADE,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(adapter, credential_digest)
);
CREATE TABLE browser_principal_sessions (
  session_digest TEXT PRIMARY KEY CHECK(length(session_digest) = 64),
  csrf_digest TEXT NOT NULL CHECK(length(csrf_digest) = 64),
  binding_id TEXT NOT NULL REFERENCES browser_principal_bindings(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX browser_principal_scope_project ON browser_principal_scopes(project_id, binding_id);
CREATE INDEX browser_principal_sessions_binding ON browser_principal_sessions(binding_id, expires_at);
`,
	),
	migration(
		"tracker/007-command-receipts",
		`
CREATE TABLE command_receipts (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) > 0),
  project_id TEXT NOT NULL CHECK(length(trim(project_id)) > 0),
  idempotency_key TEXT NOT NULL CHECK(length(trim(idempotency_key)) > 0),
  command_kind TEXT NOT NULL CHECK(length(command_kind) > 0),
  actor_id TEXT NOT NULL CHECK(length(trim(actor_id)) > 0),
  resource_type TEXT NOT NULL CHECK(length(resource_type) > 0),
  resource_id TEXT NOT NULL CHECK(length(resource_id) > 0),
  correlation_id TEXT NOT NULL CHECK(length(correlation_id) > 0),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint) > 0),
  outcome_status TEXT NOT NULL CHECK(outcome_status IN ('accepted','completed','rejected','conflict','pending','idempotency_mismatch')),
  reason_code TEXT,
  operation_id TEXT,
  result_json TEXT NOT NULL DEFAULT '{}',
  committed_at TEXT NOT NULL,
  UNIQUE(project_id, idempotency_key)
);
CREATE INDEX command_receipts_lookup ON command_receipts(project_id, idempotency_key);
CREATE INDEX command_receipts_resource ON command_receipts(project_id, resource_type, resource_id);
		`,
	),
	migration(
		"tracker/008-committed-publication-outbox",
		`
/*
 * GOL-80 publication is a persistence-owned extension of GOL-36, never a
 * browser event store.  Rows carry only allowlisted category/scope/revision
 * facts.  Historic management_outbox payloads remain preserved in place and
 * are deliberately not replayed by this new dispatcher.
 */
CREATE TABLE committed_project_revisions (
  project_id TEXT PRIMARY KEY CHECK(length(trim(project_id)) > 0),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  updated_at TEXT NOT NULL
);
CREATE TABLE committed_resource_revisions (
  project_id TEXT NOT NULL REFERENCES committed_project_revisions(project_id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK(length(resource_type) > 0 AND length(resource_type) <= 64),
  resource_id TEXT NOT NULL CHECK(length(resource_id) > 0 AND length(resource_id) <= 256),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, resource_type, resource_id)
);
CREATE TABLE committed_publication_outbox (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES committed_project_revisions(project_id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK(category IN ('tracker', 'management', 'communication', 'asset', 'delivery')),
  resource_type TEXT NOT NULL CHECK(length(resource_type) > 0 AND length(resource_type) <= 64),
  resource_id TEXT NOT NULL CHECK(length(resource_id) > 0 AND length(resource_id) <= 256),
  resource_revision INTEGER NOT NULL CHECK(resource_revision >= 1),
  project_revision INTEGER NOT NULL CHECK(project_revision >= 1),
  schema_version TEXT NOT NULL CHECK(schema_version = 'golem.committed-invalidation/v1'),
  policy_version INTEGER NOT NULL CHECK(policy_version >= 1),
  status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'published')),
  created_at TEXT NOT NULL,
  published_at TEXT,
  claim_owner TEXT,
  claim_token TEXT,
  claim_until TEXT,
  CHECK((status = 'claimed' AND claim_owner IS NOT NULL AND claim_token IS NOT NULL AND claim_until IS NOT NULL) OR status <> 'claimed')
);
CREATE INDEX committed_publication_claimable ON committed_publication_outbox(status, created_at, id);
CREATE INDEX committed_publication_project ON committed_publication_outbox(project_id, project_revision);

/* Delivery and bus rows predate project-scoped invalidations.  Preserve every
 * historic row as system-scoped (there is no safe inference), while all new
 * typed callers provide the project id. */
ALTER TABLE tracker_envelopes ADD COLUMN project_id TEXT NOT NULL DEFAULT 'system';
ALTER TABLE tracker_bus_events ADD COLUMN project_id TEXT NOT NULL DEFAULT 'system';
CREATE INDEX tracker_envelopes_project ON tracker_envelopes(project_id, status);
CREATE INDEX tracker_bus_events_project_sequence ON tracker_bus_events(project_id, sequence);

/* Each trigger advances one resource revision and one project-visible revision,
 * then appends one opaque row in the enclosing SQLite transaction. */
CREATE TRIGGER committed_pub_ticket_insert AFTER INSERT ON tickets BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at)
    ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'tracker.ticket', NEW.id, 1, NEW.updated_at)
    ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at)
    VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'tracker', 'tracker.ticket', NEW.id,
      (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'tracker.ticket' AND resource_id = NEW.id),
      (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;
CREATE TRIGGER committed_pub_ticket_update AFTER UPDATE ON tickets WHEN NEW.updated_at <> OLD.updated_at BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at)
    ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'tracker.ticket', NEW.id, 1, NEW.updated_at)
    ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at)
    VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'tracker', 'tracker.ticket', NEW.id,
      (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'tracker.ticket' AND resource_id = NEW.id),
      (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;
CREATE TRIGGER committed_pub_comment_insert AFTER INSERT ON comments BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) SELECT project_id, 1, NEW.updated_at FROM tickets WHERE id = NEW.ticket_id
    ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) SELECT project_id, 'tracker.comment', NEW.id, 1, NEW.updated_at FROM tickets WHERE id = NEW.ticket_id
    ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at)
    SELECT 'cpub_' || lower(hex(randomblob(16))), project_id, 'tracker', 'tracker.comment', NEW.id,
      (SELECT revision FROM committed_resource_revisions WHERE project_id = tickets.project_id AND resource_type = 'tracker.comment' AND resource_id = NEW.id),
      (SELECT revision FROM committed_project_revisions WHERE project_id = tickets.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at FROM tickets WHERE id = NEW.ticket_id;
END;
CREATE TRIGGER committed_pub_comment_update AFTER UPDATE ON comments WHEN NEW.updated_at <> OLD.updated_at BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) SELECT project_id, 1, NEW.updated_at FROM tickets WHERE id = NEW.ticket_id
    ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) SELECT project_id, 'tracker.comment', NEW.id, 1, NEW.updated_at FROM tickets WHERE id = NEW.ticket_id
    ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at)
    SELECT 'cpub_' || lower(hex(randomblob(16))), project_id, 'tracker', 'tracker.comment', NEW.id,
      (SELECT revision FROM committed_resource_revisions WHERE project_id = tickets.project_id AND resource_type = 'tracker.comment' AND resource_id = NEW.id),
      (SELECT revision FROM committed_project_revisions WHERE project_id = tickets.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at FROM tickets WHERE id = NEW.ticket_id;
END;
CREATE TRIGGER committed_pub_stream_insert AFTER INSERT ON streams BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at)
    ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'tracker.stream', NEW.id, 1, NEW.updated_at)
    ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at)
    VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'tracker', 'tracker.stream', NEW.id,
      (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'tracker.stream' AND resource_id = NEW.id),
      (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;
CREATE TRIGGER committed_pub_stream_update AFTER UPDATE ON streams WHEN NEW.updated_at <> OLD.updated_at BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at)
    ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'tracker.stream', NEW.id, 1, NEW.updated_at)
    ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at)
    VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'tracker', 'tracker.stream', NEW.id,
      (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'tracker.stream' AND resource_id = NEW.id),
      (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;
CREATE TRIGGER committed_pub_link_insert AFTER INSERT ON links BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) SELECT project_id, 1, updated_at FROM tickets WHERE id = NEW.from_ticket
    ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) SELECT project_id, 'tracker.link', NEW.from_ticket || ':' || NEW.to_ticket || ':' || NEW.type, 1, updated_at FROM tickets WHERE id = NEW.from_ticket
    ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at)
    SELECT 'cpub_' || lower(hex(randomblob(16))), project_id, 'tracker', 'tracker.link', NEW.from_ticket || ':' || NEW.to_ticket || ':' || NEW.type,
      (SELECT revision FROM committed_resource_revisions WHERE project_id = tickets.project_id AND resource_type = 'tracker.link' AND resource_id = NEW.from_ticket || ':' || NEW.to_ticket || ':' || NEW.type),
      (SELECT revision FROM committed_project_revisions WHERE project_id = tickets.project_id), 'golem.committed-invalidation/v1', 1, 'pending', updated_at FROM tickets WHERE id = NEW.from_ticket;
END;
CREATE TRIGGER committed_pub_link_delete AFTER DELETE ON links BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) SELECT project_id, 1, updated_at FROM tickets WHERE id = OLD.from_ticket
    ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) SELECT project_id, 'tracker.link', OLD.from_ticket || ':' || OLD.to_ticket || ':' || OLD.type, 1, updated_at FROM tickets WHERE id = OLD.from_ticket
    ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at)
    SELECT 'cpub_' || lower(hex(randomblob(16))), project_id, 'tracker', 'tracker.link', OLD.from_ticket || ':' || OLD.to_ticket || ':' || OLD.type,
      (SELECT revision FROM committed_resource_revisions WHERE project_id = tickets.project_id AND resource_type = 'tracker.link' AND resource_id = OLD.from_ticket || ':' || OLD.to_ticket || ':' || OLD.type),
      (SELECT revision FROM committed_project_revisions WHERE project_id = tickets.project_id), 'golem.committed-invalidation/v1', 1, 'pending', updated_at FROM tickets WHERE id = OLD.from_ticket;
END;

CREATE TRIGGER committed_pub_management_role_insert AFTER INSERT ON management_roles BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'management.role', NEW.id, 1, NEW.updated_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'management', 'management.role', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'management.role' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;
CREATE TRIGGER committed_pub_management_role_update AFTER UPDATE ON management_roles WHEN NEW.updated_at <> OLD.updated_at BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'management.role', NEW.id, 1, NEW.updated_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'management', 'management.role', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'management.role' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;
CREATE TRIGGER committed_pub_management_assignment_insert AFTER INSERT ON management_role_assignments BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.created_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'management.assignment', NEW.id, 1, NEW.created_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'management', 'management.assignment', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'management.assignment' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.created_at);
END;
CREATE TRIGGER committed_pub_management_gate_insert AFTER INSERT ON management_gates BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'management.gate', NEW.id, 1, NEW.updated_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'management', 'management.gate', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'management.gate' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;
CREATE TRIGGER committed_pub_management_gate_update AFTER UPDATE ON management_gates WHEN NEW.updated_at <> OLD.updated_at BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'management.gate', NEW.id, 1, NEW.updated_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'management', 'management.gate', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'management.gate' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;
CREATE TRIGGER committed_pub_management_idea_insert AFTER INSERT ON management_ideas BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'management.idea', NEW.id, 1, NEW.updated_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'management', 'management.idea', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'management.idea' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;
CREATE TRIGGER committed_pub_management_idea_update AFTER UPDATE ON management_ideas WHEN NEW.updated_at <> OLD.updated_at BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'management.idea', NEW.id, 1, NEW.updated_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'management', 'management.idea', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'management.idea' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;
CREATE TRIGGER committed_pub_management_asset_insert AFTER INSERT ON management_assets BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.created_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'management.asset', NEW.id, 1, NEW.created_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'asset', 'management.asset', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'management.asset' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.created_at);
END;
CREATE TRIGGER committed_pub_management_operation_insert AFTER INSERT ON management_operations BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'communication.operation', NEW.id, 1, NEW.updated_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'communication', 'communication.operation', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'communication.operation' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;
CREATE TRIGGER committed_pub_management_operation_update AFTER UPDATE ON management_operations WHEN NEW.updated_at <> OLD.updated_at BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'communication.operation', NEW.id, 1, NEW.updated_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'communication', 'communication.operation', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'communication.operation' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;

CREATE TRIGGER committed_pub_delivery_envelope_insert AFTER INSERT ON tracker_envelopes BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.created_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'delivery.envelope', NEW.id, 1, NEW.created_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'delivery', 'delivery.envelope', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'delivery.envelope' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.created_at);
END;
CREATE TRIGGER committed_pub_delivery_envelope_settlement AFTER UPDATE ON tracker_envelopes WHEN NEW.status <> OLD.status AND NEW.status <> 'claimed' BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, COALESCE(NEW.delivered_at, NEW.created_at)) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'delivery.envelope', NEW.id, 1, COALESCE(NEW.delivered_at, NEW.created_at)) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'delivery', 'delivery.envelope', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'delivery.envelope' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', COALESCE(NEW.delivered_at, NEW.created_at));
END;
CREATE TRIGGER committed_pub_delivery_ack_insert AFTER INSERT ON tracker_envelope_acknowledgements BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) SELECT project_id, 1, NEW.acknowledged_at FROM tracker_envelopes WHERE id = NEW.envelope_id ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) SELECT project_id, 'delivery.ack', NEW.envelope_id || ':' || NEW.acknowledgement_id, 1, NEW.acknowledged_at FROM tracker_envelopes WHERE id = NEW.envelope_id ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) SELECT 'cpub_' || lower(hex(randomblob(16))), project_id, 'delivery', 'delivery.ack', NEW.envelope_id || ':' || NEW.acknowledgement_id, (SELECT revision FROM committed_resource_revisions WHERE project_id = tracker_envelopes.project_id AND resource_type = 'delivery.ack' AND resource_id = NEW.envelope_id || ':' || NEW.acknowledgement_id), (SELECT revision FROM committed_project_revisions WHERE project_id = tracker_envelopes.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.acknowledged_at FROM tracker_envelopes WHERE id = NEW.envelope_id;
END;
CREATE TRIGGER committed_pub_bus_insert AFTER INSERT ON tracker_bus_events BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.created_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'delivery.bus', NEW.id, 1, NEW.created_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'delivery', 'delivery.bus', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'delivery.bus' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.created_at);
END;
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
