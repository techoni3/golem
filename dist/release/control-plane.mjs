// apps/control-plane/src/main.ts
import fs16 from "node:fs";
import os2 from "node:os";
import path18 from "node:path";
import { fileURLToPath } from "node:url";

// packages/persistence/dist/authority.js
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
var controlPlaneAuthoritySchemaVersion = "golem.control-plane-authority/v1";
function validTimestamp(value2) {
  return typeof value2 === "string" && Number.isFinite(Date.parse(value2));
}
function validHash(value2) {
  return typeof value2 === "string" && /^[a-f0-9]{64}$/u.test(value2);
}
function validAuthority(value2) {
  if (!value2 || typeof value2 !== "object" || Array.isArray(value2))
    return false;
  const candidate = value2;
  if (candidate.schema_version !== controlPlaneAuthoritySchemaVersion || candidate.stage !== "C3" && candidate.stage !== "C4" || candidate.write_policy !== "legacy_open" && candidate.write_policy !== "quiesced" && candidate.write_policy !== "canonical_only" || !Number.isInteger(candidate.revision) || Number(candidate.revision) < 0 || !validTimestamp(candidate.updated_at))
    return false;
  if (candidate.stage === "C3" && candidate.write_policy === "canonical_only" || candidate.stage === "C4" && candidate.write_policy !== "canonical_only")
    return false;
  if (candidate.plan_hash !== void 0 && !validHash(candidate.plan_hash))
    return false;
  if (candidate.canonical_revision !== void 0 && (!Number.isInteger(candidate.canonical_revision) || Number(candidate.canonical_revision) < 0))
    return false;
  if (candidate.rollback_audit !== void 0 && (typeof candidate.rollback_audit !== "string" || candidate.rollback_audit.length === 0 || path.isAbsolute(candidate.rollback_audit) || candidate.rollback_audit.split(path.sep).includes("..")))
    return false;
  return true;
}
function controlPlaneAuthorityPath(home) {
  return path.join(path.resolve(home), "control-plane", "authority.json");
}
function defaultControlPlaneAuthority() {
  return Object.freeze({
    schema_version: controlPlaneAuthoritySchemaVersion,
    stage: "C3",
    write_policy: "legacy_open",
    revision: 0,
    updated_at: "1970-01-01T00:00:00.000Z"
  });
}
function readControlPlaneAuthority(home) {
  const target = controlPlaneAuthorityPath(home);
  try {
    const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
    if (!validAuthority(parsed))
      throw new Error("control-plane authority pointer is invalid");
    return Object.freeze({ ...parsed });
  } catch (error2) {
    if (typeof error2 === "object" && error2 !== null && "code" in error2 && error2.code === "ENOENT")
      return defaultControlPlaneAuthority();
    throw error2;
  }
}
function resolveControlPlanePersistencePaths(home) {
  const authority = readControlPlaneAuthority(home);
  const runtimeRoot = authority.stage === "C4" ? path.join(path.resolve(home), "canonical") : path.resolve(home);
  return Object.freeze({
    // GOL-20 keeps tracker as its own authority. C4 switches only the
    // project/session/endpoint runtime store; moving tracker history to the
    // migration scratch database would silently discard real work.
    runtimePath: path.join(runtimeRoot, "runtime.db"),
    trackerPath: path.join(path.resolve(home), "tracker.db"),
    lockPath: path.join(path.resolve(home), "control-plane", "persistence.owner.lock"),
    authority
  });
}

// packages/persistence/dist/schema.js
import crypto2 from "node:crypto";
var busyTimeoutMs = 2500;
var latestRuntimeVersion = 1;
var latestTrackerVersion = 9;
function migrationChecksum(value2) {
  return crypto2.createHash("sha256").update(value2).digest("hex");
}
function migration(id2, sql2) {
  return Object.freeze({ id: id2, checksum: migrationChecksum(sql2), sql: sql2 });
}
var runtimeMigrations = [
  migration("runtime/001-initial", `
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
`)
];
var trackerMigrations = [
  migration("tracker/001-baseline", `
CREATE TABLE migration_audit (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  backup_path TEXT,
  applied_at TEXT NOT NULL
);
`),
  migration("tracker/002-durable-delivery-bus", `
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
`),
  migration("tracker/003-live-tracker-core", `
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
		`),
  migration("tracker/004-management-services", `
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
`),
  migration("tracker/005-comment-dispatches", `
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
`),
  migration("tracker/006-browser-principal-policy", `
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
`),
  migration("tracker/007-command-receipts", `
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
		`),
  migration("tracker/008-committed-publication-outbox", `
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
`),
  migration("tracker/009-semantic-committed-publication", `
/* GOL-80 repair: timestamps are observation facts, not semantic change
 * detectors.  Recreate the update triggers with null-safe domain-column
 * predicates so fixed clocks cannot hide a committed mutation and an actual
 * no-op cannot manufacture a revision/outbox row. */
DROP TRIGGER committed_pub_ticket_update;
DROP TRIGGER committed_pub_comment_update;
DROP TRIGGER committed_pub_stream_update;
DROP TRIGGER committed_pub_management_role_update;
DROP TRIGGER committed_pub_management_gate_update;
DROP TRIGGER committed_pub_management_idea_update;
DROP TRIGGER committed_pub_management_operation_update;
DROP TRIGGER committed_pub_delivery_envelope_settlement;

CREATE TRIGGER committed_pub_ticket_update AFTER UPDATE ON tickets
WHEN NEW.kind IS NOT OLD.kind OR NEW.title IS NOT OLD.title
  OR NEW.body IS NOT OLD.body OR NEW.state IS NOT OLD.state
  OR NEW.phase IS NOT OLD.phase OR NEW.priority IS NOT OLD.priority
  OR NEW.labels IS NOT OLD.labels OR NEW.stream_id IS NOT OLD.stream_id
  OR NEW.parent_id IS NOT OLD.parent_id OR NEW.wave IS NOT OLD.wave
  OR NEW.assignee IS NOT OLD.assignee OR NEW.created_by IS NOT OLD.created_by
  OR NEW.dispatched_to IS NOT OLD.dispatched_to
  OR NEW.source_ref IS NOT OLD.source_ref OR NEW.rank IS NOT OLD.rank
  OR NEW.display_id IS NOT OLD.display_id
BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at)
    ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'tracker.ticket', NEW.id, 1, NEW.updated_at)
    ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at)
    VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'tracker', 'tracker.ticket', NEW.id,
      (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'tracker.ticket' AND resource_id = NEW.id),
      (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;

CREATE TRIGGER committed_pub_comment_update AFTER UPDATE ON comments
WHEN NEW.ticket_id IS NOT OLD.ticket_id OR NEW.author IS NOT OLD.author
  OR NEW.body IS NOT OLD.body OR NEW.quote IS NOT OLD.quote
  OR NEW.prefix IS NOT OLD.prefix OR NEW.suffix IS NOT OLD.suffix
  OR NEW.section IS NOT OLD.section OR NEW.section_id IS NOT OLD.section_id
  OR NEW.tag IS NOT OLD.tag OR NEW.status IS NOT OLD.status
  OR NEW.dispatch_state IS NOT OLD.dispatch_state OR NEW.parent_id IS NOT OLD.parent_id
BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) SELECT project_id, 1, NEW.updated_at FROM tickets WHERE id = NEW.ticket_id
    ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) SELECT project_id, 'tracker.comment', NEW.id, 1, NEW.updated_at FROM tickets WHERE id = NEW.ticket_id
    ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at)
    SELECT 'cpub_' || lower(hex(randomblob(16))), project_id, 'tracker', 'tracker.comment', NEW.id,
      (SELECT revision FROM committed_resource_revisions WHERE project_id = tickets.project_id AND resource_type = 'tracker.comment' AND resource_id = NEW.id),
      (SELECT revision FROM committed_project_revisions WHERE project_id = tickets.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at FROM tickets WHERE id = NEW.ticket_id;
END;

CREATE TRIGGER committed_pub_stream_update AFTER UPDATE ON streams
WHEN NEW.project_id IS NOT OLD.project_id OR NEW.name IS NOT OLD.name
  OR NEW.mode IS NOT OLD.mode OR NEW.description IS NOT OLD.description
BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at)
    ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'tracker.stream', NEW.id, 1, NEW.updated_at)
    ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at)
    VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'tracker', 'tracker.stream', NEW.id,
      (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'tracker.stream' AND resource_id = NEW.id),
      (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;

CREATE TRIGGER committed_pub_management_role_update AFTER UPDATE ON management_roles
WHEN NEW.name IS NOT OLD.name OR NEW.scope IS NOT OLD.scope
  OR NEW.definition_json IS NOT OLD.definition_json
BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'management.role', NEW.id, 1, NEW.updated_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'management', 'management.role', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'management.role' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;

CREATE TRIGGER committed_pub_management_gate_update AFTER UPDATE ON management_gates
WHEN NEW.kind IS NOT OLD.kind OR NEW.status IS NOT OLD.status
  OR NEW.question IS NOT OLD.question OR NEW.assignee IS NOT OLD.assignee
  OR NEW.verdict_json IS NOT OLD.verdict_json
BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'management.gate', NEW.id, 1, NEW.updated_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'management', 'management.gate', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'management.gate' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;

CREATE TRIGGER committed_pub_management_idea_update AFTER UPDATE ON management_ideas
WHEN NEW.body IS NOT OLD.body OR NEW.status IS NOT OLD.status
  OR NEW.promoted_ticket_id IS NOT OLD.promoted_ticket_id
BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'management.idea', NEW.id, 1, NEW.updated_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'management', 'management.idea', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'management.idea' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;

CREATE TRIGGER committed_pub_management_operation_update AFTER UPDATE ON management_operations
WHEN NEW.session_id IS NOT OLD.session_id OR NEW.generation_id IS NOT OLD.generation_id
  OR NEW.kind IS NOT OLD.kind OR NEW.command IS NOT OLD.command
  OR NEW.payload_json IS NOT OLD.payload_json OR NEW.status IS NOT OLD.status
  OR NEW.actor IS NOT OLD.actor
BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'communication.operation', NEW.id, 1, NEW.updated_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'communication', 'communication.operation', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'communication.operation' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;

/* acknowledgeEnvelope inserts one acknowledgement and changes status in one
 * transaction.  The acknowledgement trigger is the sole canonical owner for
 * that event; every other terminal delivery status stays envelope-owned. */
CREATE TRIGGER committed_pub_delivery_envelope_settlement AFTER UPDATE ON tracker_envelopes
WHEN NEW.status <> OLD.status AND NEW.status <> 'claimed' AND NEW.status <> 'acknowledged'
BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, COALESCE(NEW.delivered_at, NEW.created_at)) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'delivery.envelope', NEW.id, 1, COALESCE(NEW.delivered_at, NEW.created_at)) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'delivery', 'delivery.envelope', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'delivery.envelope' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', COALESCE(NEW.delivered_at, NEW.created_at));
END;
`)
];
function migrationSet(scope) {
  return scope === "runtime" ? runtimeMigrations : trackerMigrations;
}
function latestVersion(scope) {
  return scope === "runtime" ? latestRuntimeVersion : latestTrackerVersion;
}
function numericPragma(database, source) {
  const result2 = database.pragma(source, { simple: true });
  const value2 = Array.isArray(result2) ? result2[0] : result2;
  return typeof value2 === "number" ? value2 : Number(value2);
}
function textPragma(database, source) {
  const result2 = database.pragma(source, { simple: true });
  const value2 = Array.isArray(result2) ? result2[0] : result2;
  return String(value2).toLowerCase();
}
function configure(database) {
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.pragma(`busy_timeout = ${busyTimeoutMs}`);
  database.pragma("synchronous = FULL");
}
function currentVersion(database) {
  return numericPragma(database, "user_version");
}
function tableExists(database, name) {
  return Boolean(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}
function hasTrackerTables(database) {
  const result2 = database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT IN ('sqlite_sequence', 'golem_migrations', 'migration_audit')").get();
  return (result2?.count ?? 0) > 0;
}
function hasManagedTrackerSchema(database) {
  return tableExists(database, "golem_migrations") && tableExists(database, "tracker_envelopes") && tableExists(database, "tracker_bus_events");
}
function sha256(value2) {
  return crypto2.createHash("sha256").update(value2).digest("hex");
}

// packages/persistence/dist/tracker-core-capability.js
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

// packages/persistence/dist/tracker-core-repository.js
import { sql } from "kysely";

// packages/persistence/dist/kysely-sync.js
var SyncKyselyTrackerStore = class {
  #database;
  #queries;
  constructor(queries, database) {
    this.#queries = queries;
    this.#database = database;
  }
  get queries() {
    return this.#queries;
  }
  run(query) {
    const compiled = query.compile();
    return this.#database.prepare(compiled.sql).run(...compiled.parameters);
  }
  get(query) {
    const compiled = query.compile();
    return this.#database.prepare(compiled.sql).get(...compiled.parameters);
  }
  all(query) {
    const compiled = query.compile();
    return this.#database.prepare(compiled.sql).all(...compiled.parameters);
  }
  transaction(fn) {
    return this.#database.transaction(() => fn()).immediate();
  }
};

// packages/persistence/dist/tracker-core-repository.js
function parseLabels(value2) {
  try {
    const parsed = JSON.parse(value2);
    return Array.isArray(parsed) ? Object.freeze(parsed.filter((item) => typeof item === "string")) : Object.freeze([]);
  } catch {
    return Object.freeze([]);
  }
}
function json(value2) {
  return JSON.stringify(value2);
}
function rowTicket(row) {
  return Object.freeze({
    id: row.id,
    displayId: row.display_id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    priority: row.priority,
    labels: parseLabels(row.labels),
    ...row.stream_id ? { streamId: row.stream_id } : {},
    ...row.parent_id ? { parentId: row.parent_id } : {},
    ...row.assignee ? { assignee: row.assignee } : {},
    ...row.dispatched_to ? { dispatchedTo: row.dispatched_to } : {},
    ...row.dispatched_at ? { dispatchedAt: row.dispatched_at } : {},
    state: row.state,
    phase: row.phase ?? "queued",
    rank: Number(row.rank),
    ...row.wave === null ? {} : { wave: Number(row.wave) },
    revision: Number(row.revision),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}
function rowComment(row) {
  const anchor2 = Object.fromEntries(Object.entries({
    quote: row.quote,
    prefix: row.prefix,
    suffix: row.suffix,
    section: row.section,
    sectionId: row.section_id
  }).filter(([, value2]) => value2 !== null));
  return Object.freeze({
    id: row.id,
    ticketId: row.ticket_id,
    ...row.parent_id ? { parentId: row.parent_id } : {},
    author: row.author,
    body: row.body,
    ...Object.keys(anchor2).length ? { anchor: anchor2 } : {},
    tag: row.tag,
    status: row.status,
    dispatchState: row.dispatch_state,
    revision: 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}
function ticketPrefix(projectId2) {
  const slug = projectId2.replace(/-[0-9a-f]{6}$/u, "");
  return (slug.slice(0, 3) || "TKT").toUpperCase();
}
function actorKind(actor3) {
  if (!actor3)
    return "system";
  if (actor3 === "system" || actor3.startsWith("system:") || actor3.startsWith("golem-") || actor3 === "golem-drainer")
    return "system";
  if (actor3 === "human" || actor3 === "you" || actor3.startsWith("human:"))
    return "human";
  return "session";
}
function actorLabel(actor3, kind) {
  const value2 = actor3.trim();
  if (!value2)
    return kind;
  const prefix = `${kind}:`;
  return value2.startsWith(prefix) ? value2.slice(prefix.length) || kind : value2;
}
var TrackerCoreRepository = class {
  #store;
  constructor(queries, database) {
    this.#store = new SyncKyselyTrackerStore(queries, database);
  }
  #ticket(id2) {
    return this.#store.get(this.#store.queries.selectFrom("tickets").select([
      "tickets.id",
      "tickets.seq",
      "tickets.pseq",
      "tickets.display_id",
      "tickets.project_id",
      "tickets.kind",
      "tickets.title",
      "tickets.body",
      "tickets.state",
      "tickets.phase",
      "tickets.priority",
      "tickets.labels",
      "tickets.stream_id",
      "tickets.parent_id",
      "tickets.assignee",
      "tickets.dispatched_to",
      "tickets.dispatched_at",
      "tickets.source_ref",
      "tickets.wave",
      "tickets.created_by",
      "tickets.created_at",
      "tickets.updated_at",
      "tickets.state_changed_at",
      "tickets.done_at",
      "tickets.archived_at",
      "tickets.rank",
      sql`coalesce((select max(id) from events where events.ticket_id = tickets.id), 1)`.as("revision")
    ]).where((eb) => eb.or([eb("tickets.id", "=", id2), eb("tickets.display_id", "=", id2)])).limit(1));
  }
  #emit(input) {
    const actor3 = input.mutation.actor;
    const kind = actorKind(actor3);
    const topic = input.ticket ? `ticket/${input.ticket.displayId}` : `project/${input.projectId}/events`;
    const eventData = {
      event_id: input.mutation.eventId,
      outbox_id: input.mutation.outboxId,
      audit_id: input.mutation.auditId,
      actor_kind: kind,
      actor_label: actorLabel(actor3, kind),
      resource_type: input.resourceType,
      resource_id: input.resourceId,
      revision: input.revision ?? input.ticket?.revision ?? 1,
      ...input.details
    };
    const event = this.#store.get(this.#store.queries.insertInto("events").values({
      event_uuid: input.mutation.eventId,
      ticket_id: input.ticket?.id ?? null,
      project_id: input.projectId,
      topic,
      class: "tracker",
      type: input.type,
      actor: actor3,
      actor_kind: kind,
      actor_label: actorLabel(actor3, kind),
      data: json(eventData),
      created_at: input.mutation.now
    }).returning("id"));
    if (!event)
      throw new Error("tracker event insert did not return an id");
    this.#store.run(this.#store.queries.updateTable("events").set({
      data: json({
        ...eventData,
        event_id: String(event.id),
        outbox_id: String(event.id),
        audit_id: String(event.id),
        revision: event.id
      })
    }).where("id", "=", event.id));
    if (input.ticket?.parentId) {
      const parent = this.#ticket(input.ticket.parentId);
      if (parent?.kind === "spec") {
        this.#store.run(this.#store.queries.insertInto("events").values({
          event_uuid: null,
          ticket_id: input.ticket.id,
          project_id: input.projectId,
          topic: `spec/${parent.display_id}/tree`,
          class: "tracker",
          type: input.type,
          actor: actor3,
          actor_kind: kind,
          actor_label: actorLabel(actor3, kind),
          data: json({
            ...eventData,
            event_id: String(event.id),
            outbox_id: String(event.id),
            audit_id: String(event.id),
            revision: event.id,
            mirrored_from_topic: topic
          }),
          created_at: input.mutation.now
        }));
      }
    }
    return event.id;
  }
  allocateDisplayId(prefix) {
    return this.#store.transaction(() => {
      const key = `compat:${prefix}:display_seq`;
      const current = Number(this.#store.get(this.#store.queries.selectFrom("meta").select("value").where("key", "=", key))?.value ?? "0") + 1;
      this.#store.run(this.#store.queries.insertInto("meta").values({ key, value: String(current) }).onConflict((oc) => oc.column("key").doUpdateSet({ value: String(current) })));
      return `${prefix}-${current}`;
    });
  }
  createWorkItem(input) {
    return this.#store.transaction(() => {
      const item = input.workItem;
      const existingPrefix = this.#store.get(this.#store.queries.selectFrom("project_prefixes").select("prefix").where("project_id", "=", item.projectId));
      let prefix = existingPrefix?.prefix;
      if (!prefix) {
        const base = ticketPrefix(item.projectId);
        const taken = new Set(this.#store.all(this.#store.queries.selectFrom("project_prefixes").select("prefix")).map((row) => row.prefix));
        prefix = base;
        for (let suffix = 2; taken.has(prefix); suffix += 1)
          prefix = `${base}${suffix}`;
        this.#store.run(this.#store.queries.insertInto("project_prefixes").values({ project_id: item.projectId, prefix }));
      }
      const ticketSeq = Number(this.#store.get(this.#store.queries.selectFrom("meta").select("value").where("key", "=", "ticket_seq"))?.value ?? "0") + 1;
      this.#store.run(this.#store.queries.insertInto("meta").values({ key: "ticket_seq", value: String(ticketSeq) }).onConflict((oc) => oc.column("key").doUpdateSet({ value: String(ticketSeq) })));
      const pseqKey = `pseq:${item.projectId}`;
      const projectSeq = Number(this.#store.get(this.#store.queries.selectFrom("meta").select("value").where("key", "=", pseqKey))?.value ?? "0") + 1;
      this.#store.run(this.#store.queries.insertInto("meta").values({ key: pseqKey, value: String(projectSeq) }).onConflict((oc) => oc.column("key").doUpdateSet({ value: String(projectSeq) })));
      const id2 = `TKT-${String(ticketSeq).padStart(4, "0")}`;
      const displayId = `${prefix}-${projectSeq}`;
      this.#store.run(this.#store.queries.insertInto("tickets").values({
        id: id2,
        seq: ticketSeq,
        pseq: projectSeq,
        display_id: displayId,
        project_id: item.projectId,
        kind: item.kind,
        title: item.title,
        body: item.body,
        state: item.state,
        phase: item.phase,
        priority: item.priority,
        labels: json(item.labels),
        stream_id: item.streamId ?? null,
        parent_id: item.parentId ?? null,
        assignee: item.assignee ?? null,
        dispatched_to: null,
        dispatched_at: null,
        source_ref: null,
        wave: item.wave ?? null,
        created_by: item.createdBy,
        created_at: item.createdAt,
        updated_at: item.updatedAt,
        state_changed_at: item.updatedAt,
        done_at: null,
        archived_at: null,
        rank: item.rank
      }));
      const stored = this.getWorkItem(id2);
      if (!stored)
        throw new Error("created ticket cannot be read");
      this.#emit({
        mutation: input.mutation,
        ticket: stored,
        projectId: stored.projectId,
        type: "created",
        resourceType: "ticket",
        resourceId: id2,
        details: {
          kind: stored.kind,
          phase: stored.phase,
          title: stored.title
        }
      });
      const created = this.getWorkItem(id2);
      if (!created)
        throw new Error("created ticket cannot be read after event");
      return created;
    });
  }
  getWorkItem(id2) {
    const row = this.#ticket(id2);
    return row ? rowTicket(row) : void 0;
  }
  phaseEvidence(id2) {
    const current = this.getWorkItem(id2);
    const comments = this.#store.all(this.#store.queries.selectFrom("comments").select(["body", "author"]).where("ticket_id", "=", id2));
    const children = this.#store.all(this.#store.queries.selectFrom("tickets").select("state").where("parent_id", "=", id2));
    const waves = this.#store.get(this.#store.queries.selectFrom("tickets").select((eb) => eb.fn.count("id").as("count")).where("parent_id", "=", id2).where("wave", "is not", null));
    const authorizationEvents = this.#store.all(this.#store.queries.selectFrom("events").select([
      "id",
      "event_uuid",
      "ticket_id",
      "project_id",
      "actor",
      "actor_kind",
      "actor_label",
      "type",
      "data",
      "created_at"
    ]).where("ticket_id", "=", id2).where("type", "=", "manager_skip_authorized"));
    const hasComment = (pattern) => comments.some((comment) => pattern.test(comment.body));
    return Object.freeze({
      closingBrief: hasComment(/closing\s+brief/iu),
      verificationReport: hasComment(/verification|verify-done|smoke|test/iu),
      answerComment: comments.length > 0,
      decisionComment: hasComment(/decision|decided/iu),
      reason: hasComment(/reason|blocked/iu),
      groundingSummary: hasComment(/grounding|grounded/iu),
      design: hasComment(/design/iu),
      concerns: hasComment(/concern/iu),
      humanFinalise: comments.some((comment) => (comment.author === "human" || comment.author.startsWith("human:")) && /finali[sz]e|manager/iu.test(comment.body)),
      children: children.length > 0,
      childrenTerminal: children.length > 0 && children.every((child) => child.state === "done" || child.state === "archived"),
      waves: Number(waves?.count ?? 0) > 0,
      childStarted: children.some((child) => child.state !== "todo"),
      managerDispatch: Boolean(this.getWorkItem(id2)?.dispatchedTo),
      managerSkip: authorizationEvents.some((event) => {
        try {
          const details = JSON.parse(event.data);
          return details.target_phase === "done" && details.authenticated === true && // Exceptional close is one-step and CAS-bound. The
          // authorization event itself advances the canonical revision,
          // so historic evidence can never be replayed after closure or
          // resurrection. Keep the explicit equality checks here as a
          // defense-in-depth guard for any future two-step adapter.
          event.id === current?.revision && details.current_revision === current?.revision && details.source_phase === current?.phase && details.consumed !== true && (details.role === "human" || details.role === "manager");
        } catch {
          return false;
        }
      })
    });
  }
  listWorkItems(input = {}) {
    let query = this.#store.queries.selectFrom("tickets").select([
      "tickets.id",
      "tickets.seq",
      "tickets.pseq",
      "tickets.display_id",
      "tickets.project_id",
      "tickets.kind",
      "tickets.title",
      "tickets.body",
      "tickets.state",
      "tickets.phase",
      "tickets.priority",
      "tickets.labels",
      "tickets.stream_id",
      "tickets.parent_id",
      "tickets.assignee",
      "tickets.dispatched_to",
      "tickets.dispatched_at",
      "tickets.source_ref",
      "tickets.wave",
      "tickets.created_by",
      "tickets.created_at",
      "tickets.updated_at",
      "tickets.state_changed_at",
      "tickets.done_at",
      "tickets.archived_at",
      "tickets.rank",
      sql`coalesce((select max(id) from events where events.ticket_id = tickets.id), 1)`.as("revision")
    ]);
    if (input.projectId !== void 0)
      query = query.where("tickets.project_id", "=", input.projectId);
    if (input.kind !== void 0)
      query = query.where("tickets.kind", "=", input.kind);
    if (input.phase !== void 0)
      query = query.where("tickets.phase", "=", input.phase);
    if (input.assignee !== void 0)
      query = query.where("tickets.assignee", "=", input.assignee);
    return Object.freeze(this.#store.all(query.orderBy("tickets.seq", "asc")).map(rowTicket));
  }
  searchWorkItems(query, projectId2) {
    const term = `%${query.replace(/[\\%_]/gu, "\\$&")}%`;
    let builder = this.#store.queries.selectFrom("tickets").select([
      "tickets.id",
      "tickets.seq",
      "tickets.pseq",
      "tickets.display_id",
      "tickets.project_id",
      "tickets.kind",
      "tickets.title",
      "tickets.body",
      "tickets.state",
      "tickets.phase",
      "tickets.priority",
      "tickets.labels",
      "tickets.stream_id",
      "tickets.parent_id",
      "tickets.assignee",
      "tickets.dispatched_to",
      "tickets.dispatched_at",
      "tickets.source_ref",
      "tickets.wave",
      "tickets.created_by",
      "tickets.created_at",
      "tickets.updated_at",
      "tickets.state_changed_at",
      "tickets.done_at",
      "tickets.archived_at",
      "tickets.rank",
      sql`coalesce((select max(id) from events where events.ticket_id = tickets.id), 1)`.as("revision")
    ]).where((eb) => eb.or([
      eb("tickets.title", "like", term),
      eb("tickets.body", "like", term),
      eb("tickets.display_id", "like", term)
    ]));
    if (projectId2 !== void 0)
      builder = builder.where("tickets.project_id", "=", projectId2);
    return Object.freeze(this.#store.all(builder.orderBy("tickets.updated_at", "desc")).map(rowTicket));
  }
  updateWorkItem(input) {
    return this.#store.transaction(() => {
      const current = this.getWorkItem(input.id);
      if (!current)
        return void 0;
      if (current.revision !== input.expectedRevision)
        return void 0;
      const patch = input.patch;
      const nextKind = patch.kind ?? current.kind;
      const nextPhase = patch.phase ?? current.phase;
      const nextState = patch.state ?? current.state;
      const stateChanged = nextState !== current.state;
      const phaseChanged = nextPhase !== current.phase;
      const assigneeChanged = patch.assignee !== void 0 && patch.assignee !== current.assignee;
      const changedFields = Object.keys(patch).filter((field2) => {
        const key = field2;
        return patch[key] !== current[key];
      });
      const lifecycleFields = {
        ...patch.kind === void 0 ? {} : { kind: nextKind },
        ...patch.state === void 0 ? {} : { state: nextState },
        ...patch.phase === void 0 ? {} : { phase: nextPhase }
      };
      if (input.exceptionalClose) {
        const context = input.exceptionalClose.actorContext;
        if (context.authenticated !== true || context.role !== "human" && context.role !== "manager" || typeof context.actor !== "string" || context.actor.trim().length === 0 || typeof input.exceptionalClose.reason !== "string" || input.exceptionalClose.reason.trim().length === 0)
          throw new Error("tracker exceptional close requires trusted authority");
      }
      let eventOrdinal = 0;
      const emit = (event) => {
        eventOrdinal += 1;
        const suffix = eventOrdinal === 1 ? "" : `-${eventOrdinal}`;
        return this.#emit({
          ...event,
          mutation: {
            ...input.mutation,
            eventId: `${input.mutation.eventId}${suffix}`,
            outboxId: `${input.mutation.outboxId}${suffix}`,
            auditId: `${input.mutation.auditId}${suffix}`
          }
        });
      };
      const changed = this.#store.run(this.#store.queries.updateTable("tickets").set({
        ...lifecycleFields,
        ...patch.title === void 0 ? {} : { title: patch.title },
        ...patch.body === void 0 ? {} : { body: patch.body },
        ...patch.priority === void 0 ? {} : { priority: patch.priority },
        ...patch.labels === void 0 ? {} : { labels: json(patch.labels) },
        ...patch.streamId === void 0 ? {} : { stream_id: patch.streamId },
        ...patch.parentId === void 0 ? {} : { parent_id: patch.parentId },
        ...patch.assignee === void 0 ? {} : { assignee: patch.assignee },
        ...patch.rank === void 0 ? {} : { rank: patch.rank },
        ...patch.wave === void 0 ? {} : { wave: patch.wave },
        ...stateChanged ? { state_changed_at: input.mutation.now } : {},
        ...stateChanged && nextState === "done" ? { done_at: input.mutation.now } : {},
        ...stateChanged && nextState === "archived" ? { archived_at: input.mutation.now } : {},
        updated_at: input.mutation.now
      }).where("tickets.id", "=", current.id));
      if (changed.changes !== 1)
        return void 0;
      const stored = this.getWorkItem(current.id);
      if (!stored)
        throw new Error("updated ticket cannot be read");
      let emittedEvent = false;
      let completionEventId;
      if (input.exceptionalClose) {
        emit({
          ticket: stored,
          projectId: stored.projectId,
          type: "manager_skip_authorized",
          resourceType: "ticket",
          resourceId: stored.id,
          details: {
            source_phase: current.phase,
            target_phase: nextPhase,
            current_revision: current.revision,
            authenticated: true,
            role: input.exceptionalClose.actorContext.role,
            authorized_actor: input.exceptionalClose.actorContext.actor,
            authority_source: input.exceptionalClose.actorContext.source,
            consumed: true,
            reason: input.exceptionalClose.reason.trim()
          }
        });
        emittedEvent = true;
      }
      if (stateChanged) {
        emit({
          ticket: stored,
          projectId: stored.projectId,
          type: "state_change",
          resourceType: "ticket",
          resourceId: stored.id,
          details: {
            from: current.state,
            to: nextState,
            from_phase: current.phase,
            to_phase: nextPhase
          }
        });
        emittedEvent = true;
      }
      if (phaseChanged && !stateChanged) {
        emit({
          ticket: stored,
          projectId: stored.projectId,
          type: "phase_change",
          resourceType: "ticket",
          resourceId: stored.id,
          details: {
            from: current.phase,
            to: nextPhase,
            state: nextState
          }
        });
        emittedEvent = true;
      }
      if (assigneeChanged) {
        emit({
          ticket: stored,
          projectId: stored.projectId,
          type: "assigned",
          resourceType: "ticket",
          resourceId: stored.id,
          details: {
            from: current.assignee ?? null,
            to: patch.assignee ?? null
          }
        });
        emittedEvent = true;
      }
      if (stateChanged || phaseChanged) {
        const actorForms = [
          input.mutation.actor,
          input.mutation.actor.replace(/^session:/u, ""),
          input.mutation.actor.replace(/^human:/u, "")
        ].filter(Boolean);
        this.#store.run(this.#store.queries.updateTable("comment_dispatches").set({ status: "addressed", addressed_at: input.mutation.now }).where("ticket_id", "=", current.id).where("status", "in", ["pending", "delivered"]).where("session_id", "in", actorForms));
        const dispatchedComments = this.#store.all(this.#store.queries.selectFrom("comment_dispatches").select("comment_id").where("ticket_id", "=", current.id));
        for (const { comment_id: commentId } of dispatchedComments) {
          const outstanding = this.#store.get(this.#store.queries.selectFrom("comment_dispatches").select((eb) => eb.fn.count("id").as("count")).where("comment_id", "=", commentId).where("status", "in", ["pending", "delivered"]));
          if (Number(outstanding?.count ?? 0) === 0)
            this.#store.run(this.#store.queries.updateTable("comments").set({
              dispatch_state: "addressed",
              updated_at: input.mutation.now
            }).where("id", "=", commentId).where("dispatch_state", "!=", "n/a"));
        }
      }
      if (["built", "verified", "rejected", "done"].includes(nextPhase) && (input.exceptionalClose !== void 0 || input.mutation.actor !== "human")) {
        completionEventId = emit({
          ticket: stored,
          projectId: stored.projectId,
          type: "dispatch_completion_stamped",
          resourceType: "ticket",
          resourceId: stored.id,
          details: { phase: nextPhase }
        });
        emittedEvent = true;
      }
      if (!emittedEvent && changedFields.length > 0) {
        emit({
          ticket: stored,
          projectId: stored.projectId,
          type: "updated",
          resourceType: "ticket",
          resourceId: stored.id,
          details: { fields: changedFields.sort() }
        });
      }
      if (["built", "verified", "rejected", "done"].includes(nextPhase) && (input.exceptionalClose !== void 0 || input.mutation.actor !== "human")) {
        this.#store.run(this.#store.queries.updateTable("message_envelopes").set({
          completed_at: input.mutation.now,
          completed_event_id: completionEventId ?? null
        }).where("ticket_id", "=", current.id).where("recipient_session_id", "=", input.mutation.actor).where("delivery_attempted_at", "is not", null).where("completed_at", "is", null));
      }
      return this.getWorkItem(current.id) ?? stored;
    });
  }
  /**
   * The canonical companion of a durable ticket envelope. It deliberately
   * updates only historical dispatch output (and, for trusted legacy bridge
   * calls, an otherwise absent current assignee) under the ticket CAS.
   */
  recordWorkItemDispatch(input) {
    return this.#store.transaction(() => {
      const current = this.getWorkItem(input.id);
      if (!current || current.revision !== input.expectedRevision)
        return void 0;
      const changed = this.#store.run(this.#store.queries.updateTable("tickets").set({
        ...input.assignee === void 0 ? {} : { assignee: input.assignee },
        dispatched_to: input.dispatchedTo,
        dispatched_at: input.mutation.now,
        updated_at: input.mutation.now
      }).where("tickets.id", "=", current.id));
      if (changed.changes !== 1)
        return void 0;
      const stored = this.getWorkItem(current.id);
      if (!stored)
        throw new Error("dispatched ticket cannot be read");
      this.#emit({
        mutation: input.mutation,
        ticket: stored,
        projectId: stored.projectId,
        type: "dispatch_queued",
        resourceType: "ticket",
        resourceId: stored.id,
        details: {}
      });
      return this.getWorkItem(current.id) ?? stored;
    });
  }
  transitionWorkItem(input) {
    return this.#store.transaction(() => {
      const current = this.getWorkItem(input.id);
      if (!current)
        return void 0;
      if (current.revision !== input.expectedRevision)
        return void 0;
      const changed = this.#store.run(this.#store.queries.updateTable("tickets").set({
        phase: input.phase,
        state: input.state,
        updated_at: input.mutation.now,
        state_changed_at: input.mutation.now
      }).where("tickets.id", "=", current.id));
      if (changed.changes !== 1)
        return void 0;
      const stored = this.getWorkItem(current.id);
      if (!stored)
        throw new Error("transitioned ticket cannot be read");
      this.#emit({
        mutation: input.mutation,
        ticket: stored,
        projectId: stored.projectId,
        type: "phase_change",
        resourceType: "ticket",
        resourceId: stored.id,
        details: {
          from_phase: current.phase,
          to_phase: input.phase,
          artifacts: input.artifacts
        }
      });
      return this.getWorkItem(current.id) ?? stored;
    });
  }
  createComment(input) {
    return this.#store.transaction(() => {
      const value2 = input.comment;
      const anchor2 = value2.anchor ?? {};
      this.#store.run(this.#store.queries.insertInto("comments").values({
        id: value2.id,
        ticket_id: value2.ticketId,
        author: value2.author,
        body: value2.body,
        quote: typeof anchor2.quote === "string" ? anchor2.quote : null,
        prefix: typeof anchor2.prefix === "string" ? anchor2.prefix : null,
        suffix: typeof anchor2.suffix === "string" ? anchor2.suffix : null,
        section: typeof anchor2.section === "string" ? anchor2.section : null,
        section_id: typeof anchor2.sectionId === "string" ? anchor2.sectionId : null,
        tag: value2.tag,
        status: value2.status,
        dispatch_state: value2.dispatchState,
        parent_id: value2.parentId ?? null,
        created_at: value2.createdAt,
        updated_at: value2.updatedAt
      }));
      const ticket = this.getWorkItem(value2.ticketId);
      if (!ticket)
        throw new Error("comment ticket cannot be read");
      this.#emit({
        mutation: input.mutation,
        ...ticket ? { ticket } : {},
        projectId: ticket.projectId,
        type: value2.parentId ? "comment_replied" : "comment_created",
        resourceType: "comment",
        resourceId: value2.id,
        details: { comment_id: value2.id, parent_id: value2.parentId ?? null }
      });
      return value2;
    });
  }
  getComment(id2) {
    const row = this.#store.get(this.#store.queries.selectFrom("comments").selectAll().where("id", "=", id2));
    return row ? rowComment(row) : void 0;
  }
  updateComment(input) {
    return this.#store.transaction(() => {
      const changed = this.#store.run(this.#store.queries.updateTable("comments").set({
        ...input.patch.body === void 0 ? {} : { body: input.patch.body },
        ...input.patch.tag === void 0 ? {} : { tag: input.patch.tag },
        ...input.patch.status === void 0 ? {} : { status: input.patch.status },
        ...input.patch.dispatchState === void 0 ? {} : { dispatch_state: input.patch.dispatchState },
        updated_at: input.mutation.now
      }).where("id", "=", input.commentId).where("ticket_id", "=", input.ticketId));
      if (changed.changes !== 1)
        return void 0;
      const comment = this.getComment(input.commentId);
      const ticket = this.getWorkItem(input.ticketId);
      if (comment && ticket)
        this.#emit({
          mutation: input.mutation,
          ticket,
          projectId: ticket.projectId,
          type: "comment_updated",
          resourceType: "comment",
          resourceId: comment.id,
          details: { comment_id: comment.id }
        });
      return comment;
    });
  }
  listComments(ticketId) {
    return Object.freeze(this.#store.all(this.#store.queries.selectFrom("comments").selectAll().where("ticket_id", "=", ticketId).orderBy("created_at", "asc").orderBy("id", "asc")).map(rowComment));
  }
  createLink(input) {
    return this.#store.transaction(() => {
      const value2 = input.link;
      this.#store.run(this.#store.queries.insertInto("links").values({
        from_ticket: value2.ticketId,
        to_ticket: value2.targetTicketId,
        type: value2.relation
      }));
      const ticket = this.getWorkItem(value2.ticketId);
      if (!ticket)
        throw new Error("link ticket cannot be read");
      this.#emit({
        mutation: input.mutation,
        ticket,
        projectId: ticket.projectId,
        type: "link_created",
        resourceType: "link",
        resourceId: value2.id,
        details: {
          from_ticket: value2.ticketId,
          to_ticket: value2.targetTicketId,
          type: value2.relation
        }
      });
      return value2;
    });
  }
  deleteLink(input) {
    return this.#store.transaction(() => {
      const deleted = this.#store.run(this.#store.queries.deleteFrom("links").where("from_ticket", "=", input.ticketId).where("to_ticket", "=", input.targetTicketId).where("type", "=", input.relation));
      if (deleted.changes !== 1)
        return false;
      const ticket = this.getWorkItem(input.ticketId);
      if (ticket)
        this.#emit({
          mutation: input.mutation,
          ticket,
          projectId: ticket.projectId,
          type: "link_deleted",
          resourceType: "link",
          resourceId: `${input.ticketId}:${input.targetTicketId}:${input.relation}`,
          details: {
            from_ticket: input.ticketId,
            to_ticket: input.targetTicketId,
            type: input.relation
          }
        });
      return true;
    });
  }
  listLinks(ticketId) {
    const rows = this.#store.all(this.#store.queries.selectFrom("links").select(["from_ticket", "to_ticket", "type"]).where((eb) => eb.or([
      eb("from_ticket", "=", ticketId),
      eb("to_ticket", "=", ticketId)
    ])).orderBy("type", "asc"));
    return Object.freeze(rows.map((row) => Object.freeze({
      id: `${row.from_ticket}:${row.to_ticket}:${row.type}`,
      ticketId: row.from_ticket,
      targetTicketId: row.to_ticket,
      relation: row.type,
      actor: "legacy",
      createdAt: ""
    })));
  }
  upsertStream(input) {
    return this.#store.transaction(() => {
      const existing = this.#store.get(this.#store.queries.selectFrom("streams").select("id").where("id", "=", input.stream.id));
      const currentRevision = Number(this.#store.get(this.#store.queries.selectFrom("events").select((_eb) => sql`coalesce(max(id), 1)`.as("revision")).where(sql`json_extract(data, '$.stream_id') = ${input.stream.id}`))?.revision ?? 1);
      if (existing && input.expectedRevision !== void 0 && input.expectedRevision !== currentRevision || !existing && input.expectedRevision !== void 0)
        return void 0;
      if (existing) {
        this.#store.run(this.#store.queries.updateTable("streams").set({
          name: input.stream.name,
          mode: input.stream.mode,
          description: input.stream.description,
          updated_at: input.mutation.now
        }).where("id", "=", input.stream.id));
      } else {
        this.#store.run(this.#store.queries.insertInto("streams").values({
          id: input.stream.id,
          project_id: input.stream.projectId,
          name: input.stream.name,
          mode: input.stream.mode,
          description: input.stream.description,
          created_at: input.stream.createdAt,
          updated_at: input.mutation.now
        }));
      }
      const row = this.#store.get(this.#store.queries.selectFrom("streams").select([
        "streams.id",
        "streams.project_id",
        "streams.name",
        "streams.mode",
        "streams.description",
        "streams.created_at",
        "streams.updated_at",
        sql`coalesce((select max(id) from events where json_extract(events.data, '$.stream_id') = streams.id), 1)`.as("revision")
      ]).where("id", "=", input.stream.id));
      if (!row)
        return void 0;
      const stream = Object.freeze({
        id: row.id,
        projectId: row.project_id,
        name: row.name,
        mode: row.mode,
        description: row.description,
        revision: existing ? currentRevision + 1 : 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      });
      this.#emit({
        mutation: input.mutation,
        projectId: stream.projectId,
        revision: stream.revision,
        type: existing ? "stream_updated" : "stream_created",
        resourceType: "stream",
        resourceId: stream.id,
        details: { stream_id: stream.id }
      });
      return this.listStreams(stream.projectId).find((item) => item.id === stream.id) ?? stream;
    });
  }
  listStreams(projectId2) {
    let query = this.#store.queries.selectFrom("streams").select([
      "streams.id",
      "streams.project_id",
      "streams.name",
      "streams.mode",
      "streams.description",
      "streams.created_at",
      "streams.updated_at",
      sql`coalesce((select max(id) from events where json_extract(events.data, '$.stream_id') = streams.id), 1)`.as("revision")
    ]);
    if (projectId2 !== void 0)
      query = query.where("streams.project_id", "=", projectId2);
    const rows = this.#store.all(query.orderBy("created_at", "asc").orderBy("id", "asc"));
    return Object.freeze(rows.map((row) => Object.freeze({
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      mode: row.mode,
      description: row.description,
      revision: Number(row.revision),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    })));
  }
  auditCore() {
    const rows = this.#store.all(this.#store.queries.selectFrom("events").select([
      "id",
      "event_uuid",
      "ticket_id",
      "project_id",
      "actor",
      "actor_kind",
      "actor_label",
      "type",
      "data",
      "created_at"
    ]).where("class", "=", "tracker").where("event_uuid", "is not", null).orderBy("id", "asc"));
    return Object.freeze(rows.map((row) => {
      let details = {};
      try {
        details = JSON.parse(row.data);
      } catch {
      }
      return Object.freeze({
        id: String(details.audit_id ?? row.event_uuid ?? row.id),
        actor: row.actor ?? "system",
        action: row.type,
        resourceType: details.resource_type ?? "ticket",
        resourceId: String(details.resource_id ?? row.ticket_id ?? ""),
        revision: Number(details.revision ?? 0),
        details,
        createdAt: row.created_at
      });
    }));
  }
};

// packages/persistence/dist/types.js
var PersistenceMigrationError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "PersistenceMigrationError";
    this.code = code;
  }
};
var PersistenceOwnerConflictError = class extends Error {
  diagnostic;
  constructor(diagnostic) {
    super("persistence owner already holds the runtime lock");
    this.name = "PersistenceOwnerConflictError";
    this.diagnostic = diagnostic;
  }
};
var RuntimeFailpointError = class extends Error {
  failpoint;
  constructor(failpoint) {
    super(`runtime failpoint reached: ${failpoint}`);
    this.name = "RuntimeFailpointError";
    this.failpoint = failpoint;
  }
};

// packages/persistence/dist/index.js
var persistenceMigrations = Object.freeze({
  runtime: runtimeMigrations.map(({ id: id2, checksum }) => ({ id: id2, checksum })),
  tracker: trackerMigrations.map(({ id: id2, checksum }) => ({ id: id2, checksum }))
});

// packages/runtime/dist/inbox.js
import crypto3 from "node:crypto";
import fs2 from "node:fs";
import path2 from "node:path";

// packages/contracts/dist/api.js
import { z as z4 } from "zod";

// packages/contracts/dist/ids.js
import { z } from "zod";
var UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
function opaqueId(prefix) {
  return z.string().regex(new RegExp(`^${prefix}_${UUID_SOURCE}$`, "u"), "wire.id.invalid");
}
var ProjectIdSchema = opaqueId("prj").brand();
var LocationIdSchema = opaqueId("loc").brand();
var SessionIdSchema = opaqueId("ses").brand();
var GenerationIdSchema = opaqueId("gen").brand();
var EventIdSchema = opaqueId("evt").brand();
var CommandIdSchema = opaqueId("cmd").brand();
var EndpointIdSchema = opaqueId("ep").brand();
var ProducerIdSchema = opaqueId("prod").brand();
var ActorIdSchema = opaqueId("act").brand();
var DeliveryIdSchema = opaqueId("del").brand();
var OperationIdSchema = opaqueId("op").brand();
var MigrationPlanIdSchema = opaqueId("mig").brand();
var ControlPlaneInstanceIdSchema = opaqueId("cpi").brand();

// packages/contracts/dist/json.js
import { z as z2 } from "zod";
var JsonValueSchema = z2.json();
var JsonObjectSchema = z2.record(z2.string(), JsonValueSchema);

// packages/contracts/dist/version.js
import { z as z3 } from "zod";
var WIRE_MAJOR_VERSION = 1;
function wireVersion(schemaName) {
  return z3.literal(`golem.${schemaName}/v${WIRE_MAJOR_VERSION}`, {
    error: "wire.version.unknown_major"
  });
}
function schemaIdentifier(schemaName) {
  return `urn:golem:contracts:${schemaName}:v${WIRE_MAJOR_VERSION}`;
}

// packages/contracts/dist/api.js
var ApiErrorV1Schema = z4.object({
  schema_version: wireVersion("api-error"),
  code: z4.string().min(1).max(128),
  message: z4.string().min(1).max(1024),
  correlation_id: z4.string().min(1).max(128),
  details: JsonObjectSchema.optional()
}).strict();
var ApiCommandOutcomeStatusV1Schema = z4.enum([
  "accepted",
  "completed",
  "rejected",
  "conflict",
  "pending",
  "idempotency_mismatch"
]);
var ApiCommandOutcomeV1Schema = z4.object({
  schema_version: wireVersion("api-command-outcome"),
  command_id: CommandIdSchema,
  status: ApiCommandOutcomeStatusV1Schema,
  reason_code: z4.string().min(1).max(128).optional(),
  operation_id: OperationIdSchema.optional(),
  result: JsonValueSchema.optional()
}).strict();
var ApiPageV1Schema = z4.object({
  schema_version: wireVersion("api-page"),
  items: z4.array(JsonValueSchema),
  next_cursor: z4.string().min(1).max(512).nullable(),
  total: z4.number().int().nonnegative().optional()
}).strict();
var CommandReceiptV1Schema = z4.object({
  schema_version: wireVersion("command-receipt"),
  command_id: CommandIdSchema,
  idempotency_key: z4.string().min(1).max(256),
  command_kind: z4.string().min(1).max(128),
  actor_id: z4.string().min(1).max(256),
  project_id: z4.string().min(1).max(256),
  resource_type: z4.string().min(1).max(64),
  resource_id: z4.string().min(1).max(256),
  correlation_id: z4.string().min(1).max(128),
  fingerprint: z4.string().min(1).max(128),
  outcome: ApiCommandOutcomeV1Schema,
  committed_at: z4.string().min(1).max(64)
}).strict();
var CommandFingerprintInputV1Schema = z4.object({
  command_kind: z4.string().min(1).max(128),
  project_id: z4.string().min(1).max(256),
  resource_type: z4.string().min(1).max(64),
  resource_id: z4.string().min(1).max(256),
  payload: JsonValueSchema
}).strict();

// packages/contracts/dist/browser-settings.js
import { z as z5 } from "zod";
var BrowserSettingsTimestampSchema = z5.iso.datetime({ offset: true });
var BrowserSettingsTextSchema = z5.string().min(1).max(512);
var BrowserSettingsPlanHashSchema = z5.string().regex(/^sha256:[a-f0-9]{64}$/u);
var BrowserSettingsHarnessSchema = z5.enum([
  "claude",
  "codex",
  "opencode",
  "pi"
]);
var BrowserSettingsBackendSchema = z5.enum([
  "openai",
  "anthropic",
  "ollama_local",
  "ollama_cloud",
  "native"
]);
var BrowserSettingsDeliveryModeSchema = z5.enum([
  "pull",
  "native_channel",
  "prompt_bridge",
  "managed_app_server",
  "next_turn"
]);
var BrowserSettingsTargetSchema = z5.enum([
  "cc",
  "cc-marketplace",
  "codex",
  "opencode",
  "pi"
]);
var BrowserSettingsProviderSchema = z5.enum([
  "openai",
  "ollama_cloud",
  "ollama_local"
]);
var BrowserSettingsServiceActionSchema = z5.enum([
  "start",
  "stop",
  "restart",
  "install",
  "update",
  "rollback"
]);
var BrowserSettingsServiceSchema = z5.object({
  installed: z5.boolean(),
  process: z5.enum(["running", "stopped", "unknown"]),
  api: z5.enum(["ready", "unavailable"]),
  delivery: z5.enum([
    "ready",
    "held",
    "pull_only",
    "next_turn",
    "unavailable"
  ]),
  actions: z5.array(BrowserSettingsServiceActionSchema).max(6)
}).strict();
var BrowserSettingsRenderSchema = z5.object({
  target: BrowserSettingsTargetSchema,
  status: z5.enum(["clean", "drift", "tamper", "missing", "error"]),
  version: z5.string().min(1).max(128).optional(),
  managed_files: z5.array(z5.string().min(1).max(256)).max(500),
  rollback_available: z5.boolean()
}).strict();
var BrowserSettingsCapabilitySchema = z5.object({
  opaque_id: z5.string().min(1).max(128),
  harness: BrowserSettingsHarnessSchema,
  backend: BrowserSettingsBackendSchema,
  model_pattern: z5.string().min(1).max(256),
  binary: z5.enum(["available", "unavailable"]),
  provider: z5.enum(["configured", "unconfigured", "not_applicable"]),
  model: z5.enum(["supported", "experimental", "unknown", "unsupported"]),
  qualification: z5.enum([
    "supported",
    "experimental",
    "unknown",
    "unsupported",
    "stale",
    "registration_only",
    "invalid_evidence"
  ]),
  endpoint: z5.enum(["healthy", "degraded", "absent"]),
  delivery: z5.enum([
    "ready",
    "not_ready",
    "ineligible",
    "pull_only",
    "next_turn"
  ]),
  evidence_version: z5.string().min(1).max(128).optional(),
  evidence_at: BrowserSettingsTimestampSchema.optional(),
  remedy: BrowserSettingsTextSchema
}).strict();
var BrowserSettingsPresetSchema = z5.object({
  name: z5.string().min(1).max(64),
  harness: BrowserSettingsHarnessSchema,
  backend: BrowserSettingsBackendSchema,
  model_selector: z5.string().min(1).max(256),
  source: z5.enum(["built_in", "user"])
}).strict();
var BrowserSettingsProviderSchemaView = z5.object({
  provider: BrowserSettingsProviderSchema,
  configured: z5.boolean(),
  qualification: z5.enum([
    "supported",
    "experimental",
    "unknown",
    "unsupported"
  ]),
  delivery_ready: z5.boolean(),
  rollback_available: z5.boolean()
}).strict();
var BrowserSettingsMigrationSchema = z5.object({
  status: z5.enum([
    "not_planned",
    "ready",
    "review_required",
    "applied",
    "rolled_back",
    "failed"
  ]),
  plan_hash: BrowserSettingsPlanHashSchema.optional(),
  create: z5.number().int().nonnegative(),
  attach: z5.number().int().nonnegative(),
  review: z5.number().int().nonnegative(),
  quarantine: z5.number().int().nonnegative(),
  backup_available: z5.boolean(),
  rollback_available: z5.boolean()
}).strict();
var BrowserSettingsCutoverSchema = z5.object({
  status: z5.enum([
    "not_ready",
    "ready",
    "blocked",
    "quiesced",
    "checkpointed",
    "soaking",
    "stable",
    "rollback_required",
    "rolled_back",
    "failed"
  ]),
  plan_hash: BrowserSettingsPlanHashSchema.optional(),
  canonical_revision: z5.number().int().nonnegative(),
  failed_gates: z5.array(z5.string().min(1).max(128)).max(32),
  rollback_available: z5.boolean()
}).strict();
var BrowserSettingsAuditSchema = z5.object({
  command_id: z5.string().min(1).max(128),
  command_kind: z5.string().min(1).max(128),
  status: z5.enum(["pending", "completed", "rejected", "failed"]),
  created_at: BrowserSettingsTimestampSchema,
  completed_at: BrowserSettingsTimestampSchema.optional()
}).strict();
var BrowserSettingsSnapshotSchema = z5.object({
  schema_version: z5.literal("golem.browser-settings/v1"),
  revision: z5.number().int().nonnegative(),
  service: BrowserSettingsServiceSchema,
  renders: z5.array(BrowserSettingsRenderSchema).max(5),
  capabilities: z5.array(BrowserSettingsCapabilitySchema).max(100),
  providers: z5.array(BrowserSettingsProviderSchemaView).max(3),
  presets: z5.array(BrowserSettingsPresetSchema).max(100),
  migration: BrowserSettingsMigrationSchema,
  cutover: BrowserSettingsCutoverSchema,
  unknown_config_keys_preserved: z5.boolean(),
  unknown_config_key_count: z5.number().int().nonnegative().max(1e4),
  audit: z5.array(BrowserSettingsAuditSchema).max(50)
}).strict();
var BrowserSettingsCommandBaseSchema = z5.object({
  idempotency_key: z5.string().min(1).max(256)
});
var BrowserSettingsConfirmedSchema = z5.object({
  plan_hash: BrowserSettingsPlanHashSchema,
  confirm: z5.literal(true)
});
var BrowserSettingsPresetInputSchema = z5.object({
  name: z5.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
  harness: BrowserSettingsHarnessSchema,
  backend: BrowserSettingsBackendSchema,
  model_selector: z5.string().min(1).max(256),
  delivery_mode: BrowserSettingsDeliveryModeSchema
}).strict();
var BrowserSettingsCommandRequestSchema = z5.discriminatedUnion("kind", [
  BrowserSettingsCommandBaseSchema.extend({
    kind: z5.literal("render.preview"),
    target: BrowserSettingsTargetSchema
  }).strict(),
  BrowserSettingsCommandBaseSchema.merge(BrowserSettingsConfirmedSchema).extend({
    kind: z5.literal("render.apply"),
    target: BrowserSettingsTargetSchema
  }).strict(),
  BrowserSettingsCommandBaseSchema.extend({
    kind: z5.literal("render.rollback"),
    target: BrowserSettingsTargetSchema,
    confirm: z5.literal(true)
  }).strict(),
  BrowserSettingsCommandBaseSchema.extend({
    kind: z5.literal("service.preview"),
    action: BrowserSettingsServiceActionSchema
  }).strict(),
  BrowserSettingsCommandBaseSchema.merge(BrowserSettingsConfirmedSchema).extend({
    kind: z5.literal("service.apply"),
    action: BrowserSettingsServiceActionSchema
  }).strict(),
  BrowserSettingsCommandBaseSchema.extend({
    kind: z5.literal("provider.preview"),
    provider: BrowserSettingsProviderSchema
  }).strict(),
  BrowserSettingsCommandBaseSchema.merge(BrowserSettingsConfirmedSchema).extend({
    kind: z5.literal("provider.apply"),
    provider: BrowserSettingsProviderSchema
  }).strict(),
  BrowserSettingsCommandBaseSchema.extend({
    kind: z5.literal("provider.rollback"),
    provider: BrowserSettingsProviderSchema,
    confirm: z5.literal(true)
  }).strict(),
  BrowserSettingsCommandBaseSchema.extend({
    kind: z5.literal("preset.preview"),
    preset: BrowserSettingsPresetInputSchema
  }).strict(),
  BrowserSettingsCommandBaseSchema.merge(BrowserSettingsConfirmedSchema).extend({
    kind: z5.literal("preset.apply"),
    preset: BrowserSettingsPresetInputSchema
  }).strict(),
  BrowserSettingsCommandBaseSchema.extend({
    kind: z5.literal("preset.rollback"),
    confirm: z5.literal(true)
  }).strict(),
  BrowserSettingsCommandBaseSchema.extend({
    kind: z5.literal("migration.preview")
  }).strict(),
  BrowserSettingsCommandBaseSchema.merge(BrowserSettingsConfirmedSchema).extend({
    kind: z5.literal("migration.apply")
  }).strict(),
  BrowserSettingsCommandBaseSchema.extend({
    kind: z5.literal("migration.rollback"),
    confirm: z5.literal(true)
  }).strict(),
  BrowserSettingsCommandBaseSchema.extend({
    kind: z5.literal("cutover.preview")
  }).strict(),
  BrowserSettingsCommandBaseSchema.merge(BrowserSettingsConfirmedSchema).extend({
    kind: z5.literal("cutover.apply")
  }).strict(),
  BrowserSettingsCommandBaseSchema.extend({
    kind: z5.literal("cutover.soak"),
    confirm: z5.literal(true)
  }).strict(),
  BrowserSettingsCommandBaseSchema.extend({
    kind: z5.literal("cutover.rollback"),
    confirm: z5.literal(true)
  }).strict()
]);
var BrowserSettingsCommandResultSchema = z5.object({
  command_kind: z5.string().min(1).max(128),
  outcome: z5.enum(["previewed", "applied", "rolled_back"]),
  summary: BrowserSettingsTextSchema,
  plan_hash: BrowserSettingsPlanHashSchema.optional(),
  changed: z5.boolean(),
  affected: z5.array(z5.string().min(1).max(256)).max(500),
  rollback_available: z5.boolean(),
  snapshot_revision: z5.number().int().nonnegative()
}).strict();
var BrowserSettingsCommandResponseSchema = z5.object({
  schema_version: z5.literal("golem.browser-settings-command/v1"),
  command_id: z5.string().min(1).max(128),
  status: z5.enum(["pending", "completed"]),
  result: BrowserSettingsCommandResultSchema.optional()
}).strict();
var BrowserSettingsErrorSchema = z5.object({
  schema_version: z5.literal("golem.browser-settings-error/v1"),
  code: z5.enum([
    "browser.auth.required",
    "browser.forbidden",
    "browser.settings.invalid",
    "browser.settings.conflict",
    "browser.settings.unavailable",
    "command.idempotency_mismatch"
  ]),
  correlation_id: z5.string().min(1).max(128)
}).strict();

// packages/contracts/dist/browser-work.js
import { z as z6 } from "zod";
var BrowserOpaqueIdSchema = z6.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u).max(128);
var BrowserTimestampSchema = z6.iso.datetime({ offset: true });
var BrowserTicketKindSchema = z6.enum([
  "work-item",
  "spec",
  "question",
  "decision",
  "fix"
]);
var BrowserTicketStateSchema = z6.enum([
  "todo",
  "in_progress",
  "blocked",
  "review",
  "done",
  "archived"
]);
var BrowserTicketPrioritySchema = z6.enum(["P0", "P1", "P2", "P3"]);
var BrowserTitleSchema = z6.string().min(1).max(256);
var BrowserBodySchema = z6.string().max(16384);
var BrowserLabelSchema = z6.string().min(1).max(64);
var BrowserPhaseSchema = z6.string().min(1).max(64);
var BrowserOperationStatusSchema = z6.enum([
  "queued",
  "ineligible",
  "delivered"
]);
var BrowserWorkStreamSchema = z6.enum([
  "tracker.board",
  "tracker.tree",
  "management.controls",
  "communication.operations"
]);
var BrowserWorkProjectionCursorSchema = z6.string().regex(/^bwp_[0-9]{1,8}$/u).max(12);
var BrowserWorkProjectionQuerySchema = z6.object({ cursor: BrowserWorkProjectionCursorSchema.optional() }).strict();
var BrowserWorkTicketSchema = z6.object({
  opaque_id: BrowserOpaqueIdSchema,
  kind: BrowserTicketKindSchema,
  title: BrowserTitleSchema,
  state: BrowserTicketStateSchema,
  phase: BrowserPhaseSchema,
  priority: BrowserTicketPrioritySchema.nullable(),
  labels: z6.array(BrowserLabelSchema).max(32),
  parent_opaque_id: BrowserOpaqueIdSchema.optional(),
  stream_opaque_id: BrowserOpaqueIdSchema.optional(),
  wave: z6.number().int().positive().max(1e4).optional(),
  legal_phases: z6.array(BrowserPhaseSchema).max(16),
  has_assignee: z6.boolean(),
  revision: z6.number().int().positive(),
  updated_at: BrowserTimestampSchema
}).strict();
var BrowserWorkTreeTicketSchema = BrowserWorkTicketSchema;
var BrowserWorkRoleSchema = z6.object({
  opaque_id: BrowserOpaqueIdSchema,
  name: z6.string().min(1).max(128),
  scope: z6.enum(["project", "session", "generation"]),
  revision: z6.number().int().positive(),
  updated_at: BrowserTimestampSchema
}).strict();
var BrowserWorkGateSchema = z6.object({
  opaque_id: BrowserOpaqueIdSchema,
  gate_kind: z6.enum(["approval", "input"]),
  status: z6.enum(["awaiting", "approved", "denied", "cancelled"]),
  question: z6.string().min(1).max(4096),
  assignee_kind: z6.enum(["human", "operator"]),
  updated_at: BrowserTimestampSchema
}).strict();
var BrowserWorkIdeaSchema = z6.object({
  opaque_id: BrowserOpaqueIdSchema,
  body: BrowserBodySchema,
  status: z6.enum(["pending", "popped", "promoted"]),
  promoted_ticket_opaque_id: BrowserOpaqueIdSchema.optional(),
  created_at: BrowserTimestampSchema,
  updated_at: BrowserTimestampSchema
}).strict();
var BrowserWorkAssetMetadataSchema = z6.object({
  opaque_id: BrowserOpaqueIdSchema,
  mime_type: z6.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  byte_size: z6.number().int().positive().max(10 * 1024 * 1024),
  created_at: BrowserTimestampSchema
}).strict();
var BrowserWorkCommentSchema = z6.object({
  opaque_id: BrowserOpaqueIdSchema,
  parent_opaque_id: BrowserOpaqueIdSchema.optional(),
  author_kind: z6.enum(["human", "session", "system"]),
  body: BrowserBodySchema,
  tag: z6.string().min(1).max(64),
  status: z6.string().min(1).max(64),
  revision: z6.number().int().positive(),
  created_at: BrowserTimestampSchema,
  updated_at: BrowserTimestampSchema
}).strict();
var BrowserWorkLinkSchema = z6.object({
  opaque_id: BrowserOpaqueIdSchema,
  target_opaque_id: BrowserOpaqueIdSchema,
  relation: z6.enum(["blocks", "relates", "duplicates"]),
  created_at: BrowserTimestampSchema.optional()
}).strict();
var BrowserWorkTrackerStreamSchema = z6.object({
  opaque_id: BrowserOpaqueIdSchema,
  name: z6.string().min(1).max(256),
  mode: z6.enum(["sequential", "parallel"]),
  description: z6.string().max(4096),
  revision: z6.number().int().positive(),
  updated_at: BrowserTimestampSchema
}).strict();
var BrowserWorkManagementOperationSchema = z6.object({
  opaque_id: BrowserOpaqueIdSchema,
  operation_kind: z6.enum(["chat", "brief", "interrupt", "halt", "control"]),
  status: BrowserOperationStatusSchema,
  created_at: BrowserTimestampSchema,
  updated_at: BrowserTimestampSchema
}).strict();
var BrowserWorkDispatchOperationSchema = z6.object({
  opaque_id: BrowserOpaqueIdSchema,
  operation_kind: z6.literal("dispatch"),
  subject_opaque_id: BrowserOpaqueIdSchema,
  disposition: z6.enum([
    "queued",
    "pull_only",
    "next_turn",
    "ineligible",
    "stale"
  ]),
  capability: z6.literal("delivery").optional(),
  remediation: z6.enum(["await_delivery", "await_next_turn", "refresh_ticket"]).optional(),
  settlement: z6.enum([
    "pending",
    "delivered",
    "settled",
    "retrying",
    "failed",
    "expired",
    "cancelled"
  ]).optional(),
  created_at: BrowserTimestampSchema
}).strict();
var BrowserWorkOperationSchema = z6.union([
  BrowserWorkManagementOperationSchema,
  BrowserWorkDispatchOperationSchema
]);
var BrowserWorkProjectionBaseSchema = z6.object({
  schema_version: z6.literal("golem.browser-work-projection/v1"),
  resource_revision: z6.number().int().nonnegative(),
  next_cursor: BrowserWorkProjectionCursorSchema.nullable()
}).strict();
var BrowserWorkBoardProjectionSchema = BrowserWorkProjectionBaseSchema.extend({
  stream: z6.literal("tracker.board"),
  items: z6.array(BrowserWorkTicketSchema).max(100)
}).strict();
var BrowserWorkTreeProjectionSchema = BrowserWorkProjectionBaseSchema.extend({
  stream: z6.literal("tracker.tree"),
  items: z6.array(BrowserWorkTreeTicketSchema).max(100)
}).strict();
var BrowserWorkManagementProjectionSchema = BrowserWorkProjectionBaseSchema.extend({
  stream: z6.literal("management.controls"),
  items: z6.array(BrowserWorkManagementOperationSchema).max(100),
  roles: z6.array(BrowserWorkRoleSchema).max(100),
  gates: z6.array(BrowserWorkGateSchema).max(100),
  ideas: z6.array(BrowserWorkIdeaSchema).max(100)
}).strict();
var BrowserWorkCommunicationProjectionSchema = BrowserWorkProjectionBaseSchema.extend({
  stream: z6.literal("communication.operations"),
  items: z6.array(BrowserWorkOperationSchema).max(100)
}).strict();
var BrowserWorkProjectionResponseSchema = z6.discriminatedUnion("stream", [
  BrowserWorkBoardProjectionSchema,
  BrowserWorkTreeProjectionSchema,
  BrowserWorkManagementProjectionSchema,
  BrowserWorkCommunicationProjectionSchema
]);
var BrowserWorkInvalidationSchema = z6.object({
  kind: z6.literal("invalidation"),
  category: z6.enum(["tracker", "management", "communication"])
}).strict();
var BrowserWorkCursorSchema = z6.string().min(1).max(512);
var BrowserWorkResyncPayloadSchema = z6.object({
  kind: z6.literal("resync_required"),
  reason: z6.enum([
    "instance_changed",
    "cursor_gap",
    "cursor_compacted",
    "policy_changed",
    "protocol_mismatch"
  ]),
  snapshot_url: z6.string().url().max(2048)
}).strict();
var BrowserWorkFrameBaseSchema = z6.object({
  schema_version: wireVersion("browser-work-websocket-frame"),
  instance_id: ControlPlaneInstanceIdSchema,
  sequence: z6.number().int().nonnegative(),
  resource_revision: z6.number().int().nonnegative(),
  correlation_id: z6.string().min(1).max(128)
}).strict();
var BrowserWorkBoardWebSocketFrameSchema = BrowserWorkFrameBaseSchema.extend({
  stream: z6.literal("tracker.board"),
  payload: z6.discriminatedUnion("kind", [
    z6.object({
      kind: z6.literal("snapshot"),
      cursor: BrowserWorkCursorSchema,
      payload: BrowserWorkBoardProjectionSchema
    }).strict(),
    z6.object({
      kind: z6.literal("delta"),
      cursor: BrowserWorkCursorSchema,
      delta: BrowserWorkInvalidationSchema.extend({
        category: z6.literal("tracker")
      }).strict()
    }).strict(),
    BrowserWorkResyncPayloadSchema
  ])
}).strict();
var BrowserWorkTreeWebSocketFrameSchema = BrowserWorkFrameBaseSchema.extend({
  stream: z6.literal("tracker.tree"),
  payload: z6.discriminatedUnion("kind", [
    z6.object({
      kind: z6.literal("snapshot"),
      cursor: BrowserWorkCursorSchema,
      payload: BrowserWorkTreeProjectionSchema
    }).strict(),
    z6.object({
      kind: z6.literal("delta"),
      cursor: BrowserWorkCursorSchema,
      delta: BrowserWorkInvalidationSchema.extend({
        category: z6.literal("tracker")
      }).strict()
    }).strict(),
    BrowserWorkResyncPayloadSchema
  ])
}).strict();
var BrowserWorkManagementWebSocketFrameSchema = BrowserWorkFrameBaseSchema.extend({
  stream: z6.literal("management.controls"),
  payload: z6.discriminatedUnion("kind", [
    z6.object({
      kind: z6.literal("snapshot"),
      cursor: BrowserWorkCursorSchema,
      payload: BrowserWorkManagementProjectionSchema
    }).strict(),
    z6.object({
      kind: z6.literal("delta"),
      cursor: BrowserWorkCursorSchema,
      delta: BrowserWorkInvalidationSchema.extend({
        category: z6.literal("management")
      }).strict()
    }).strict(),
    BrowserWorkResyncPayloadSchema
  ])
}).strict();
var BrowserWorkCommunicationWebSocketFrameSchema = BrowserWorkFrameBaseSchema.extend({
  stream: z6.literal("communication.operations"),
  payload: z6.discriminatedUnion("kind", [
    z6.object({
      kind: z6.literal("snapshot"),
      cursor: BrowserWorkCursorSchema,
      payload: BrowserWorkCommunicationProjectionSchema
    }).strict(),
    z6.object({
      kind: z6.literal("delta"),
      cursor: BrowserWorkCursorSchema,
      delta: BrowserWorkInvalidationSchema.extend({
        category: z6.literal("communication")
      }).strict()
    }).strict(),
    BrowserWorkResyncPayloadSchema
  ])
}).strict();
var BrowserWorkWebSocketFrameSchema = z6.discriminatedUnion("stream", [
  BrowserWorkBoardWebSocketFrameSchema,
  BrowserWorkTreeWebSocketFrameSchema,
  BrowserWorkManagementWebSocketFrameSchema,
  BrowserWorkCommunicationWebSocketFrameSchema
]);
var BrowserWorkDetailResponseSchema = z6.object({
  schema_version: z6.literal("golem.browser-work-detail/v1"),
  item: BrowserWorkTicketSchema,
  body: BrowserBodySchema,
  comments: z6.array(BrowserWorkCommentSchema).max(500),
  links: z6.array(BrowserWorkLinkSchema).max(200),
  children: z6.array(BrowserWorkTicketSchema).max(200),
  streams: z6.array(BrowserWorkTrackerStreamSchema).max(100),
  assets: z6.array(BrowserWorkAssetMetadataSchema).max(100)
}).strict();
var BrowserWorkAssetResponseSchema = z6.object({
  schema_version: z6.literal("golem.browser-work-asset/v1"),
  asset: BrowserWorkAssetMetadataSchema,
  content_base64: z6.string().min(1).max(14e6)
}).strict();
var BrowserWorkCommandBaseSchema = z6.object({
  idempotency_key: z6.string().min(1).max(256)
});
var BrowserWorkCommandRequestSchema = z6.discriminatedUnion("kind", [
  BrowserWorkCommandBaseSchema.extend({
    kind: z6.literal("ticket.create"),
    ticket_kind: BrowserTicketKindSchema.optional(),
    title: BrowserTitleSchema,
    body: BrowserBodySchema.optional(),
    priority: BrowserTicketPrioritySchema.optional(),
    labels: z6.array(BrowserLabelSchema).max(32).optional(),
    parent_opaque_id: BrowserOpaqueIdSchema.optional(),
    stream_opaque_id: BrowserOpaqueIdSchema.optional(),
    wave: z6.number().int().positive().max(1e4).optional()
  }).strict(),
  BrowserWorkCommandBaseSchema.extend({
    kind: z6.literal("ticket.update"),
    opaque_id: BrowserOpaqueIdSchema,
    expected_revision: z6.number().int().positive(),
    title: BrowserTitleSchema.optional(),
    body: BrowserBodySchema.optional(),
    priority: BrowserTicketPrioritySchema.optional(),
    labels: z6.array(BrowserLabelSchema).max(32).optional(),
    parent_opaque_id: BrowserOpaqueIdSchema.optional(),
    stream_opaque_id: BrowserOpaqueIdSchema.optional(),
    wave: z6.number().int().positive().max(1e4).optional()
  }).strict(),
  BrowserWorkCommandBaseSchema.extend({
    kind: z6.literal("ticket.transition"),
    opaque_id: BrowserOpaqueIdSchema,
    expected_revision: z6.number().int().positive(),
    phase: BrowserPhaseSchema,
    reason: z6.string().min(1).max(1024).optional()
  }).strict(),
  BrowserWorkCommandBaseSchema.extend({
    kind: z6.literal("comment.create"),
    opaque_id: BrowserOpaqueIdSchema,
    parent_comment_opaque_id: BrowserOpaqueIdSchema.optional(),
    body: BrowserBodySchema.pipe(z6.string().min(1))
  }).strict(),
  BrowserWorkCommandBaseSchema.extend({
    kind: z6.literal("link.create"),
    opaque_id: BrowserOpaqueIdSchema,
    target_opaque_id: BrowserOpaqueIdSchema,
    relation: z6.enum(["blocks", "relates", "duplicates"])
  }).strict(),
  BrowserWorkCommandBaseSchema.extend({
    kind: z6.literal("stream.create"),
    name: z6.string().min(1).max(256),
    mode: z6.enum(["sequential", "parallel"]),
    description: z6.string().max(4096).optional()
  }).strict(),
  BrowserWorkCommandBaseSchema.extend({
    kind: z6.literal("management.gate.create"),
    gate_kind: z6.enum(["approval", "input"]),
    question: z6.string().min(1).max(512),
    assignee: z6.string().min(1).max(128)
  }).strict(),
  BrowserWorkCommandBaseSchema.extend({
    kind: z6.literal("management.role.assign"),
    role_opaque_id: BrowserOpaqueIdSchema
  }).strict(),
  BrowserWorkCommandBaseSchema.extend({
    kind: z6.literal("management.idea.create"),
    body: BrowserBodySchema.pipe(z6.string().min(1))
  }).strict(),
  BrowserWorkCommandBaseSchema.extend({
    kind: z6.literal("management.idea.pop"),
    idea_opaque_id: BrowserOpaqueIdSchema
  }).strict(),
  BrowserWorkCommandBaseSchema.extend({
    kind: z6.literal("management.idea.promote"),
    idea_opaque_id: BrowserOpaqueIdSchema,
    title: BrowserTitleSchema.optional()
  }).strict(),
  BrowserWorkCommandBaseSchema.extend({
    kind: z6.literal("dispatch"),
    opaque_id: BrowserOpaqueIdSchema,
    expected_revision: z6.number().int().positive()
  }).strict()
]);
var BrowserWorkCommandResultSchema = z6.discriminatedUnion("kind", [
  z6.object({ kind: z6.literal("ticket"), ticket: BrowserWorkTicketSchema }).strict(),
  z6.object({
    kind: z6.literal("comment"),
    comment: BrowserWorkCommentSchema
  }).strict(),
  z6.object({ kind: z6.literal("link"), link: BrowserWorkLinkSchema }).strict(),
  z6.object({
    kind: z6.literal("stream"),
    stream: BrowserWorkTrackerStreamSchema
  }).strict(),
  z6.object({
    kind: z6.literal("gate"),
    opaque_id: BrowserOpaqueIdSchema,
    status: z6.enum(["awaiting", "approved", "denied", "cancelled"]),
    updated_at: BrowserTimestampSchema
  }).strict(),
  z6.object({
    kind: z6.literal("role_assignment"),
    role_opaque_id: BrowserOpaqueIdSchema,
    assigned_at: BrowserTimestampSchema
  }).strict(),
  z6.object({ kind: z6.literal("idea"), idea: BrowserWorkIdeaSchema }).strict(),
  z6.object({
    kind: z6.literal("dispatch"),
    disposition: z6.enum([
      "queued",
      "pull_only",
      "next_turn",
      "ineligible",
      "stale"
    ]),
    /** The durable GOL-79 command id, never an endpoint or target id. */
    operation_id: BrowserOpaqueIdSchema,
    capability: z6.enum(["delivery"]).optional(),
    remediation: z6.enum(["await_delivery", "await_next_turn", "refresh_ticket"]).optional()
  }).strict()
]);
var BrowserWorkCommandResponseSchema = z6.object({
  schema_version: z6.literal("golem.browser-work-command/v1"),
  command_id: z6.string().min(1).max(128),
  status: z6.enum([
    "completed",
    "rejected",
    "conflict",
    "idempotency_mismatch"
  ]),
  resource_revision: z6.number().int().nonnegative(),
  result: BrowserWorkCommandResultSchema
}).strict();
var BrowserWorkErrorSchema = z6.object({
  schema_version: z6.literal("golem.browser-work-error/v1"),
  code: z6.enum([
    "browser.auth.required",
    "browser.forbidden",
    "browser.work.invalid",
    "browser.work.not_found",
    "browser-work.dispatch.unsupported",
    "tracker.revision.required",
    "tracker.conflict",
    "tracker.not_found",
    "tracker.phase.invalid",
    "tracker.input.invalid",
    "tracker.runtime_reference.invalid",
    "management.invalid",
    "management.not_found",
    "management.forbidden",
    "management.conflict",
    "management.asset_invalid",
    "command.idempotency_mismatch"
  ]),
  correlation_id: z6.string().min(1).max(128)
}).strict();

// packages/contracts/dist/common.js
import { z as z7 } from "zod";
var HarnessSchema = z7.enum(["claude", "codex", "opencode", "pi"]);
var LifecycleStateSchema = z7.enum([
  "starting",
  "idle",
  "active",
  "waiting",
  "ending",
  "ended",
  "errored",
  "superseded"
]);
var EndpointRouteStateSchema = z7.enum([
  "claiming",
  "healthy",
  "degraded",
  "released",
  "expired",
  "superseded"
]);
var DeliveryReadinessSchema = z7.enum([
  "ready",
  "held_busy",
  "held_waiting",
  "pull_only",
  "next_turn",
  "unsupported",
  "unhealthy",
  "uninitialized"
]);
var DeliveryModeSchema = z7.enum([
  "pull",
  "native_channel",
  "prompt_bridge",
  "managed_app_server",
  "next_turn"
]);
var TimestampSchema = z7.iso.datetime({ offset: true });
var ProjectReferenceBodySchema = z7.object({ project_id: ProjectIdSchema }).strict();
var ProjectLocationReferenceBodySchema = z7.object({
  project_id: ProjectIdSchema,
  location_id: LocationIdSchema,
  relation: z7.enum(["main", "worktree", "registered", "legacy"]),
  canonical_path: z7.string().min(1).max(4096),
  observed_path: z7.string().min(1).max(4096).optional()
}).strict();
var SessionReferenceBodySchema = z7.object({
  project_id: ProjectIdSchema,
  session_id: SessionIdSchema
}).strict();
var GenerationReferenceBodySchema = z7.object({
  project_id: ProjectIdSchema,
  session_id: SessionIdSchema,
  generation_id: GenerationIdSchema
}).strict();
var AliasReferenceBodySchema = z7.object({
  project_id: ProjectIdSchema,
  harness: HarnessSchema,
  alias_kind: z7.enum([
    "native_conversation",
    "native_run",
    "legacy_canonical_id",
    "supervisor_thread",
    "bridge_session",
    "migration_relation"
  ]),
  alias: z7.string().min(1).max(512),
  producer_id: ProducerIdSchema.optional(),
  session: SessionReferenceBodySchema.optional()
}).strict().superRefine((value2, context) => {
  if (value2.session && value2.session.project_id !== value2.project_id) {
    context.addIssue({
      code: "custom",
      message: "wire.alias.cross_scope",
      path: ["session", "project_id"]
    });
  }
});
var ActorReferenceBodySchema = z7.object({
  actor_id: ActorIdSchema,
  kind: z7.enum(["human", "service", "adapter", "session"]),
  display_name: z7.string().min(1).max(160).optional()
}).strict();
var ProducerReferenceBodySchema = z7.object({
  producer: z7.string().min(1).max(128),
  producer_instance_id: ProducerIdSchema,
  harness: HarnessSchema
}).strict();
var ClockFactsBodySchema = z7.object({
  source_observed_at: TimestampSchema,
  source_event_at: TimestampSchema.optional(),
  received_at: TimestampSchema,
  materialized_at: TimestampSchema.optional()
}).strict().superRefine((value2, context) => {
  const observedAt = Date.parse(value2.source_observed_at);
  const receivedAt = Date.parse(value2.received_at);
  const sourceEventAt = value2.source_event_at ? Date.parse(value2.source_event_at) : null;
  const materializedAt = value2.materialized_at ? Date.parse(value2.materialized_at) : null;
  if (observedAt > receivedAt) {
    context.addIssue({
      code: "custom",
      message: "wire.clock.observed_after_received",
      path: ["received_at"]
    });
  }
  if (sourceEventAt !== null && sourceEventAt > receivedAt) {
    context.addIssue({
      code: "custom",
      message: "wire.clock.source_after_received",
      path: ["received_at"]
    });
  }
  if (materializedAt !== null && materializedAt < receivedAt) {
    context.addIssue({
      code: "custom",
      message: "wire.clock.materialized_before_received",
      path: ["materialized_at"]
    });
  }
});
var ProvenanceBodySchema = z7.object({
  source: z7.enum([
    "adapter",
    "api",
    "launcher",
    "legacy_import",
    "migration"
  ]),
  evidence_id: z7.string().min(1).max(256).optional(),
  confidence: z7.enum(["verified", "observed", "inferred", "legacy"])
}).strict();
var EndpointReferenceBodySchema = z7.object({
  endpoint_id: EndpointIdSchema,
  generation: GenerationReferenceBodySchema
}).strict();

// packages/contracts/dist/control.js
import { z as z9 } from "zod";

// packages/contracts/dist/launcher.js
import { z as z8 } from "zod";
var SecretInlineValuePattern = /(?:api[_-]?key|token|secret|password|credential)\s*=/iu;
var SecretArgumentNamePattern = /^--?(?:api[_-]?key|token|secret|password|credential)(?:=|$)/iu;
function rejectSecretArguments(value2, context) {
  for (const [index, argument] of value2.native_args.entries()) {
    if (SecretArgumentNamePattern.test(argument)) {
      context.addIssue({
        code: "custom",
        message: argument.includes("=") ? "config.secret_value.forbidden" : "config.secret_argument.forbidden",
        path: ["native_args", index]
      });
      const splitValue = value2.native_args[index + 1];
      if (!argument.includes("=") && splitValue && !splitValue.startsWith("-")) {
        context.addIssue({
          code: "custom",
          message: "config.secret_value.forbidden",
          path: ["native_args", index + 1]
        });
      }
      continue;
    }
    if (SecretInlineValuePattern.test(argument)) {
      context.addIssue({
        code: "custom",
        message: "config.secret_value.forbidden",
        path: ["native_args", index]
      });
    }
  }
}
var LauncherPresetBodySchema = z8.object({
  name: z8.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9-]*$/u),
  harness: HarnessSchema,
  backend: z8.enum([
    "openai",
    "anthropic",
    "ollama_local",
    "ollama_cloud",
    "native"
  ]),
  model_selector: z8.string().min(1).max(256),
  delivery_mode: DeliveryModeSchema,
  native_args: z8.array(z8.string().min(1).max(1024)).max(32),
  env_key_refs: z8.array(z8.string().regex(/^[A-Z][A-Z0-9_]*$/u, "config.env_key_ref.invalid")).max(16),
  binary_override: z8.string().min(1).max(4096).optional()
}).strict().superRefine(rejectSecretArguments);
var LauncherPresetSchema = z8.object({
  schema_version: wireVersion("launcher-preset"),
  ...LauncherPresetBodySchema.shape
}).strict().superRefine(rejectSecretArguments);
var HarnessDefaultsSchema = z8.object({
  claude: z8.string().min(1).max(128).optional(),
  codex: z8.string().min(1).max(128).optional(),
  opencode: z8.string().min(1).max(128).optional(),
  pi: z8.string().min(1).max(128).optional()
}).strict();
var LauncherConfigV1Schema = z8.object({
  schema_version: wireVersion("launcher-config"),
  launch: z8.object({
    harness_defaults: HarnessDefaultsSchema,
    presets: z8.array(LauncherPresetBodySchema).max(256)
  }).strict()
}).strict();
var CompatibilityIngressV1Schema = z8.object({
  schema_version: wireVersion("compatibility-ingress"),
  legacy_schema_version: z8.string().min(1).max(128),
  payload: JsonValueSchema
}).passthrough();

// packages/contracts/dist/control.js
var ControlCommandKinds = [
  "project.register",
  "project.archive",
  "project.location_decide",
  "preset.upsert",
  "preset.delete",
  "launch.prepare",
  "session.control",
  "dispatch.enqueue",
  "dispatch.cancel",
  "dispatch.retry",
  "migration.plan",
  "migration.apply",
  "migration.rollback",
  "compatibility.cutover"
];
var ControlCommandKindSchema = z9.enum(ControlCommandKinds);
var SessionMetadataKeySchema = z9.string().min(1).max(128).regex(/^[a-z][a-z0-9_.-]*$/u, "wire.session_metadata.key_invalid");
var SessionMetadataPatchSchema = z9.object({
  patch: z9.record(SessionMetadataKeySchema, JsonValueSchema),
  clear_fields: z9.array(SessionMetadataKeySchema).max(64)
}).strict().superRefine((value2, context) => {
  const patchKeys = Object.keys(value2.patch);
  if (patchKeys.length === 0 && value2.clear_fields.length === 0) {
    context.addIssue({
      code: "custom",
      message: "wire.session_metadata.empty_mutation",
      path: ["patch"]
    });
  }
  for (const [index, field2] of value2.clear_fields.entries()) {
    if (field2 in value2.patch) {
      context.addIssue({
        code: "custom",
        message: "wire.session_metadata.patch_clear_conflict",
        path: ["clear_fields", index]
      });
    }
  }
});
var SessionRoleSchema = z9.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/u, "wire.session_role.invalid");
var SessionControlPayloadSchema = z9.discriminatedUnion("action", [
  z9.object({
    kind: z9.literal("session.control"),
    generation: GenerationReferenceBodySchema,
    action: z9.literal("interrupt")
  }).strict(),
  z9.object({
    kind: z9.literal("session.control"),
    generation: GenerationReferenceBodySchema,
    action: z9.literal("halt")
  }).strict(),
  z9.object({
    kind: z9.literal("session.control"),
    generation: GenerationReferenceBodySchema,
    action: z9.literal("resume")
  }).strict(),
  z9.object({
    kind: z9.literal("session.control"),
    generation: GenerationReferenceBodySchema,
    action: z9.literal("rename"),
    name: z9.string().min(1).max(160)
  }).strict(),
  z9.object({
    kind: z9.literal("session.control"),
    generation: GenerationReferenceBodySchema,
    action: z9.literal("set_role"),
    role: SessionRoleSchema
  }).strict(),
  z9.object({
    kind: z9.literal("session.control"),
    generation: GenerationReferenceBodySchema,
    action: z9.literal("patch_metadata"),
    metadata: SessionMetadataPatchSchema
  }).strict()
]);
var ControlTargetSchema = z9.discriminatedUnion("kind", [
  z9.object({ kind: z9.literal("project"), project: ProjectReferenceBodySchema }).strict(),
  z9.object({ kind: z9.literal("session"), session: SessionReferenceBodySchema }).strict(),
  z9.object({
    kind: z9.literal("generation"),
    generation: GenerationReferenceBodySchema
  }).strict(),
  z9.object({
    kind: z9.literal("endpoint"),
    endpoint: EndpointReferenceBodySchema
  }).strict()
]);
var ControlCommandPayloadSchema = z9.discriminatedUnion("kind", [
  z9.object({
    kind: z9.literal("project.register"),
    project: ProjectReferenceBodySchema,
    location: ProjectLocationReferenceBodySchema
  }).strict(),
  z9.object({
    kind: z9.literal("project.archive"),
    project: ProjectReferenceBodySchema
  }).strict(),
  z9.object({
    kind: z9.literal("project.location_decide"),
    project: ProjectReferenceBodySchema,
    location: ProjectLocationReferenceBodySchema,
    decision: z9.enum(["attach", "reject"])
  }).strict(),
  z9.object({
    kind: z9.literal("preset.upsert"),
    preset_name: z9.string().min(1).max(128),
    preset: LauncherPresetBodySchema
  }).strict(),
  z9.object({
    kind: z9.literal("preset.delete"),
    preset_name: z9.string().min(1).max(128)
  }).strict(),
  z9.object({
    kind: z9.literal("launch.prepare"),
    harness: z9.enum(["claude", "codex", "opencode", "pi"]),
    preset_name: z9.string().min(1).max(128).optional()
  }).strict(),
  SessionControlPayloadSchema,
  z9.object({
    kind: z9.literal("dispatch.enqueue"),
    endpoint: EndpointReferenceBodySchema,
    payload: JsonValueSchema
  }).strict(),
  z9.object({
    kind: z9.literal("dispatch.cancel"),
    delivery_id: DeliveryIdSchema
  }).strict(),
  z9.object({
    kind: z9.literal("dispatch.retry"),
    delivery_id: DeliveryIdSchema
  }).strict(),
  z9.object({
    kind: z9.literal("migration.plan"),
    scope: z9.enum(["runtime", "tracker", "config"])
  }).strict(),
  z9.object({
    kind: z9.literal("migration.apply"),
    plan_id: MigrationPlanIdSchema
  }).strict(),
  z9.object({
    kind: z9.literal("migration.rollback"),
    plan_id: MigrationPlanIdSchema
  }).strict(),
  z9.object({
    kind: z9.literal("compatibility.cutover"),
    stage: z9.enum(["C1", "C2", "C3", "C4", "C5"])
  }).strict()
]);
var ControlCommandV1Schema = z9.object({
  schema_version: wireVersion("control-command"),
  command_id: CommandIdSchema,
  command_kind: ControlCommandKindSchema,
  actor: ActorReferenceBodySchema,
  correlation_id: z9.string().min(1).max(128),
  causation_id: CommandIdSchema.optional(),
  idempotency_key: z9.string().min(1).max(256),
  target: ControlTargetSchema.optional(),
  expected_revision: z9.number().int().nonnegative().optional(),
  endpoint_fence: z9.string().min(1).max(256).optional(),
  audit: z9.object({
    request_source: z9.enum(["cli", "dashboard", "mcp", "service"]),
    redacted_metadata: JsonObjectSchema
  }).strict(),
  payload: ControlCommandPayloadSchema
}).strict().superRefine((value2, context) => {
  if (value2.command_kind !== value2.payload.kind) {
    context.addIssue({
      code: "custom",
      message: "wire.control_command.kind_mismatch",
      path: ["payload", "kind"]
    });
  }
  if (value2.payload.kind === "preset.upsert" && value2.payload.preset_name !== value2.payload.preset.name) {
    context.addIssue({
      code: "custom",
      message: "wire.preset.name_mismatch",
      path: ["payload", "preset", "name"]
    });
  }
});

// packages/contracts/dist/delivery.js
import { z as z10 } from "zod";
var DeliveryEnvelopeV1Schema = z10.object({
  schema_version: wireVersion("delivery-envelope"),
  delivery_id: DeliveryIdSchema,
  command: ControlCommandV1Schema,
  endpoint: EndpointReferenceBodySchema,
  generation: GenerationReferenceBodySchema,
  attempt: z10.number().int().nonnegative(),
  deduplication_key: z10.string().min(1).max(256),
  created_at: z10.iso.datetime({ offset: true }),
  not_before_at: z10.iso.datetime({ offset: true }).optional(),
  payload: JsonValueSchema
}).strict();
var DeliveryAcknowledgementV1Schema = z10.object({
  schema_version: wireVersion("delivery-acknowledgement"),
  delivery_id: DeliveryIdSchema,
  status: z10.enum(["accepted", "completed", "rejected", "retry", "expired"]),
  acknowledged_at: z10.iso.datetime({ offset: true }),
  reason_code: z10.string().min(1).max(128).optional(),
  result: JsonValueSchema.optional()
}).strict();

// packages/contracts/dist/diagnostics.js
import { z as z11 } from "zod";
var DiagnosticsExplanationV1Schema = z11.object({
  schema_version: wireVersion("diagnostics-explanation"),
  code: z11.string().min(1).max(128),
  severity: z11.enum(["info", "warning", "error"]),
  message: z11.string().min(1).max(1024),
  project_id: ProjectIdSchema.optional(),
  event_ids: z11.array(EventIdSchema).max(64),
  facts: JsonObjectSchema,
  remediation: z11.array(z11.string().min(1).max(512)).max(16)
}).strict();

// packages/contracts/dist/facts.js
import { z as z12 } from "zod";
var ClockFactsSchema = z12.object({
  schema_version: wireVersion("clock-facts"),
  ...ClockFactsBodySchema.shape
}).strict().superRefine((value2, context) => {
  const observedAt = Date.parse(value2.source_observed_at);
  const receivedAt = Date.parse(value2.received_at);
  if (observedAt > receivedAt) {
    context.addIssue({
      code: "custom",
      message: "wire.clock.observed_after_received",
      path: ["received_at"]
    });
  }
  if (value2.source_event_at && Date.parse(value2.source_event_at) > receivedAt) {
    context.addIssue({
      code: "custom",
      message: "wire.clock.source_after_received",
      path: ["received_at"]
    });
  }
  if (value2.materialized_at && Date.parse(value2.materialized_at) < receivedAt) {
    context.addIssue({
      code: "custom",
      message: "wire.clock.materialized_before_received",
      path: ["materialized_at"]
    });
  }
});
var ProvenanceSchema = z12.object({
  schema_version: wireVersion("provenance"),
  ...ProvenanceBodySchema.shape
}).strict();
var LifecycleFactsBodySchema = z12.object({
  generation: GenerationReferenceBodySchema,
  state: LifecycleStateSchema,
  started_at: z12.iso.datetime({ offset: true }).optional(),
  last_activity_at: z12.iso.datetime({ offset: true }).optional(),
  ended_at: z12.iso.datetime({ offset: true }).optional(),
  reason: z12.string().min(1).max(256).optional()
}).strict().superRefine((value2, context) => {
  if (value2.started_at && value2.ended_at) {
    if (Date.parse(value2.ended_at) < Date.parse(value2.started_at)) {
      context.addIssue({
        code: "custom",
        message: "wire.lifecycle.ended_before_started",
        path: ["ended_at"]
      });
    }
  }
});
var LifecycleFactsSchema = z12.object({
  schema_version: wireVersion("lifecycle-facts"),
  ...LifecycleFactsBodySchema.shape
}).strict().superRefine((value2, context) => {
  if (value2.started_at && value2.ended_at && Date.parse(value2.ended_at) < Date.parse(value2.started_at)) {
    context.addIssue({
      code: "custom",
      message: "wire.lifecycle.ended_before_started",
      path: ["ended_at"]
    });
  }
});
var EndpointRecordBodySchema = z12.object({
  endpoint_id: EndpointIdSchema,
  generation: GenerationReferenceBodySchema,
  state: EndpointRouteStateSchema,
  owner_fence: z12.string().min(1).max(256),
  delivery_mode: DeliveryModeSchema,
  readiness: DeliveryReadinessSchema,
  revision: z12.number().int().nonnegative(),
  last_heartbeat_at: z12.iso.datetime({ offset: true }).optional()
}).strict();
var EndpointRecordSchema = z12.object({
  schema_version: wireVersion("endpoint-record"),
  ...EndpointRecordBodySchema.shape
}).strict();
var CapabilityRecordBodySchema = z12.object({
  capability_id: z12.string().min(1).max(160),
  harness: HarnessSchema,
  adapter_version: z12.string().min(1).max(64),
  integration_layers: z12.array(z12.enum([
    "extension",
    "hooks",
    "mcp",
    "channel",
    "app_server",
    "prompt_bridge"
  ])).min(1),
  qualification: z12.enum([
    "supported",
    "experimental",
    "unsupported",
    "unknown"
  ]),
  delivery_mode: DeliveryModeSchema,
  readiness: DeliveryReadinessSchema,
  reason_code: z12.string().min(1).max(128).optional(),
  evidence_version: z12.string().min(1).max(64).optional()
}).strict();
var CapabilityRecordSchema = z12.object({
  schema_version: wireVersion("capability-record"),
  ...CapabilityRecordBodySchema.shape
}).strict();

// packages/contracts/dist/fixtures.js
var ids = {
  actor: "act_11111111-1111-4111-8111-111111111111",
  command: "cmd_22222222-2222-4222-8222-222222222222",
  controlPlane: "cpi_33333333-3333-4333-8333-333333333333",
  delivery: "del_44444444-4444-4444-8444-444444444444",
  endpoint: "ep_55555555-5555-4555-8555-555555555555",
  event: "evt_66666666-6666-4666-8666-666666666666",
  generation: "gen_77777777-7777-4777-8777-777777777777",
  location: "loc_88888888-8888-4888-8888-888888888888",
  migration: "mig_99999999-9999-4999-8999-999999999999",
  operation: "op_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  producer: "prod_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  project: "prj_cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  session: "ses_dddddddd-dddd-4ddd-8ddd-dddddddddddd"
};
var timestamp = {
  event: "2026-07-20T09:59:00.000Z",
  observed: "2026-07-20T10:00:00.000Z",
  received: "2026-07-20T10:01:00.000Z",
  materialized: "2026-07-20T10:02:00.000Z"
};
var project = { project_id: ids.project };
var location = {
  project_id: ids.project,
  location_id: ids.location,
  relation: "main",
  canonical_path: "/workspace/golem"
};
var session = { project_id: ids.project, session_id: ids.session };
var generation = { ...session, generation_id: ids.generation };
var actor = { actor_id: ids.actor, kind: "human", display_name: "Operator" };
var producer = {
  producer: "claude-adapter",
  producer_instance_id: ids.producer,
  harness: "claude"
};
var clocks = {
  source_event_at: timestamp.event,
  source_observed_at: timestamp.observed,
  received_at: timestamp.received,
  materialized_at: timestamp.materialized
};
var provenance = { source: "adapter", confidence: "verified" };
var endpoint = {
  endpoint_id: ids.endpoint,
  generation,
  state: "healthy",
  owner_fence: "fence-1",
  delivery_mode: "native_channel",
  readiness: "ready",
  revision: 1,
  last_heartbeat_at: timestamp.observed
};
var capability = {
  capability_id: "claude.channel",
  harness: "claude",
  adapter_version: "1.0.0",
  integration_layers: ["hooks", "mcp", "channel"],
  qualification: "supported",
  delivery_mode: "native_channel",
  readiness: "ready",
  evidence_version: "journey-v1"
};
var controlCommand = {
  schema_version: "golem.control-command/v1",
  command_id: ids.command,
  command_kind: "project.register",
  actor,
  correlation_id: "correlation-1",
  idempotency_key: "command:project.register:1",
  target: { kind: "project", project },
  audit: { request_source: "cli", redacted_metadata: { intent: "register" } },
  payload: { kind: "project.register", project, location }
};
function negativeVersion(value2) {
  return { ...value2, schema_version: "golem.unsupported/v2" };
}
var ContractFixtures = {
  "project-reference": {
    positive: { schema_version: "golem.project-reference/v1", ...project },
    negative: {
      schema_version: "golem.project-reference/v1",
      project_id: "project-name"
    }
  },
  "project-location-reference": {
    positive: {
      schema_version: "golem.project-location-reference/v1",
      ...location
    },
    negative: negativeVersion({
      schema_version: "golem.project-location-reference/v1",
      ...location
    })
  },
  "session-reference": {
    positive: { schema_version: "golem.session-reference/v1", ...session },
    negative: negativeVersion({
      schema_version: "golem.session-reference/v1",
      ...session
    })
  },
  "generation-reference": {
    positive: {
      schema_version: "golem.generation-reference/v1",
      ...generation
    },
    negative: negativeVersion({
      schema_version: "golem.generation-reference/v1",
      ...generation
    })
  },
  "alias-reference": {
    positive: {
      schema_version: "golem.alias-reference/v1",
      project_id: ids.project,
      harness: "claude",
      alias_kind: "native_conversation",
      alias: "native-thread-1",
      session
    },
    negative: {
      schema_version: "golem.alias-reference/v1",
      project_id: ids.project,
      harness: "claude",
      alias_kind: "native_conversation",
      alias: "native-thread-1",
      session: {
        project_id: "prj_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        session_id: ids.session
      }
    }
  },
  "actor-reference": {
    positive: { schema_version: "golem.actor-reference/v1", ...actor },
    negative: negativeVersion({
      schema_version: "golem.actor-reference/v1",
      ...actor
    })
  },
  "producer-reference": {
    positive: { schema_version: "golem.producer-reference/v1", ...producer },
    negative: negativeVersion({
      schema_version: "golem.producer-reference/v1",
      ...producer
    })
  },
  "clock-facts": {
    positive: { schema_version: "golem.clock-facts/v1", ...clocks },
    negative: {
      schema_version: "golem.clock-facts/v1",
      ...clocks,
      received_at: "2026-07-20T09:00:00.000Z"
    }
  },
  provenance: {
    positive: { schema_version: "golem.provenance/v1", ...provenance },
    negative: negativeVersion({
      schema_version: "golem.provenance/v1",
      ...provenance
    })
  },
  "lifecycle-facts": {
    positive: {
      schema_version: "golem.lifecycle-facts/v1",
      generation,
      state: "ended",
      started_at: timestamp.event,
      ended_at: timestamp.materialized
    },
    negative: {
      schema_version: "golem.lifecycle-facts/v1",
      generation,
      state: "ended",
      started_at: timestamp.materialized,
      ended_at: timestamp.event
    }
  },
  "endpoint-record": {
    positive: { schema_version: "golem.endpoint-record/v1", ...endpoint },
    negative: negativeVersion({
      schema_version: "golem.endpoint-record/v1",
      ...endpoint
    })
  },
  "capability-record": {
    positive: { schema_version: "golem.capability-record/v1", ...capability },
    negative: negativeVersion({
      schema_version: "golem.capability-record/v1",
      ...capability
    })
  },
  "runtime-signal": {
    positive: {
      schema_version: "golem.runtime-signal/v1",
      event_id: ids.event,
      event_kind: "session.started",
      ...producer,
      correlation_id: "correlation-1",
      deduplication_key: "event:session.started:1",
      clocks,
      provenance,
      clear_fields: [],
      payload: {
        kind: "session.started",
        generation,
        metadata: { model: "gpt" }
      }
    },
    negative: {
      schema_version: "golem.runtime-signal/v1",
      event_id: ids.event,
      event_kind: "session.started",
      ...producer,
      correlation_id: "correlation-1",
      deduplication_key: "event:session.started:1",
      clocks,
      provenance,
      clear_fields: [],
      payload: { kind: "session.idle", generation }
    }
  },
  "control-command": {
    positive: controlCommand,
    negative: { ...controlCommand, command_id: "cmd_not-a-uuid" }
  },
  "delivery-envelope": {
    positive: {
      schema_version: "golem.delivery-envelope/v1",
      delivery_id: ids.delivery,
      command: controlCommand,
      endpoint: { endpoint_id: ids.endpoint, generation },
      generation,
      attempt: 0,
      deduplication_key: "delivery:1",
      created_at: timestamp.received,
      not_before_at: timestamp.materialized,
      payload: { type: "brief", body: "hello" }
    },
    negative: negativeVersion({
      schema_version: "golem.delivery-envelope/v1",
      delivery_id: ids.delivery,
      command: controlCommand,
      endpoint: { endpoint_id: ids.endpoint, generation },
      generation,
      attempt: 0,
      deduplication_key: "delivery:1",
      created_at: timestamp.received,
      payload: { type: "brief" }
    })
  },
  "delivery-acknowledgement": {
    positive: {
      schema_version: "golem.delivery-acknowledgement/v1",
      delivery_id: ids.delivery,
      status: "accepted",
      acknowledged_at: timestamp.materialized
    },
    negative: negativeVersion({
      schema_version: "golem.delivery-acknowledgement/v1",
      delivery_id: ids.delivery,
      status: "accepted",
      acknowledged_at: timestamp.materialized
    })
  },
  "launcher-preset": {
    positive: {
      schema_version: "golem.launcher-preset/v1",
      name: "review",
      harness: "claude",
      backend: "anthropic",
      model_selector: "claude-sonnet",
      delivery_mode: "pull",
      native_args: ["--verbose"],
      env_key_refs: ["ANTHROPIC_API_KEY"]
    },
    negative: {
      schema_version: "golem.launcher-preset/v1",
      name: "review",
      harness: "claude",
      backend: "anthropic",
      model_selector: "claude-sonnet",
      delivery_mode: "pull",
      native_args: ["--api-key=plain-secret"],
      env_key_refs: ["ANTHROPIC_API_KEY"]
    }
  },
  "launcher-config": {
    positive: {
      schema_version: "golem.launcher-config/v1",
      launch: {
        harness_defaults: { claude: "review" },
        presets: [
          {
            name: "review",
            harness: "claude",
            backend: "anthropic",
            model_selector: "claude-sonnet",
            delivery_mode: "pull",
            native_args: ["--verbose"],
            env_key_refs: ["ANTHROPIC_API_KEY"]
          }
        ]
      }
    },
    negative: {
      schema_version: "golem.launcher-config/v1",
      launch: { harness_defaults: {}, presets: [] },
      api_key: "plain-secret"
    }
  },
  "compatibility-ingress": {
    positive: {
      schema_version: "golem.compatibility-ingress/v1",
      legacy_schema_version: "legacy/v7",
      payload: { legacy: true },
      unknown_additive_field: { retained: true }
    },
    negative: negativeVersion({
      schema_version: "golem.compatibility-ingress/v1",
      legacy_schema_version: "legacy/v7",
      payload: { legacy: true }
    })
  },
  "api-error": {
    positive: {
      schema_version: "golem.api-error/v1",
      code: "not_found",
      message: "resource not found",
      correlation_id: "correlation-1"
    },
    negative: negativeVersion({
      schema_version: "golem.api-error/v1",
      code: "not_found",
      message: "resource not found",
      correlation_id: "correlation-1"
    })
  },
  "api-command-outcome": {
    positive: {
      schema_version: "golem.api-command-outcome/v1",
      command_id: ids.command,
      status: "accepted"
    },
    negative: negativeVersion({
      schema_version: "golem.api-command-outcome/v1",
      command_id: ids.command,
      status: "accepted"
    })
  },
  "command-receipt": {
    positive: {
      schema_version: "golem.command-receipt/v1",
      command_id: ids.command,
      idempotency_key: "command:ticket.update:1",
      command_kind: "ticket.update",
      actor_id: ids.actor,
      project_id: ids.project,
      resource_type: "ticket",
      resource_id: "TKT-0001",
      correlation_id: "correlation-1",
      fingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      outcome: {
        schema_version: "golem.api-command-outcome/v1",
        command_id: ids.command,
        status: "completed"
      },
      committed_at: timestamp.materialized
    },
    negative: negativeVersion({
      schema_version: "golem.command-receipt/v1",
      command_id: ids.command,
      idempotency_key: "command:ticket.update:1",
      command_kind: "ticket.update",
      actor_id: ids.actor,
      project_id: ids.project,
      resource_type: "ticket",
      resource_id: "TKT-0001",
      correlation_id: "correlation-1",
      fingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      outcome: {
        schema_version: "golem.api-command-outcome/v1",
        command_id: ids.command,
        status: "completed"
      },
      committed_at: timestamp.materialized
    })
  },
  "api-page": {
    positive: {
      schema_version: "golem.api-page/v1",
      items: [{ id: ids.project }],
      next_cursor: null,
      total: 1
    },
    negative: negativeVersion({
      schema_version: "golem.api-page/v1",
      items: [],
      next_cursor: null
    })
  },
  "websocket-frame": {
    positive: {
      schema_version: "golem.websocket-frame/v1",
      instance_id: ids.controlPlane,
      stream: "runtime.live",
      sequence: 1,
      resource_revision: 2,
      correlation_id: "correlation-1",
      payload: {
        kind: "snapshot",
        cursor: "cursor-1",
        payload: { sessions: [] }
      }
    },
    negative: negativeVersion({
      schema_version: "golem.websocket-frame/v1",
      instance_id: ids.controlPlane,
      stream: "runtime.live",
      sequence: 1,
      resource_revision: 2,
      correlation_id: "correlation-1",
      payload: { kind: "snapshot", cursor: "cursor-1", payload: {} }
    })
  },
  "migration-plan": {
    positive: {
      schema_version: "golem.migration-plan/v1",
      plan_id: ids.migration,
      mode: "dry_run",
      snapshot_id: "snapshot-1",
      plan_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      created_at: timestamp.received,
      counts_by_reason: { imported: 1 },
      steps: [
        { id: "import-projects", kind: "import", input: { source: "legacy" } }
      ],
      rollback_prerequisites: ["backup-present"]
    },
    negative: negativeVersion({
      schema_version: "golem.migration-plan/v1",
      plan_id: ids.migration,
      mode: "dry_run",
      snapshot_id: "snapshot-1",
      plan_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      created_at: timestamp.received,
      counts_by_reason: { imported: 1 },
      steps: [
        { id: "import-projects", kind: "import", input: { source: "legacy" } }
      ],
      rollback_prerequisites: ["backup-present"]
    })
  },
  "diagnostics-explanation": {
    positive: {
      schema_version: "golem.diagnostics-explanation/v1",
      code: "alias_ambiguous",
      severity: "warning",
      message: "Alias requires review",
      project_id: ids.project,
      event_ids: [ids.event],
      facts: { alias: "native-thread-1" },
      remediation: ["Choose an explicit alias relation"]
    },
    negative: negativeVersion({
      schema_version: "golem.diagnostics-explanation/v1",
      code: "alias_ambiguous",
      severity: "warning",
      message: "Alias requires review",
      event_ids: [],
      facts: {},
      remediation: []
    })
  }
};

// packages/contracts/dist/legacy-projection.js
import { z as z13 } from "zod";
var LegacyControlPlaneProjectionStreamSchema = z13.enum([
  "runtime.live",
  "runtime.history",
  "runtime.diagnostics",
  "projects"
]);
var LegacyControlPlaneProjectionResponseSchema = z13.object({
  schema_version: z13.literal("golem.control-plane-projection/v1"),
  stream: LegacyControlPlaneProjectionStreamSchema,
  resource_revision: z13.number().int().nonnegative(),
  payload: JsonValueSchema
}).strict();

// packages/contracts/dist/migration.js
import { z as z14 } from "zod";
var MigrationPlanV1Schema = z14.object({
  schema_version: wireVersion("migration-plan"),
  plan_id: MigrationPlanIdSchema,
  mode: z14.enum(["dry_run", "apply", "rollback"]),
  snapshot_id: z14.string().min(1).max(256),
  plan_hash: z14.string().regex(/^[a-f0-9]{64}$/u, "migration.plan_hash.invalid"),
  created_at: z14.iso.datetime({ offset: true }),
  counts_by_reason: z14.record(z14.string().min(1), z14.number().int().nonnegative()),
  steps: z14.array(z14.object({
    id: z14.string().min(1).max(128),
    kind: z14.enum([
      "import",
      "export",
      "switch_writer",
      "validate",
      "rollback"
    ]),
    input: JsonObjectSchema
  }).strict()).min(1),
  rollback_prerequisites: z14.array(z14.string().min(1).max(256))
}).strict();

// packages/contracts/dist/references.js
import { z as z15 } from "zod";
var ProjectReferenceSchema = z15.object({
  schema_version: wireVersion("project-reference"),
  ...ProjectReferenceBodySchema.shape
}).strict();
var ProjectLocationReferenceSchema = z15.object({
  schema_version: wireVersion("project-location-reference"),
  ...ProjectLocationReferenceBodySchema.shape
}).strict();
var SessionReferenceSchema = z15.object({
  schema_version: wireVersion("session-reference"),
  ...SessionReferenceBodySchema.shape
}).strict();
var GenerationReferenceSchema = z15.object({
  schema_version: wireVersion("generation-reference"),
  ...GenerationReferenceBodySchema.shape
}).strict();
var AliasReferenceSchema = z15.object({
  schema_version: wireVersion("alias-reference"),
  ...AliasReferenceBodySchema.shape
}).strict().superRefine((value2, context) => {
  if (value2.session && value2.session.project_id !== value2.project_id) {
    context.addIssue({
      code: "custom",
      message: "wire.alias.cross_scope",
      path: ["session", "project_id"]
    });
  }
});
var ActorReferenceSchema = z15.object({
  schema_version: wireVersion("actor-reference"),
  ...ActorReferenceBodySchema.shape
}).strict();
var ProducerReferenceSchema = z15.object({
  schema_version: wireVersion("producer-reference"),
  ...ProducerReferenceBodySchema.shape
}).strict();

// packages/contracts/dist/registry.js
import { z as z18 } from "zod";

// packages/contracts/dist/runtime.js
import { z as z16 } from "zod";
var RuntimeSignalKinds = [
  "project.observed",
  "session.started",
  "session.resumed",
  "session.activity",
  "session.idle",
  "session.waiting",
  "session.metadata_patched",
  "session.ended",
  "endpoint.claimed",
  "endpoint.heartbeat",
  "endpoint.readiness_changed",
  "endpoint.released",
  "capabilities.reported"
];
var RuntimeSignalKindSchema = z16.enum(RuntimeSignalKinds);
var RuntimeSignalPayloadSchema = z16.discriminatedUnion("kind", [
  z16.object({
    kind: z16.literal("project.observed"),
    project: ProjectReferenceBodySchema,
    location: ProjectLocationReferenceBodySchema
  }).strict(),
  z16.object({
    kind: z16.literal("session.started"),
    generation: GenerationReferenceBodySchema,
    metadata: JsonObjectSchema.optional()
  }).strict(),
  z16.object({
    kind: z16.literal("session.resumed"),
    generation: GenerationReferenceBodySchema,
    resumed_from_generation_id: GenerationIdSchema.optional()
  }).strict(),
  z16.object({
    kind: z16.literal("session.activity"),
    generation: GenerationReferenceBodySchema,
    activity_kind: z16.enum(["prompt", "tool", "response", "work"])
  }).strict(),
  z16.object({
    kind: z16.literal("session.idle"),
    generation: GenerationReferenceBodySchema
  }).strict(),
  z16.object({
    kind: z16.literal("session.waiting"),
    generation: GenerationReferenceBodySchema,
    reason: z16.string().min(1).max(256)
  }).strict(),
  z16.object({
    kind: z16.literal("session.metadata_patched"),
    generation: GenerationReferenceBodySchema,
    metadata: JsonObjectSchema
  }).strict(),
  z16.object({
    kind: z16.literal("session.ended"),
    generation: GenerationReferenceBodySchema,
    disposition: z16.enum(["ended", "errored", "superseded"])
  }).strict(),
  z16.object({
    kind: z16.literal("endpoint.claimed"),
    endpoint: EndpointRecordBodySchema
  }).strict(),
  z16.object({
    kind: z16.literal("endpoint.heartbeat"),
    endpoint: EndpointReferenceBodySchema,
    heartbeat_at: z16.iso.datetime({ offset: true })
  }).strict(),
  z16.object({
    kind: z16.literal("endpoint.readiness_changed"),
    endpoint: EndpointRecordBodySchema
  }).strict(),
  z16.object({
    kind: z16.literal("endpoint.released"),
    endpoint: EndpointReferenceBodySchema,
    reason: z16.string().min(1).max(256)
  }).strict(),
  z16.object({
    kind: z16.literal("capabilities.reported"),
    project: ProjectReferenceBodySchema,
    capabilities: z16.array(CapabilityRecordBodySchema).min(1)
  }).strict()
]);
var RuntimeSignalV1Schema = z16.object({
  schema_version: wireVersion("runtime-signal"),
  event_id: EventIdSchema,
  event_kind: RuntimeSignalKindSchema,
  ...ProducerReferenceBodySchema.shape,
  producer_sequence: z16.number().int().nonnegative().optional(),
  correlation_id: z16.string().min(1).max(128),
  causation_id: EventIdSchema.optional(),
  deduplication_key: z16.string().min(1).max(256),
  owner_fence: z16.string().min(1).max(256).optional(),
  clocks: ClockFactsBodySchema,
  provenance: ProvenanceBodySchema,
  clear_fields: z16.array(z16.string().min(1).max(160)).max(64),
  payload: RuntimeSignalPayloadSchema
}).strict().superRefine((value2, context) => {
  if (value2.event_kind !== value2.payload.kind) {
    context.addIssue({
      code: "custom",
      message: "wire.runtime_signal.kind_mismatch",
      path: ["payload", "kind"]
    });
  }
  const clocks2 = ClockFactsBodySchema.safeParse(value2.clocks);
  if (!clocks2.success) {
    for (const issue2 of clocks2.error.issues) {
      context.addIssue({
        code: "custom",
        message: issue2.message,
        path: ["clocks", ...issue2.path]
      });
    }
  }
});

// packages/contracts/dist/websocket.js
import { z as z17 } from "zod";
var WebSocketFramePayloadSchema = z17.discriminatedUnion("kind", [
  z17.object({
    kind: z17.literal("snapshot"),
    cursor: z17.string().min(1).max(512),
    payload: JsonValueSchema
  }).strict(),
  z17.object({
    kind: z17.literal("delta"),
    cursor: z17.string().min(1).max(512),
    delta: JsonValueSchema
  }).strict(),
  z17.object({
    kind: z17.literal("resync_required"),
    reason: z17.enum([
      "instance_changed",
      "cursor_gap",
      "cursor_compacted",
      "policy_changed",
      "protocol_mismatch"
    ]),
    snapshot_url: z17.string().url().max(2048)
  }).strict()
]);
var WebSocketFrameV1Schema = z17.object({
  schema_version: wireVersion("websocket-frame"),
  instance_id: ControlPlaneInstanceIdSchema,
  stream: z17.enum([
    "runtime.live",
    "runtime.history",
    "runtime.diagnostics",
    "projects",
    "tracker.tree",
    "tracker.board",
    "management.controls",
    "communication.operations"
  ]),
  sequence: z17.number().int().nonnegative(),
  resource_revision: z17.number().int().nonnegative(),
  correlation_id: z17.string().min(1).max(128),
  payload: WebSocketFramePayloadSchema
}).strict();

// packages/contracts/dist/registry.js
function entry(name, schema2) {
  return {
    name,
    schemaId: schemaIdentifier(name),
    wireVersion: `golem.${name}/v1`,
    fileName: `${name}.schema.json`,
    schema: schema2
  };
}
var ContractSchemaRegistry = [
  entry("project-reference", ProjectReferenceSchema),
  entry("project-location-reference", ProjectLocationReferenceSchema),
  entry("session-reference", SessionReferenceSchema),
  entry("generation-reference", GenerationReferenceSchema),
  entry("alias-reference", AliasReferenceSchema),
  entry("actor-reference", ActorReferenceSchema),
  entry("producer-reference", ProducerReferenceSchema),
  entry("clock-facts", ClockFactsSchema),
  entry("provenance", ProvenanceSchema),
  entry("lifecycle-facts", LifecycleFactsSchema),
  entry("endpoint-record", EndpointRecordSchema),
  entry("capability-record", CapabilityRecordSchema),
  entry("runtime-signal", RuntimeSignalV1Schema),
  entry("control-command", ControlCommandV1Schema),
  entry("delivery-envelope", DeliveryEnvelopeV1Schema),
  entry("delivery-acknowledgement", DeliveryAcknowledgementV1Schema),
  entry("launcher-preset", LauncherPresetSchema),
  entry("launcher-config", LauncherConfigV1Schema),
  entry("compatibility-ingress", CompatibilityIngressV1Schema),
  entry("api-error", ApiErrorV1Schema),
  entry("api-command-outcome", ApiCommandOutcomeV1Schema),
  entry("command-receipt", CommandReceiptV1Schema),
  entry("api-page", ApiPageV1Schema),
  entry("websocket-frame", WebSocketFrameV1Schema),
  entry("migration-plan", MigrationPlanV1Schema),
  entry("diagnostics-explanation", DiagnosticsExplanationV1Schema)
];

// packages/runtime/dist/inbox.js
var fileSystem = fs2;
var maxSignalBytes = 1048576;
var defaultClaimLeaseMs = 3e4;
var defaultMaxAttempts = 3;
function fsyncDirectory(directory) {
  const descriptor = fileSystem.openSync(directory, "r");
  try {
    fileSystem.fsyncSync(descriptor);
  } finally {
    fileSystem.closeSync(descriptor);
  }
}
function isEnvelopeFile(name) {
  return name.endsWith(".json") && !name.endsWith(".metadata.json");
}
function countEnvelopeFiles(directory) {
  return fs2.readdirSync(directory, { withFileTypes: true }).filter((entry2) => entry2.isFile() && isEnvelopeFile(entry2.name)).length;
}
function eventFileName(eventId) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/u.test(eventId))
    throw new Error("runtime inbox event id is not filesystem-safe");
  return `${eventId}.json`;
}
function redactDiagnostic(value2) {
  return value2.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED]@").replace(/\bBearer\s+[A-Za-z0-9._-]+/giu, "Bearer [REDACTED]").replace(/\b(token|authorization|password|secret)=([^\s&]+)/giu, "$1=[REDACTED]").replace(/\/[A-Za-z0-9._~\-/]{12,}/gu, "[PATH]").slice(0, 512);
}
function retryDelayMs(attempt) {
  return Math.min(3e4, 1e3 * 2 ** Math.max(0, attempt - 1));
}
function claimFileName(metadata) {
  return `${metadata.eventId}~${metadata.attempt}~${metadata.claimedAt}~${metadata.leaseMs}~${metadata.token}.json`;
}
function parseClaimFileName(name) {
  if (!name.endsWith(".json"))
    return void 0;
  const stem = name.slice(0, -".json".length);
  const fields = stem.split("~");
  if (fields.length !== 5)
    return void 0;
  const [eventId, attemptText, claimedAtText, leaseText, token2] = fields;
  const attempt = Number(attemptText);
  const claimedAt = Number(claimedAtText);
  const leaseMs = Number(leaseText);
  if (!eventId || !token2 || !Number.isInteger(attempt) || attempt < 1 || !Number.isFinite(claimedAt) || !Number.isInteger(leaseMs) || leaseMs < 1)
    return void 0;
  return Object.freeze({ eventId, attempt, claimedAt, leaseMs, token: token2 });
}
var RuntimeInbox = class {
  #root;
  #pending;
  #processing;
  #archived;
  #quarantine;
  #retry;
  #afterTemporaryFsync;
  #now;
  #claimLeaseMs;
  #maxAttempts;
  constructor(home, options = {}) {
    this.#root = path2.join(home, "inbox");
    this.#pending = path2.join(this.#root, "pending");
    this.#processing = path2.join(this.#root, "processing");
    this.#archived = path2.join(this.#root, "archived");
    this.#quarantine = path2.join(this.#root, "quarantine");
    this.#retry = path2.join(this.#root, "retry");
    for (const directory of [
      this.#pending,
      this.#processing,
      this.#archived,
      this.#quarantine,
      this.#retry
    ])
      fs2.mkdirSync(directory, { recursive: true, mode: 448 });
    this.#afterTemporaryFsync = options.afterTemporaryFsync;
    this.#now = options.now ?? Date.now;
    this.#claimLeaseMs = options.claimLeaseMs ?? defaultClaimLeaseMs;
    this.#maxAttempts = options.maxAttempts ?? defaultMaxAttempts;
    if (!Number.isInteger(this.#claimLeaseMs) || this.#claimLeaseMs < 1)
      throw new Error("runtime inbox claim lease must be positive");
    if (!Number.isInteger(this.#maxAttempts) || this.#maxAttempts < 1)
      throw new Error("runtime inbox max attempts must be positive");
  }
  get root() {
    return this.#root;
  }
  accept(signal) {
    const parsed = RuntimeSignalV1Schema.parse(signal);
    const body3 = Buffer.from(`${JSON.stringify(parsed)}
`, "utf8");
    if (body3.byteLength > maxSignalBytes)
      throw new Error("runtime signal exceeds the 1 MiB inbox limit");
    const target = path2.join(this.#pending, eventFileName(parsed.event_id));
    const temporary = path2.join(this.#pending, `.${parsed.event_id}.${crypto3.randomUUID()}.tmp`);
    let descriptor;
    try {
      descriptor = fileSystem.openSync(temporary, fs2.constants.O_WRONLY | fs2.constants.O_CREAT | fs2.constants.O_EXCL, 384);
      fileSystem.writeFileSync(descriptor, body3);
      fileSystem.fsyncSync(descriptor);
      fileSystem.closeSync(descriptor);
      descriptor = void 0;
      this.#afterTemporaryFsync?.();
      try {
        fileSystem.linkSync(temporary, target);
        fsyncDirectory(this.#pending);
        fileSystem.unlinkSync(temporary);
        fsyncDirectory(this.#pending);
        return Object.freeze({ eventId: parsed.event_id, status: "spooled" });
      } catch (error2) {
        if (error2.code === "EEXIST")
          return Object.freeze({
            eventId: parsed.event_id,
            status: "already_pending"
          });
        throw error2;
      }
    } finally {
      if (descriptor !== void 0)
        fileSystem.closeSync(descriptor);
      if (fs2.existsSync(temporary))
        fs2.unlinkSync(temporary);
    }
  }
  /** Control-plane port name; it deliberately has the same filesystem-only semantics. */
  ingest(signal) {
    return this.accept(signal);
  }
  claim(limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("runtime inbox claim limit must be an integer from 1 to 100");
    const now2 = this.#now();
    const candidates = fs2.readdirSync(this.#pending, { withFileTypes: true }).filter((entry2) => entry2.isFile() && isEnvelopeFile(entry2.name)).map((entry2) => entry2.name).filter((name) => {
      const retry = this.#readRetry(name.slice(0, -".json".length));
      return !retry || retry.nextAttemptAt <= now2;
    }).sort().slice(0, limit);
    const claimed = [];
    for (const name of candidates) {
      const eventId = name.slice(0, -".json".length);
      const retry = this.#readRetry(eventId);
      const metadata = {
        eventId,
        attempt: (retry?.attempts ?? 0) + 1,
        claimedAt: now2,
        leaseMs: this.#claimLeaseMs,
        token: crypto3.randomUUID()
      };
      const claimPath = path2.join(this.#processing, claimFileName(metadata));
      try {
        fs2.renameSync(path2.join(this.#pending, name), claimPath);
        fsyncDirectory(this.#pending);
        fsyncDirectory(this.#processing);
        claimed.push(Object.freeze({
          eventId,
          claimPath,
          attempt: metadata.attempt,
          raw: fs2.readFileSync(claimPath)
        }));
      } catch (error2) {
        if (error2.code !== "ENOENT")
          throw error2;
      }
    }
    return Object.freeze(claimed);
  }
  reclaimProcessing() {
    let reclaimed = 0;
    const now2 = this.#now();
    for (const entry2 of fs2.readdirSync(this.#processing, {
      withFileTypes: true
    })) {
      if (!entry2.isFile() || !isEnvelopeFile(entry2.name))
        continue;
      const metadata = parseClaimFileName(entry2.name);
      if (!metadata) {
        this.#quarantinePath(path2.join(this.#processing, entry2.name), "invalid_claim_metadata", 1, "claim metadata is invalid");
        continue;
      }
      if (metadata.claimedAt + metadata.leaseMs > now2)
        continue;
      const pathToClaim = path2.join(this.#processing, entry2.name);
      if (metadata.attempt >= this.#maxAttempts) {
        this.#quarantinePath(pathToClaim, "lease_expired", metadata.attempt, "claim lease expired after bounded attempts");
        reclaimed += 1;
        continue;
      }
      this.#returnToPending(pathToClaim, metadata.eventId, metadata.attempt, "claim lease expired", 0);
      reclaimed += 1;
    }
    return reclaimed;
  }
  retry(entry2, reason) {
    if (!fs2.existsSync(entry2.claimPath))
      return "retrying";
    if (entry2.attempt >= this.#maxAttempts) {
      this.#quarantinePath(entry2.claimPath, "poison", entry2.attempt, reason);
      return "quarantined";
    }
    this.#returnToPending(entry2.claimPath, entry2.eventId, entry2.attempt, reason, retryDelayMs(entry2.attempt));
    return "retrying";
  }
  archive(entry2) {
    if (!fs2.existsSync(entry2.claimPath))
      return;
    const target = path2.join(this.#archived, eventFileName(entry2.eventId));
    try {
      fileSystem.linkSync(entry2.claimPath, target);
      fsyncDirectory(this.#archived);
      fileSystem.unlinkSync(entry2.claimPath);
      fsyncDirectory(this.#processing);
      this.#removeRetry(entry2.eventId);
      return;
    } catch (error2) {
      if (error2.code !== "EEXIST")
        throw error2;
    }
    const original = fs2.readFileSync(target);
    const duplicate = fs2.readFileSync(entry2.claimPath);
    if (original.equals(duplicate)) {
      fs2.unlinkSync(entry2.claimPath);
      fsyncDirectory(this.#processing);
      this.#removeRetry(entry2.eventId);
      return;
    }
    this.#quarantinePath(entry2.claimPath, "archive_conflict", entry2.attempt, "archive target exists with different raw envelope");
  }
  quarantine(entry2, reason) {
    this.#quarantinePath(entry2.claimPath, reason, entry2.attempt, reason);
  }
  metrics(now2 = this.#now()) {
    const pendingEntries = fs2.readdirSync(this.#pending, { withFileTypes: true }).filter((entry2) => entry2.isFile() && isEnvelopeFile(entry2.name));
    const oldest = pendingEntries.map((entry2) => fs2.statSync(path2.join(this.#pending, entry2.name)).mtimeMs).sort((left, right) => left - right)[0];
    const retries = fs2.readdirSync(this.#retry, { withFileTypes: true }).filter((entry2) => entry2.isFile() && entry2.name.endsWith(".json")).map((entry2) => this.#readRetry(entry2.name.slice(0, -".json".length))).filter((value2) => value2 !== void 0);
    const oldestRetry = retries.map((entry2) => entry2.retryStartedAt).sort((left, right) => left - right)[0];
    return Object.freeze({
      pending: pendingEntries.length,
      processing: countEnvelopeFiles(this.#processing),
      archived: countEnvelopeFiles(this.#archived),
      quarantined: countEnvelopeFiles(this.#quarantine),
      retrying: retries.length,
      ...oldest === void 0 ? {} : { oldestPendingAgeMs: Math.max(0, now2 - oldest) },
      ...oldestRetry === void 0 ? {} : { oldestRetryAgeMs: Math.max(0, now2 - oldestRetry) }
    });
  }
  #readRetry(eventId) {
    const source = path2.join(this.#retry, eventFileName(eventId));
    if (!fs2.existsSync(source))
      return void 0;
    try {
      const decoded = JSON.parse(fs2.readFileSync(source, "utf8"));
      if (!Number.isInteger(decoded.attempts) || decoded.attempts < 1 || !Number.isFinite(decoded.retryStartedAt) || !Number.isFinite(decoded.nextAttemptAt) || typeof decoded.lastError !== "string")
        return void 0;
      return Object.freeze(decoded);
    } catch {
      return void 0;
    }
  }
  #writeRetry(eventId, metadata) {
    const target = path2.join(this.#retry, eventFileName(eventId));
    const temporary = path2.join(this.#retry, `.${eventId}.${crypto3.randomUUID()}.tmp`);
    const descriptor = fileSystem.openSync(temporary, fs2.constants.O_WRONLY | fs2.constants.O_CREAT | fs2.constants.O_EXCL, 384);
    try {
      fileSystem.writeFileSync(descriptor, JSON.stringify(metadata));
      fileSystem.fsyncSync(descriptor);
    } finally {
      fileSystem.closeSync(descriptor);
    }
    fs2.renameSync(temporary, target);
    fsyncDirectory(this.#retry);
  }
  #removeRetry(eventId) {
    const target = path2.join(this.#retry, eventFileName(eventId));
    if (!fs2.existsSync(target))
      return;
    fs2.unlinkSync(target);
    fsyncDirectory(this.#retry);
  }
  #returnToPending(claimPath, eventId, attempt, reason, delayMs) {
    this.#writeRetry(eventId, {
      attempts: attempt,
      retryStartedAt: this.#now(),
      nextAttemptAt: this.#now() + delayMs,
      lastError: redactDiagnostic(reason)
    });
    const target = path2.join(this.#pending, eventFileName(eventId));
    try {
      fileSystem.linkSync(claimPath, target);
      fsyncDirectory(this.#pending);
      fileSystem.unlinkSync(claimPath);
      fsyncDirectory(this.#processing);
    } catch (error2) {
      if (error2.code !== "EEXIST")
        throw error2;
      if (fs2.existsSync(claimPath)) {
        fs2.unlinkSync(claimPath);
        fsyncDirectory(this.#processing);
      }
    }
  }
  #quarantinePath(claimPath, reason, attempt, diagnostic) {
    if (!fs2.existsSync(claimPath))
      return;
    const safeReason = reason.replace(/[^a-z0-9_-]/giu, "_").slice(0, 64);
    const base = `${path2.basename(claimPath, ".json")}.${safeReason || "invalid"}.${crypto3.randomUUID()}`;
    const target = path2.join(this.#quarantine, `${base}.json`);
    fileSystem.linkSync(claimPath, target);
    fsyncDirectory(this.#quarantine);
    fileSystem.writeFileSync(path2.join(this.#quarantine, `${base}.metadata.json`), JSON.stringify({
      reason: safeReason || "invalid",
      attempt,
      diagnostic: redactDiagnostic(diagnostic)
    }), { mode: 384 });
    fsyncDirectory(this.#quarantine);
    fs2.unlinkSync(claimPath);
    fsyncDirectory(this.#processing);
    const metadata = parseClaimFileName(path2.basename(claimPath));
    if (metadata)
      this.#removeRetry(metadata.eventId);
  }
};

// packages/runtime/dist/materializer.js
var sessionKinds = [
  "session.started",
  "session.resumed",
  "session.activity",
  "session.idle",
  "session.waiting",
  "session.metadata_patched",
  "session.ended"
];
function defaultHandler(signal) {
  const outbox = {
    destination: "tracker",
    payload: {
      event_id: signal.event_id,
      event_kind: signal.event_kind,
      producer_instance_id: signal.producer_instance_id
    }
  };
  if (signal.payload.kind === "project.observed") {
    return Object.freeze({
      disposition: "accepted",
      explanation: {
        code: "runtime.project_observed",
        details: { event_kind: signal.event_kind }
      },
      mutation: {
        project: {
          projectId: signal.payload.project.project_id,
          name: signal.payload.project.project_id,
          locationId: signal.payload.location.location_id,
          canonicalPath: signal.payload.location.canonical_path,
          ...signal.payload.location.observed_path === void 0 ? {} : { observedPath: signal.payload.location.observed_path },
          relation: signal.payload.location.relation
        }
      },
      outbox
    });
  }
  return Object.freeze({
    disposition: "accepted",
    explanation: {
      code: "runtime.signal_recorded",
      details: { event_kind: signal.event_kind }
    },
    outbox
  });
}
function createDefaultRuntimeHandlers() {
  return createDefaultRuntimeHandlersWithOptions();
}
function createDefaultRuntimeHandlersWithOptions(options = {}) {
  const handlers = [];
  if (options.sessions) {
    handlers.push(Object.freeze({
      kinds: sessionKinds,
      materialize: (signal) => {
        const result2 = options.sessions?.apply(signal);
        if (result2?.disposition !== "accepted")
          return Object.freeze({
            disposition: "illegal",
            explanation: {
              code: result2?.code ?? "runtime.session.rejected",
              details: result2?.details ?? {}
            }
          });
        return Object.freeze({
          disposition: "accepted",
          explanation: {
            code: result2.code,
            details: {
              session_id: result2.sessionId ?? "",
              generation_id: result2.generationId ?? "",
              revision: result2.revision ?? 0
            }
          }
        });
      }
    }));
  }
  const handled = new Set(options.sessions ? sessionKinds : []);
  handlers.push(Object.freeze({
    kinds: RuntimeSignalKinds.filter((kind) => !handled.has(kind)),
    materialize: defaultHandler
  }));
  return Object.freeze(handlers);
}
var RuntimeMaterializer = class {
  #inbox;
  #writer;
  #handlers;
  constructor(options) {
    this.#inbox = options.inbox;
    this.#writer = options.writer;
    const handlers = /* @__PURE__ */ new Map();
    for (const handler of options.handlers ?? createDefaultRuntimeHandlers())
      for (const kind of handler.kinds) {
        if (handlers.has(kind))
          throw new Error(`runtime materializer duplicate handler: ${kind}`);
        handlers.set(kind, handler);
      }
    this.#handlers = handlers;
  }
  get inbox() {
    return this.#inbox;
  }
  drain(options = {}) {
    const reclaimed = this.#inbox.reclaimProcessing();
    const claimed = this.#inbox.claim(options.limit ?? 100);
    const result2 = {
      reclaimed,
      claimed: claimed.length,
      materialized: 0,
      duplicated: 0,
      stale: 0,
      illegal: 0,
      quarantined: 0,
      retrying: 0
    };
    for (const entry2 of claimed) {
      if (options.failpoint === "after_claim")
        throw new Error("runtime materializer failpoint after_claim");
      const outcome2 = this.#materializeClaim(entry2, options.failpoint);
      result2[outcome2] += 1;
    }
    return Object.freeze(result2);
  }
  #materializeClaim(entry2, failpoint) {
    if (entry2.raw.byteLength > 1048576) {
      this.#inbox.quarantine(entry2, "oversized");
      return "quarantined";
    }
    let decoded;
    try {
      decoded = JSON.parse(Buffer.from(entry2.raw).toString("utf8"));
    } catch {
      this.#inbox.quarantine(entry2, "malformed_json");
      return "quarantined";
    }
    const parsed = RuntimeSignalV1Schema.safeParse(decoded);
    if (!parsed.success) {
      this.#inbox.quarantine(entry2, "unsupported_or_invalid_schema");
      return "quarantined";
    }
    const handler = this.#handlers.get(parsed.data.event_kind);
    if (!handler) {
      this.#inbox.quarantine(entry2, "unregistered_event_kind");
      return "quarantined";
    }
    if (failpoint === "before_transaction")
      throw new Error("runtime materializer failpoint before_transaction");
    let outcome2;
    try {
      const decision = handler.materialize(parsed.data);
      outcome2 = this.#writer.materializeRuntimeEvent({
        eventId: parsed.data.event_id,
        deduplicationKey: parsed.data.deduplication_key,
        eventKind: parsed.data.event_kind,
        payload: parsed.data.payload,
        provenance: parsed.data.provenance,
        occurredAt: parsed.data.clocks.source_observed_at,
        producer: {
          id: parsed.data.producer_instance_id,
          ...parsed.data.producer_sequence === void 0 ? {} : { sequence: parsed.data.producer_sequence }
        },
        disposition: decision.disposition,
        explanation: decision.explanation,
        ...decision.mutation ? { mutation: decision.mutation } : {},
        ...decision.outbox ? { outbox: decision.outbox } : {}
      });
    } catch (error2) {
      const retry = this.#inbox.retry(entry2, error2 instanceof Error ? error2.message : String(error2));
      return retry;
    }
    if (failpoint === "after_commit")
      throw new Error("runtime materializer failpoint after_commit");
    if (failpoint === "before_archive")
      throw new Error("runtime materializer failpoint before_archive");
    this.#inbox.archive(entry2);
    switch (outcome2.disposition) {
      case "accepted":
        return "materialized";
      case "duplicate":
        return "duplicated";
      case "stale":
        return "stale";
      case "illegal":
        return "illegal";
    }
  }
};
function createRuntimeMaterializer(options) {
  const inbox = new RuntimeInbox(options.home, options.inboxOptions);
  return Object.freeze({
    inbox,
    materializer: new RuntimeMaterializer({
      inbox,
      writer: options.writer,
      ...options.handlers ? { handlers: options.handlers } : {
        handlers: createDefaultRuntimeHandlersWithOptions(options.sessions ? { sessions: options.sessions } : {})
      }
    })
  });
}

// packages/runtime/dist/outbox.js
var RuntimeOutboxDrainer = class {
  #writer;
  #destinations;
  #workerId;
  constructor(options) {
    if (!options.workerId.trim())
      throw new Error("outbox worker id is required");
    this.#writer = options.writer;
    this.#destinations = new Map(Object.entries(options.destinations));
    this.#workerId = options.workerId;
  }
  async drain(limit = 100) {
    const claimed = this.#writer.claimRuntimeOutbox(this.#workerId, limit);
    const result2 = {
      claimed: claimed.length,
      acknowledged: 0,
      acknowledgementConflicts: 0,
      failureConflicts: 0,
      deferred: 0,
      permanentFailures: 0
    };
    for (const entry2 of claimed) {
      const destination = this.#destinations.get(entry2.destination);
      if (!destination) {
        const failure2 = this.#writer.failRuntimeOutbox(entry2.id, entry2.claimToken, `no runtime outbox destination registered for ${entry2.destination}`);
        if (failure2?.status === "permanent_failure")
          result2.permanentFailures += 1;
        else if (failure2)
          result2.deferred += 1;
        else
          result2.failureConflicts += 1;
        continue;
      }
      try {
        await destination.deliver({ id: entry2.id, payload: entry2.payload });
        if (this.#writer.ackRuntimeOutbox(entry2.id, entry2.claimToken))
          result2.acknowledged += 1;
        else
          result2.acknowledgementConflicts += 1;
      } catch (error2) {
        const failure2 = this.#writer.failRuntimeOutbox(entry2.id, entry2.claimToken, error2 instanceof Error ? error2.message : String(error2));
        if (failure2?.status === "permanent_failure")
          result2.permanentFailures += 1;
        else if (failure2)
          result2.deferred += 1;
        else
          result2.failureConflicts += 1;
      }
    }
    return Object.freeze(result2);
  }
};

// packages/runtime/dist/projections.js
var terminalStates = /* @__PURE__ */ new Set(["ended", "errored", "superseded"]);
var safeIdentifierKey = /^(?:id|event(?:_id|_uuid)?|fence(?:_id)?|schema(?:_version)?|revision|resource_revision|cursor|sequence|ordinal|code|topic|watermark|project_id|session_id|generation_id|endpoint_id)$/iu;
var secretKey = /(?:token|credential|password|secret|api[_-]?key|authorization|env(?:ironment)?|prompt|(?:unrelated_)?path|pathname|file(?:name)?|directory|cwd|home|root)/iu;
var assignment = /\b(?:owner[_-]?token|access[_-]?token|openai[_-]?api[_-]?key|token|credential|password|secret|api[_-]?key|authorization)\s*[=:]\s*[^\s,;}]+/giu;
var environmentAssignment = /\b(?:HOME|PATH|PWD|USER|SHELL|GOLEM_HOME|NODE_PATH|[A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|API|AUTH)[A-Z0-9_]*)\s*=\s*[^\s,;}]+/gu;
var filesystemPath = /\/(?:Users|private\/tmp|tmp|var\/folders|home)\/[^\s,;}"]+/gu;
var bearer = /\bBearer\s+[A-Za-z0-9._-]+/giu;
var maxDiagnosticDepth = 5;
var maxDiagnosticBytes = 2048;
function redact(value2, depth = 0) {
  if (depth > maxDiagnosticDepth)
    return "[DEPTH_REDACTED]";
  if (typeof value2 === "string")
    return value2.replace(environmentAssignment, (match) => `${match.split("=")[0]}=[REDACTED]`).replace(assignment, (match) => `${match.split(/[=:]/u)[0]}=[REDACTED]`).replace(bearer, "Bearer [REDACTED]").replace(filesystemPath, "[PATH_REDACTED]").slice(0, 512);
  if (Array.isArray(value2))
    return value2.slice(0, 64).map((entry2) => redact(entry2, depth + 1));
  if (value2 && typeof value2 === "object") {
    const output = {};
    for (const [key, entry2] of Object.entries(value2).slice(0, 64))
      output[key] = !safeIdentifierKey.test(key) && secretKey.test(key) ? "[REDACTED]" : redact(entry2, depth + 1);
    return output;
  }
  return value2;
}
function safeDiagnostic(value2) {
  const redacted = redact(value2);
  try {
    const serialized = JSON.stringify(redacted);
    if (serialized.length <= maxDiagnosticBytes)
      return redacted;
    return { summary: "diagnostic truncated", bytes: serialized.length };
  } catch {
    return { summary: "diagnostic unavailable" };
  }
}
function boundedQuery(query = {}) {
  const cursor = query.cursor ?? 0;
  const limit = query.limit ?? 100;
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > 1e6)
    throw new Error("runtime projection cursor must be a safe non-negative integer");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error("runtime projection limit must be an integer from 1 to 100");
  return { ...query, cursor, limit };
}
function endpointFacts(endpoints) {
  return endpoints.map((endpoint3) => ({
    endpoint_id: endpoint3.endpointId,
    generation_id: endpoint3.generationId,
    route_kind: endpoint3.routeKind,
    revision: endpoint3.revision,
    state: endpoint3.state,
    owner_fence: endpoint3.ownerFence,
    delivery_mode: endpoint3.deliveryMode,
    readiness: endpoint3.readiness,
    control_state: endpoint3.controlState,
    consumer_ready: endpoint3.consumerReady,
    consumption_observed: endpoint3.consumptionObserved,
    delivery_observed: endpoint3.deliveryObserved,
    delivery_failed: endpoint3.deliveryFailed,
    capabilities: endpoint3.capabilities.map((capability3) => ({
      capability: capability3.capability,
      adapter_id: capability3.adapterId,
      adapter_version: capability3.adapterVersion,
      qualification: capability3.qualification,
      readiness: capability3.readiness,
      delivery_mode: capability3.deliveryMode,
      evidence_kind: capability3.evidenceKind,
      observed_at: capability3.observedAt
    }))
  }));
}
function generationItem(session2, generation2, endpoints) {
  return {
    project_id: session2.projectId,
    session_id: session2.sessionId,
    generation_id: generation2.generationId,
    ordinal: generation2.ordinal,
    harness: generation2.harness,
    state: generation2.state,
    metadata: safeDiagnostic(generation2.metadata),
    provenance: safeDiagnostic({
      lifecycle: generation2.lifecycleProvenance,
      fields: generation2.fieldProvenance
    }),
    actor_activity_at: generation2.activityAt ?? session2.activityAt ?? null,
    observation: {
      observed_at: generation2.observedAt ?? session2.observedAt ?? null,
      read_only: true
    },
    revision: generation2.revision,
    endpoints: endpointFacts(endpoints)
  };
}
function page(stream, revision, generatedAt, items, query, explain, observation, drift) {
  const bounded = boundedQuery(query);
  const visible = items.slice(bounded.cursor, bounded.cursor + bounded.limit);
  const next = bounded.cursor + visible.length < items.length ? bounded.cursor + visible.length : void 0;
  return Object.freeze({
    schema_version: "golem.runtime-projection/v1",
    stream,
    resource_revision: revision,
    cursor: bounded.cursor,
    ...next === void 0 ? {} : { next_cursor: next },
    generated_at: generatedAt,
    items: Object.freeze(visible),
    explain: Object.freeze(explain),
    observation: Object.freeze(observation),
    drift: Object.freeze(drift)
  });
}
var RuntimeProjectionService = class {
  #storage;
  #clock;
  #legacy;
  constructor(options) {
    this.#storage = options.storage;
    this.#clock = options.clock ?? { now: () => (/* @__PURE__ */ new Date()).toISOString() };
    this.#legacy = options.legacy;
  }
  revision(_stream) {
    return this.#storage.revision();
  }
  query(stream, input = {}) {
    const query = boundedQuery(input);
    if (stream === "runtime.diagnostics") {
      const events = this.#storage.events();
      const diagnostics = this.#storage.diagnostics();
      const items2 = diagnostics.map((diagnostic) => ({
        id: diagnostic.id,
        code: diagnostic.code,
        details: safeDiagnostic(diagnostic.details),
        created_at: diagnostic.createdAt
      }));
      return page(stream, this.revision(stream), this.#clock.now(), items2, query, {
        source: "runtime_events + diagnostics",
        accepted: events.filter((event) => event.disposition === "accepted").length,
        rejected: events.filter((event) => event.disposition !== "accepted").length
      }, {
        read_only: true,
        producer_watermarks: this.#storage.watermarks().map((watermark) => ({
          producer_id: watermark.producerId,
          watermark: watermark.watermark,
          received_at: watermark.receivedAt
        }))
      }, { status: "not_configured" });
    }
    const terminal5 = stream === "runtime.history";
    const items = this.#storage.sessions(query.projectId).flatMap((session2) => session2.generations.filter((generation2) => terminal5 ? terminalStates.has(generation2.state) : !terminalStates.has(generation2.state)).filter((generation2) => !query.state || generation2.state === query.state).map((generation2) => generationItem(session2, generation2, this.#storage.endpoints(generation2.generationId))));
    const payload2 = page(stream, this.revision(stream), this.#clock.now(), items, query, {
      source: "canonical runtime session/generation projections",
      terminal_excluded_from_live: true,
      observation_does_not_change_actor_activity: true
    }, { read_only: true }, { status: "not_configured" });
    if (!this.#legacy?.compare)
      return payload2;
    const drift = this.#legacy.compare(stream, payload2);
    return Object.freeze({ ...payload2, drift: Object.freeze({ ...drift }) });
  }
  read(stream, query) {
    return this.query(stream, query);
  }
};
function createRuntimeProjectionService(options) {
  return new RuntimeProjectionService(options);
}

// packages/runtime/dist/projects/evidence.js
import { execFileSync } from "node:child_process";
import crypto4 from "node:crypto";
import fs3 from "node:fs";
import os from "node:os";
import path3 from "node:path";

// packages/runtime/dist/projects/service.js
import fs4 from "node:fs";
import path4 from "node:path";

// packages/runtime/dist/scheduler.js
var RuntimeEngineScheduler = class {
  #materializer;
  #outbox;
  #writer;
  #intervalMs;
  #timer;
  #running;
  #lastSuccessfulMaterializationAt;
  #lastTickError;
  constructor(options) {
    this.#materializer = options.materializer;
    this.#outbox = options.outbox;
    this.#writer = options.writer;
    this.#intervalMs = options.intervalMs ?? 250;
    if (!Number.isInteger(this.#intervalMs) || this.#intervalMs < 25)
      throw new Error("runtime scheduler interval must be an integer of at least 25ms");
  }
  async start() {
    if (this.#timer)
      throw new Error("runtime scheduler is already running");
    const initial = await this.tick();
    this.#timer = setInterval(() => {
      void this.tick().catch(() => void 0);
    }, this.#intervalMs);
    return initial;
  }
  async tick() {
    if (this.#running)
      return this.#running;
    const running = (async () => {
      try {
        const materializer = this.#materializer.drain();
        const outbox = await this.#outbox.drain();
        if (materializer.materialized > 0 || materializer.duplicated > 0)
          this.#lastSuccessfulMaterializationAt = (/* @__PURE__ */ new Date()).toISOString();
        this.#lastTickError = void 0;
        return Object.freeze({ materializer, outbox });
      } catch (error2) {
        this.#lastTickError = "runtime tick deferred";
        throw error2;
      } finally {
        this.#running = void 0;
      }
    })();
    this.#running = running;
    return running;
  }
  async stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = void 0;
    }
    if (this.#running)
      await this.#running.catch(() => void 0);
  }
  health() {
    return Object.freeze({
      inbox: this.#materializer.inbox.metrics(),
      outbox: this.#writer.runtimeOutboxHealth(),
      ...this.#lastSuccessfulMaterializationAt ? {
        lastSuccessfulMaterializationAt: this.#lastSuccessfulMaterializationAt
      } : {},
      ...this.#lastTickError ? { lastTickError: this.#lastTickError } : {}
    });
  }
};

// packages/runtime/dist/sessions/index.js
var SessionService = class {
  #options;
  constructor(options) {
    this.#options = options;
  }
  apply(signal, alias) {
    const payload2 = signal.payload;
    if (!("generation" in payload2))
      return {
        disposition: "rejected",
        code: "runtime.session.invalid_payload"
      };
    if (!this.#options.projects.get(payload2.generation.project_id))
      return {
        disposition: "rejected",
        code: "runtime.session.project_unresolved"
      };
    return this.#options.sessions.apply({
      signal,
      ...alias ? { alias } : {}
    });
  }
  observe(input) {
    return this.#options.sessions.observe(input);
  }
  get(projectId2, sessionId) {
    return this.#options.sessions.get(projectId2, sessionId);
  }
  list(projectId2) {
    return this.#options.sessions.list(projectId2);
  }
  attachAlias(input) {
    return this.#options.sessions.attachAlias(input);
  }
  rename(input) {
    return this.#options.sessions.rename(input);
  }
  patchMetadata(input) {
    return this.#options.sessions.patchMetadata(input);
  }
  end(input) {
    return this.#options.sessions.end(input);
  }
};
function createSessionService(options) {
  return new SessionService(options);
}

// apps/control-plane/src/auth.ts
import crypto5 from "node:crypto";
var sessionCookieName = "golem_control_plane_session";
function constantTimeEqual(left, right) {
  const leftDigest = crypto5.createHash("sha256").update(left).digest();
  const rightDigest = crypto5.createHash("sha256").update(right).digest();
  return crypto5.timingSafeEqual(leftDigest, rightDigest);
}
function cookieValue(request, name) {
  const cookies = request.headers.cookie;
  if (!cookies) return void 0;
  let result2;
  for (const part of cookies.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value2 = part.slice(separator + 1).trim();
    if (key !== name) continue;
    if (!value2 || value2.includes("=") || result2) return void 0;
    result2 = value2;
  }
  return result2;
}
function actorContext(binding, source) {
  return Object.freeze({
    principalId: binding.id,
    actorId: binding.actorId,
    role: binding.role,
    defaultProjectId: binding.defaultProjectId,
    scopeProjectIds: binding.scopeProjectIds,
    source,
    bindingVersion: binding.version
  });
}
function nowIso(clock) {
  return new Date(clock.now()).toISOString();
}
function createAuthorizationPolicy() {
  return Object.freeze({
    allows: (context, action) => action === "read" || context.role === "operator",
    allowsProject: (context, projectId2) => context.scopeProjectIds.includes(projectId2)
  });
}
function createFailClosedBrowserPrincipalResolver() {
  return Object.freeze({
    policy: createAuthorizationPolicy(),
    bootstrap: () => Object.freeze({ ok: false }),
    resolve: () => void 0,
    resolveMcp: () => void 0,
    resolveInternal: () => void 0
  });
}
function createBrowserPrincipalResolver(options) {
  const clock = options.clock ?? Date;
  const ttlMs = options.ttlMs ?? 10 * 6e4;
  if (!Number.isInteger(ttlMs) || ttlMs < 1e3 || ttlMs > 24 * 60 * 6e4)
    throw new Error("browser session TTL must be from one second to one day");
  const policy = createAuthorizationPolicy();
  const localBindingId = options.localOperatorBindingId;
  function browser(request, action) {
    if (!isExpectedBrowserRequest(request)) return void 0;
    const session2 = cookieValue(request, sessionCookieName);
    if (!session2) return void 0;
    const csrf = request.headers["x-golem-csrf"];
    if (action === "mutate" && typeof csrf !== "string") return void 0;
    const binding = options.storage.resolveBrowserSession({
      session: session2,
      ...typeof csrf === "string" ? { csrf } : {},
      now: nowIso(clock)
    });
    return binding ? actorContext(binding, "browser") : void 0;
  }
  function bearer2(request) {
    const authorization = request.headers.authorization;
    const match = typeof authorization === "string" ? /^Bearer ([^\s]+)$/u.exec(authorization) : void 0;
    const credential = match?.[1];
    if (!credential) return void 0;
    const binding = options.storage.resolveCredential({
      adapter: "bearer",
      credential,
      now: nowIso(clock)
    });
    if (binding) return actorContext(binding, "bearer");
    const mcp = options.storage.resolveCredential({
      adapter: "mcp",
      credential,
      now: nowIso(clock)
    });
    return mcp ? actorContext(mcp, "mcp") : void 0;
  }
  return Object.freeze({
    policy,
    bootstrap: (request) => {
      if (!localBindingId || !isExpectedOrigin(request.headers.origin, request))
        return Object.freeze({ ok: false });
      const now2 = nowIso(clock);
      const identifier = crypto5.randomUUID();
      const csrf = crypto5.randomBytes(32).toString("base64url");
      const expiresAt = new Date(clock.now() + ttlMs).toISOString();
      if (!options.storage.createBrowserSession({
        bindingId: localBindingId,
        requireOperator: true,
        session: identifier,
        csrf,
        expiresAt,
        now: now2
      }))
        return Object.freeze({ ok: false });
      return Object.freeze({
        ok: true,
        csrf,
        setCookie: `${sessionCookieName}=${identifier}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(ttlMs / 1e3)}`
      });
    },
    resolve: (request, input) => {
      const context = input.allowBrowser ? browser(request, input.action) : void 0;
      const resolved = context ?? (input.allowBearer ? bearer2(request) : void 0);
      return resolved;
    },
    resolveMcp: (credential) => {
      const binding = options.storage.resolveCredential({
        adapter: "mcp",
        credential,
        now: nowIso(clock)
      });
      return binding ? actorContext(binding, "mcp") : void 0;
    },
    resolveInternal: (bindingId) => {
      const binding = options.storage.resolveCredential({
        adapter: "internal",
        credential: bindingId,
        now: nowIso(clock)
      });
      return binding ? actorContext(binding, "internal") : void 0;
    }
  });
}
function hasRequestAuthorityHeaderOverride(request) {
  for (const name of Object.keys(request.headers)) {
    if (/^x-golem-(?:caller|actor|role|project|session|principal|scope|bearer|authorization|token|fence|approval|storage)/iu.test(
      name
    ))
      return true;
  }
  return false;
}
function hasAuthorityOverride(value2) {
  const forbidden = /^(?:actor|created_?by|role|project(?:_?id)?|session(?:_?id)?|bearer|authorization|token|credential|api_?key|owner(?:_?fence|_?id)?|fence|approval|storage|principal|scope|sender_?id|worker_?id)$/iu;
  const visit = (value3) => {
    if (Array.isArray(value3)) return value3.some(visit);
    if (!value3 || typeof value3 !== "object") return false;
    for (const [key, nested] of Object.entries(
      value3
    )) {
      if (forbidden.test(key) || visit(nested)) return true;
    }
    return false;
  };
  return visit(value2);
}
function hasRequestAuthorityHeaderOrQueryOverride(request) {
  return hasRequestAuthorityHeaderOverride(request) || hasAuthorityOverride(request.query);
}
function hasRequestAuthorityHeaderOrBodyOverride(request) {
  return hasRequestAuthorityHeaderOverride(request) || hasAuthorityOverride(request.body);
}
function hasRequestAuthorityOverride(request) {
  return hasRequestAuthorityHeaderOrQueryOverride(request) || hasAuthorityOverride(request.body);
}
function isExpectedHost(host) {
  return Boolean(host && /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/u.test(host));
}
function isExpectedOrigin(origin, request) {
  const host = request.headers.host;
  if (!origin || !host || !isExpectedHost(host)) return false;
  const protocol = request.protocol;
  if (protocol !== "http" && protocol !== "https") return false;
  return constantTimeEqual(origin, `${protocol}://${host}`);
}
function isExpectedBrowserRequest(request) {
  if (isExpectedOrigin(request.headers.origin, request)) return true;
  const host = request.headers.host;
  const referer = request.headers.referer;
  const fetchSite = request.headers["sec-fetch-site"];
  if (typeof fetchSite !== "string" || fetchSite !== "same-origin" || typeof referer !== "string" || !host || !isExpectedHost(host))
    return false;
  try {
    const expected = `${request.protocol}://${host}`;
    return constantTimeEqual(new URL(referer).origin, expected);
  } catch {
    return false;
  }
}

// apps/control-plane/src/browser-settings-services.ts
import { spawnSync as spawnSync3 } from "node:child_process";
import crypto8 from "node:crypto";
import fs8 from "node:fs";
import path10 from "node:path";

// packages/adapters/opencode/dist/config.js
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// packages/launcher/dist/binaries/discovery.js
import fs5 from "node:fs";
import path5 from "node:path";

// packages/launcher/dist/public-safety.js
var diagnosticAssignment = /\b([a-z][a-z0-9_-]*)\s*(?:=|:)/giu;
var diagnosticSecretShape = /\b(?:bearer\s+[a-z0-9._~+/=-]{8,}|sk-[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9_]{8,}|xox[baprs]-[a-z0-9-]{8,}|eyj[a-z0-9_-]{10,}\.[a-z0-9._-]{10,})\b/iu;
var diagnosticMarkerShape = /\b(?:marker|secret|credential|token|password|api[_-]?key)[-_][a-z0-9][a-z0-9_-]{2,}\b/iu;
var diagnosticKey = /^(?:reason|remediation|message|detail|error|diagnostic)$/iu;
var REDACTED_DIAGNOSTIC = "Adapter diagnostic redacted.";
var REDACTED_REMEDIATION = "Use the configured credential provider.";
var MAX_DIAGNOSTIC_LENGTH = 512;
function hasCredentialShape(value2) {
  return hasSensitiveAssignment(value2) || diagnosticSecretShape.test(value2) || diagnosticMarkerShape.test(value2);
}
function normalizeIdentifier(value2) {
  return value2.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase();
}
function isSensitiveIdentifier(value2) {
  return /(?:^|_)(?:api_key|token|credential|password|secret)(?:$|_)/u.test(normalizeIdentifier(value2));
}
function hasSensitiveAssignment(value2) {
  for (const match of value2.matchAll(diagnosticAssignment)) {
    if (match[1] && isSensitiveIdentifier(match[1]))
      return true;
  }
  return false;
}
function isUnsafeDiagnostic(value2) {
  return typeof value2 !== "string" || !value2.trim() || hasCredentialShape(value2);
}
function redactDiagnostic2(value2, kind = "reason") {
  const text3 = String(value2).trim();
  if (!text3 || hasCredentialShape(text3))
    return kind === "remediation" ? REDACTED_REMEDIATION : REDACTED_DIAGNOSTIC;
  if (text3.length <= MAX_DIAGNOSTIC_LENGTH)
    return text3;
  return `${text3.slice(0, MAX_DIAGNOSTIC_LENGTH - 3)}...`;
}
function redactLaunchFacts(value2) {
  const unsafe = isUnsafeDiagnostic(value2.reason) || isUnsafeDiagnostic(value2.remediation);
  return {
    status: unsafe || !["launchable", "unavailable"].includes(value2.status) ? "unavailable" : value2.status,
    reason: unsafe ? REDACTED_DIAGNOSTIC : redactDiagnostic2(value2.reason, "reason"),
    remediation: unsafe ? REDACTED_REMEDIATION : redactDiagnostic2(value2.remediation, "remediation")
  };
}
function redactDeliveryFacts(value2) {
  const unsafe = isUnsafeDiagnostic(value2.reason) || isUnsafeDiagnostic(value2.remediation);
  return {
    mode: value2.mode,
    qualification: value2.qualification,
    readiness: unsafe ? "not_ready" : value2.readiness,
    reason: unsafe ? REDACTED_DIAGNOSTIC : redactDiagnostic2(value2.reason, "reason"),
    remediation: unsafe ? REDACTED_REMEDIATION : redactDiagnostic2(value2.remediation, "remediation")
  };
}
function sanitizePublicValue(value2, key) {
  if (key && isSensitiveIdentifier(key))
    return REDACTED_DIAGNOSTIC;
  if (typeof value2 === "string") {
    if (key && diagnosticKey.test(key)) {
      const kind = /remediation/iu.test(key) ? "remediation" : "reason";
      return redactDiagnostic2(value2, kind);
    }
    return hasCredentialShape(value2) ? REDACTED_DIAGNOSTIC : value2;
  }
  if (Array.isArray(value2))
    return value2.map((child) => sanitizePublicValue(child, key));
  if (value2 && typeof value2 === "object")
    return Object.fromEntries(Object.entries(value2).map(([childKey, child]) => [
      childKey,
      sanitizePublicValue(child, childKey)
    ]));
  return value2;
}

// packages/launcher/dist/types.js
var backends = /* @__PURE__ */ new Set([
  "openai",
  "anthropic",
  "ollama_local",
  "ollama_cloud",
  "native"
]);
var harnesses = /* @__PURE__ */ new Set([
  "claude",
  "codex",
  "opencode",
  "pi"
]);
var modes = /* @__PURE__ */ new Set(["direct", "managed"]);
function isRecord(value2) {
  return value2 !== null && typeof value2 === "object" && !Array.isArray(value2);
}
function deepFreeze(value2) {
  if (value2 && typeof value2 === "object" && !Object.isFrozen(value2)) {
    Object.freeze(value2);
    for (const child of Object.values(value2))
      deepFreeze(child);
  }
  return value2;
}

// packages/launcher/dist/capabilities.js
var defaultQualificationMaxAgeMs = 1e3 * 60 * 60 * 24 * 30;
var evidenceSources = /* @__PURE__ */ new Set([
  "built_in",
  "real_journey",
  "manual_probe",
  "registration"
]);
var evidencePolicies = /* @__PURE__ */ new Set(["observed", "version_qualified"]);
function qualifiedDeliveryFlow(mode, qualification) {
  if (mode === "pull")
    return "pull";
  if (mode === "next_turn")
    return "next_turn";
  return qualification === "supported" ? "push" : "pull";
}
function capability2(id2, harness, mode, backend, modelPattern, deliveryMode, qualification, controlFeatures = [], options = {}) {
  const launch = options.launch ?? {
    status: "launchable",
    reason: "The selected harness, backend, and model have a launch contribution.",
    remediation: "Keep the installed harness and adapter contribution available."
  };
  const readiness = deliveryMode === "next_turn" ? "next_turn" : deliveryMode === "pull" ? "pull_only" : qualification === "supported" ? "ready" : "unsupported";
  return deepFreeze({
    capability: {
      capability_id: id2,
      harness,
      adapter_version: "builtin-v1",
      integration_layers: [
        deliveryMode === "managed_app_server" ? "app_server" : "hooks"
      ],
      qualification,
      delivery_mode: deliveryMode,
      readiness,
      evidence_version: "launcher-builtin-v1"
    },
    mode,
    backend,
    modelPattern,
    deliveryFlow: qualifiedDeliveryFlow(deliveryMode, qualification),
    controlFeatures: [...controlFeatures],
    executable: harness,
    evidenceSource: "built_in",
    evidencePolicy: "version_qualified",
    evidenceObservedAt: "2026-07-20T00:00:00.000Z",
    launchContribution: launch,
    ...options.deliveryReason ? { deliveryReason: options.deliveryReason } : {},
    ...options.deliveryRemediation ? { deliveryRemediation: options.deliveryRemediation } : {}
  });
}
var builtInCapabilities = deepFreeze([
  capability2("codex.openai.managed", "codex", "managed", "openai", "gpt-*", "managed_app_server", "supported", ["resume", "interrupt"]),
  capability2("codex.openai.direct", "codex", "direct", "openai", "gpt-*", "pull", "supported", ["pull"], {
    deliveryReason: "Direct Codex retains Golem pull tools but is not Golem-owned push control.",
    deliveryRemediation: "Use managed golem codex for App Server push/control."
  }),
  capability2("opencode.openai.direct", "opencode", "direct", "openai", "gpt-*", "prompt_bridge", "experimental", [], {
    deliveryReason: "OpenCode prompt delivery is not yet independently consumption-qualified.",
    deliveryRemediation: "Run the OpenCode adapter qualification journey before advertising push readiness."
  }),
  capability2("opencode.ollama-local.direct", "opencode", "direct", "ollama_local", "*", "prompt_bridge", "experimental", [], {
    deliveryReason: "Local Ollama launchability is independent from unproven prompt consumption.",
    deliveryRemediation: "Run the OpenCode local-provider qualification journey before advertising push readiness."
  }),
  capability2("opencode.ollama-cloud.direct", "opencode", "direct", "ollama_cloud", "*", "prompt_bridge", "experimental", [], {
    deliveryReason: "Ollama Cloud launchability does not prove addressed prompt consumption.",
    deliveryRemediation: "Run the OpenCode cloud-provider qualification journey before advertising push readiness."
  }),
  capability2("claude.anthropic.direct", "claude", "direct", "anthropic", "claude-*", "native_channel", "unknown", [], {
    launch: {
      status: "unavailable",
      reason: "Claude Anthropic launch contribution is not installed or qualified in this environment.",
      remediation: "Verify the Claude plugin/channel launch contribution before spawning."
    },
    deliveryReason: "Claude channel consumption has not been proven for this process/provider combination.",
    deliveryRemediation: "Run the Claude channel-consumption qualification journey; until then use pull-only operation."
  }),
  capability2("claude.ollama-local.direct", "claude", "direct", "ollama_local", "*", "native_channel", "unknown", [], {
    deliveryReason: "Claude/Ollama local can launch, but addressed channel consumption is unproven.",
    deliveryRemediation: "Run the real Claude/Ollama consumption journey; until then use pull-only operation."
  }),
  capability2("claude.ollama-cloud.direct", "claude", "direct", "ollama_cloud", "*", "native_channel", "unknown", [], {
    deliveryReason: "Claude/Ollama cloud can launch, but addressed channel consumption is unproven.",
    deliveryRemediation: "Run the real Claude/Ollama consumption journey; until then use pull-only operation."
  }),
  capability2("pi.next-turn.pull", "pi", "direct", "native", "*", "next_turn", "supported", ["pull"], {
    deliveryReason: "Pi consumes a durable delivery only when a real user turn begins.",
    deliveryRemediation: "Keep the canonical generation fence and next-turn inbox available."
  })
]);
function validTime(value2) {
  if (!value2)
    return void 0;
  const parsed = Date.parse(value2);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function capabilityTruth(snapshot, now2, maxAge = defaultQualificationMaxAgeMs) {
  const explicitLaunch = snapshot.launchContribution;
  let status = snapshot.capability.qualification;
  if (!evidenceSources.has(snapshot.evidenceSource) || !evidencePolicies.has(snapshot.evidencePolicy))
    status = "invalid_evidence";
  else if (snapshot.evidenceSource === "registration")
    status = "registration_only";
  const observedAt = validTime(snapshot.evidenceObservedAt);
  const current = validTime(now2);
  if (observedAt === void 0 || current === void 0 || !Number.isFinite(maxAge) || maxAge < 0)
    status = "invalid_evidence";
  if (snapshot.evidencePolicy === "version_qualified" && !snapshot.capability.evidence_version)
    status = "invalid_evidence";
  if (snapshot.evidencePolicy === "observed" && observedAt !== void 0 && current !== void 0) {
    const age = current - observedAt;
    if (age < 0 || age > maxAge)
      status = "stale";
  }
  const evidenceBlockedLaunch = status === "invalid_evidence" ? {
    status: "unavailable",
    reason: "Launch evidence is invalid or incomplete.",
    remediation: snapshot.remediation ?? "Record valid launch evidence before authorizing spawn."
  } : status === "registration_only" ? {
    status: "unavailable",
    reason: "Registration is not a launch authorization.",
    remediation: snapshot.remediation ?? "Record a real launch contribution before authorizing spawn."
  } : void 0;
  const rawLaunch = evidenceBlockedLaunch ?? explicitLaunch ?? {
    status: status === snapshot.capability.qualification && (snapshot.capability.qualification === "supported" || snapshot.capability.qualification === "experimental") ? "launchable" : "unavailable",
    reason: status === snapshot.capability.qualification && (snapshot.capability.qualification === "supported" || snapshot.capability.qualification === "experimental") ? "The selected capability has a qualified launch contribution." : "The selected capability has no independently qualified launch contribution.",
    remediation: snapshot.remediation ?? (status === snapshot.capability.qualification && (snapshot.capability.qualification === "supported" || snapshot.capability.qualification === "experimental") ? "Keep the installed harness and capability contribution available." : "Choose a launchable capability or run its adapter preflight.")
  };
  const launch = deepFreeze(redactLaunchFacts(rawLaunch));
  const launchable = launch.status === "launchable";
  const deliveryReadiness = status === "registration_only" || snapshot.capability.qualification === "unsupported" ? "ineligible" : status === "invalid_evidence" || status === "stale" ? "not_ready" : snapshot.capability.qualification === "supported" && snapshot.capability.readiness === "ready" ? "ready" : "not_ready";
  const rawDelivery = {
    mode: snapshot.capability.delivery_mode,
    qualification: snapshot.capability.qualification,
    readiness: deliveryReadiness,
    reason: snapshot.deliveryReason ?? (deliveryReadiness === "ready" ? "Delivery is qualified by the selected capability evidence." : "Delivery is not independently qualified by the selected capability evidence."),
    remediation: snapshot.deliveryRemediation ?? (deliveryReadiness === "ready" ? "Keep the capability evidence current." : "Run the real adapter consumption journey before advertising push readiness.")
  };
  const delivery = deepFreeze(redactDeliveryFacts(rawDelivery));
  return deepFreeze({
    status,
    launchable,
    remediation: launch.remediation,
    launch,
    delivery
  });
}
function modelMatches(pattern, model) {
  const expression = `^${pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*")}$`;
  return new RegExp(expression, "u").test(model);
}
function capabilityFor(selection, capabilities) {
  return capabilities.filter((snapshot) => snapshot.capability.harness === selection.harness && snapshot.mode === selection.mode && snapshot.backend === selection.backend && snapshot.capability.delivery_mode === selection.deliveryMode && modelMatches(snapshot.modelPattern, selection.modelSelector)).sort((left, right) => right.modelPattern.length - left.modelPattern.length || left.capability.capability_id.localeCompare(right.capability.capability_id))[0];
}
function listCapabilities(capabilities, now2, qualificationMaxAgeMs = defaultQualificationMaxAgeMs) {
  return deepFreeze([...capabilities].map((snapshot) => {
    const truth = capabilityTruth(snapshot, now2, qualificationMaxAgeMs);
    return {
      id: snapshot.capability.capability_id,
      harness: snapshot.capability.harness,
      mode: snapshot.mode,
      backend: snapshot.backend,
      qualification: truth.status,
      launchable: truth.launchable,
      deliveryMode: snapshot.capability.delivery_mode,
      deliveryFlow: snapshot.deliveryFlow,
      readiness: snapshot.capability.readiness,
      controlFeatures: [...snapshot.controlFeatures].sort(),
      evidenceSource: snapshot.evidenceSource,
      evidencePolicy: snapshot.evidencePolicy,
      ...snapshot.capability.evidence_version ? { evidenceVersion: snapshot.capability.evidence_version } : {},
      ...snapshot.evidenceObservedAt ? { observedAt: snapshot.evidenceObservedAt } : {},
      launch: truth.launch,
      delivery: truth.delivery
    };
  }).sort((left, right) => left.id.localeCompare(right.id)));
}

// packages/launcher/dist/config.js
import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser";

// packages/launcher/dist/explain.js
var LauncherResolutionError = class extends Error {
  issue;
  constructor(issue2) {
    super(issue2.code);
    this.name = "LauncherResolutionError";
    this.issue = issue2;
  }
};
function issue(code, message, remediation, severity = "error") {
  return deepFreeze({
    code,
    severity,
    message: redactDiagnostic2(message, "message"),
    remediation: remediation.map((entry2) => redactDiagnostic2(entry2, "remediation"))
  });
}
function failure(error2, trace) {
  return deepFreeze({
    schemaVersion: "golem.launch-plan/v1",
    ok: false,
    error: error2,
    trace: [...trace]
  });
}
function stableLaunchPlanJson(value2) {
  return JSON.stringify(sortJson(sanitizePublicValue(value2)));
}
function sortJson(value2) {
  if (Array.isArray(value2))
    return value2.map(sortJson);
  if (!isRecord(value2))
    return value2;
  return Object.fromEntries(Object.entries(value2).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, sortJson(child)]));
}

// packages/launcher/dist/presets.js
var secretArgument = /^--?(?:api[_-]?key|token|secret|password|credential)(?:=|$)/iu;
var secretInlineValue = /(?:api[_-]?key|token|secret|password|credential)\s*=/iu;
var unsafeExecutable = /[\0\r\n;&|`$<>()]/u;
var builtInPresets = deepFreeze([
  {
    name: "default",
    harness: "codex",
    backend: "openai",
    model_selector: "gpt-*",
    delivery_mode: "managed_app_server",
    native_args: [],
    env_key_refs: ["OPENAI_API_KEY"]
  },
  {
    name: "direct",
    harness: "codex",
    backend: "openai",
    model_selector: "gpt-*",
    delivery_mode: "pull",
    native_args: [],
    env_key_refs: ["OPENAI_API_KEY"]
  },
  {
    name: "default",
    harness: "opencode",
    backend: "openai",
    model_selector: "gpt-*",
    delivery_mode: "prompt_bridge",
    native_args: [],
    env_key_refs: ["OPENAI_API_KEY"]
  },
  {
    name: "local",
    harness: "opencode",
    backend: "ollama_local",
    model_selector: "*",
    delivery_mode: "prompt_bridge",
    native_args: [],
    env_key_refs: []
  },
  {
    name: "cloud",
    harness: "opencode",
    backend: "ollama_cloud",
    model_selector: "*",
    delivery_mode: "prompt_bridge",
    native_args: [],
    env_key_refs: []
  },
  {
    name: "default",
    harness: "claude",
    backend: "anthropic",
    model_selector: "claude-*",
    delivery_mode: "native_channel",
    native_args: [],
    env_key_refs: ["ANTHROPIC_API_KEY"]
  },
  {
    name: "local",
    harness: "claude",
    backend: "ollama_local",
    model_selector: "*",
    delivery_mode: "native_channel",
    native_args: [],
    env_key_refs: []
  },
  {
    name: "cloud",
    harness: "claude",
    backend: "ollama_cloud",
    model_selector: "*",
    delivery_mode: "native_channel",
    native_args: [],
    env_key_refs: []
  },
  {
    name: "default",
    harness: "pi",
    backend: "native",
    model_selector: "*",
    delivery_mode: "next_turn",
    native_args: [],
    env_key_refs: []
  }
]);
function hasControlCharacter(value2) {
  return value2.includes("\0") || value2.includes("\r") || value2.includes("\n");
}
function unsafeArgument(value2) {
  return hasControlCharacter(value2) || secretArgument.test(value2) || secretInlineValue.test(value2);
}
function asPreset(value2, scope) {
  const parsed = LauncherPresetBodySchema.safeParse(value2);
  if (!parsed.success)
    throw new LauncherResolutionError(issue("launcher.config.managed_invalid", `The ${scope} launch preset contains an unsupported managed field or secret-bearing argument.`, [
      "Remove the invalid managed field and keep secrets in the environment or credential provider."
    ]));
  const preset = parsed.data;
  if (scope === "project" && preset.binary_override)
    throw new LauncherResolutionError(issue("launcher.project.binary_override_forbidden", "Project configuration cannot select an executable.", [
      "Move binary_override to trusted user configuration or use the installed harness."
    ]));
  if (preset.binary_override && unsafeExecutable.test(preset.binary_override))
    throw new LauncherResolutionError(issue("launcher.executable.unsafe", "Executable overrides cannot contain shell-control characters.", ["Use an installed executable path without shell syntax."]));
  for (const argument of preset.native_args) {
    if (unsafeArgument(argument))
      throw new LauncherResolutionError(issue("launcher.argv.secret_or_unsafe", "Launch arguments cannot contain secrets or control characters.", [
        "Use direct safe argv values and keep credential values outside configuration."
      ]));
  }
  return deepFreeze({
    name: preset.name,
    harness: preset.harness,
    backend: preset.backend,
    model_selector: preset.model_selector,
    delivery_mode: preset.delivery_mode,
    native_args: [...preset.native_args],
    env_key_refs: [...preset.env_key_refs],
    ...preset.binary_override ? { binary_override: preset.binary_override } : {}
  });
}
function presetKey(preset) {
  return `${preset.harness}:${preset.name}`;
}
function duplicateIssue(presets, scope) {
  const seen = /* @__PURE__ */ new Set();
  for (const preset of presets) {
    const key = presetKey(preset);
    if (seen.has(key))
      return issue("launcher.preset.ambiguous", `The ${scope} configuration declares a preset name more than once for one harness.`, [
        "Rename or remove the duplicate preset; declaration order cannot choose an owner."
      ]);
    seen.add(key);
  }
  return void 0;
}
function emptyConfig() {
  return {
    schemaVersion: "golem.launcher-config/v1",
    harnessDefaults: {},
    presets: []
  };
}
function mergeLauncherConfig(input) {
  const user = input.user?.config ?? emptyConfig();
  const project2 = input.project?.config ?? emptyConfig();
  const duplicate = duplicateIssue(user.presets, "user") ?? duplicateIssue(project2.presets, "project");
  if (duplicate)
    return duplicate;
  const presets = /* @__PURE__ */ new Map();
  for (const preset of [...builtInPresets, ...user.presets, ...project2.presets])
    presets.set(presetKey(preset), preset);
  return deepFreeze({
    schemaVersion: "golem.launcher-config/v1",
    harnessDefaults: {
      ...user.harnessDefaults,
      ...project2.harnessDefaults
    },
    presets: [...presets.values()].sort((left, right) => presetKey(left).localeCompare(presetKey(right)))
  });
}
function findPreset(presets, name, harness) {
  const matches = presets.filter((preset) => preset.name === name && (!harness || preset.harness === harness));
  if (matches.length === 1)
    return matches[0] ?? issue("launcher.preset.unknown", "Preset lookup failed.", []);
  if (matches.length > 1)
    return issue("launcher.preset.ambiguous", "Preset name is defined for more than one harness.", ["Use a harness-scoped preset invocation."]);
  return issue("launcher.preset.unknown", "Preset is not configured for the selected harness.", ["List presets and choose a configured name."]);
}
function isIssue(value2) {
  return "code" in value2;
}
function sourceForDefault(harness, input) {
  if (input.project?.config.harnessDefaults[harness])
    return "project_default";
  if (input.user?.config.harnessDefaults[harness])
    return "user_default";
  return "built_in";
}
function defaultName(harness, input) {
  return input.project?.config.harnessDefaults[harness] ?? input.user?.config.harnessDefaults[harness] ?? "default";
}
function resolvePreset(input, config, trace) {
  const invokedHarness = input.harness;
  if (input.globalPreset) {
    const found2 = findPreset(config.presets, input.globalPreset);
    if (isIssue(found2))
      return failure(found2, trace);
    if (invokedHarness && found2.harness !== invokedHarness)
      return failure(issue("launcher.input.conflict", "The invoked harness conflicts with the invoked global preset.", ["Use the preset's harness or invoke a harness-scoped preset."]), trace);
    trace.push({
      code: "launcher.preset.invoked_global",
      source: "invoked_global",
      detail: found2.name
    });
    return { preset: found2, source: "invoked_global" };
  }
  if (!invokedHarness)
    return failure(issue(input.isTTY ? "launcher.input.harness_required" : "launcher.input.non_tty", input.isTTY ? "A TTY picker belongs to the later CLI layer; resolution needs a harness selection." : "Non-interactive resolution requires an explicit harness or global preset.", ["Pass a harness such as codex, or invoke a global @preset."]), trace);
  if (!harnesses.has(invokedHarness))
    return failure(issue("launcher.harness.unknown", "The requested harness is not supported.", ["Use claude, codex, opencode, or pi."]), trace);
  const name = input.preset ?? defaultName(invokedHarness, input);
  const found = findPreset(config.presets, name, invokedHarness);
  if (isIssue(found))
    return failure(found, trace);
  const source = input.preset ? "invoked_scoped" : sourceForDefault(invokedHarness, input);
  trace.push({ code: `launcher.preset.${source}`, source, detail: found.name });
  return { preset: found, source };
}

// packages/launcher/dist/config.js
function compactHarnessDefaults(defaults) {
  const compact = {};
  for (const harness of harnesses) {
    const value2 = defaults[harness];
    if (value2)
      compact[harness] = value2;
  }
  return compact;
}
function adaptV0(root) {
  const legacyHarnesses = isRecord(root.harnesses) ? root.harnesses : {};
  const harnessDefaults = {};
  if (isRecord(legacyHarnesses.codex))
    harnessDefaults.codex = "default";
  if (isRecord(legacyHarnesses.opencode))
    harnessDefaults.opencode = "default";
  if (isRecord(legacyHarnesses.claudecode))
    harnessDefaults.claude = "default";
  return deepFreeze({
    schemaVersion: "golem.launcher-config/v1",
    harnessDefaults: compactHarnessDefaults(harnessDefaults),
    presets: []
  });
}
function parseJsoncConfig(text3, scope) {
  const errors = [];
  const root = parse(text3, errors, {
    allowTrailingComma: true,
    disallowComments: false
  });
  if (errors.length || !isRecord(root))
    throw new LauncherResolutionError(issue("launcher.config.jsonc_invalid", `The ${scope} configuration is not a valid JSONC object (${errors.map((error2) => printParseErrorCode(error2.error)).join(",") || "object required"}).`, ["Fix the JSONC syntax without removing user-owned keys."]));
  const userOwned = Object.fromEntries(Object.entries(root).filter(([key]) => key !== "schema_version" && key !== "launch"));
  if (root.schema_version === void 0)
    return deepFreeze({
      scope,
      text: text3,
      config: adaptV0(root),
      userOwned,
      warnings: [
        issue("launcher.config.v0_adapted", "Legacy config was read through the explicit v0 adapter and was not rewritten.", [
          "Use an intentional launcher config save to create versioned JSONC."
        ], "warning")
      ]
    });
  const validated = LauncherConfigV1Schema.safeParse({
    schema_version: root.schema_version,
    launch: root.launch
  });
  if (!validated.success)
    throw new LauncherResolutionError(issue("launcher.config.managed_invalid", `The ${scope} launch section has an unknown or invalid managed field.`, [
      "Correct the versioned launch section; user-owned keys outside it are preserved."
    ]));
  const config = validated.data;
  return deepFreeze({
    scope,
    text: text3,
    config: {
      schemaVersion: "golem.launcher-config/v1",
      harnessDefaults: compactHarnessDefaults(config.launch.harness_defaults),
      presets: config.launch.presets.map((preset) => asPreset(preset, scope))
    },
    userOwned,
    warnings: []
  });
}
function renderConfigText(document, config) {
  let nextText = document.text || "{}\n";
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };
  for (const [jsonPath, value2] of [
    [["schema_version"], "golem.launcher-config/v1"],
    [
      ["launch"],
      {
        harness_defaults: config.harnessDefaults,
        presets: config.presets
      }
    ]
  ]) {
    nextText = applyEdits(nextText, modify(nextText, [...jsonPath], value2, { formattingOptions }));
  }
  return nextText.endsWith("\n") ? nextText : `${nextText}
`;
}
function planConfigWrite(path19, document, config) {
  const nextText = renderConfigText(document, config);
  return deepFreeze({
    targetPath: path19,
    backupPath: `${path19}.golem-launcher.bak`,
    temporaryPath: `${path19}.golem-launcher.tmp`,
    preserveUnknownRegions: true,
    sourceBytes: document.text.length,
    nextBytes: nextText.length
  });
}
async function writeJsoncConfig(port, plan, document, config, intent) {
  if (intent !== "save_launcher_config")
    throw new LauncherResolutionError(issue("launcher.config.write_intent_required", "Writing versioned launcher JSONC requires an explicit save intent.", ["Create and review a redacted ConfigWritePlan before writing."]));
  let backupWritten = false;
  let temporaryCleanupEligible = false;
  try {
    await port.writeBackup(plan.backupPath, document.text);
    backupWritten = true;
    temporaryCleanupEligible = true;
    await port.writeTemporary(plan.temporaryPath, renderConfigText(document, config));
    await port.commitTemporary(plan.temporaryPath, plan.targetPath);
  } catch {
    try {
      if (backupWritten) {
        try {
          await port.rollback(plan.targetPath, plan.backupPath);
        } catch {
        }
      }
    } finally {
      if (temporaryCleanupEligible) {
        try {
          await port.removeTemporary(plan.temporaryPath);
        } catch {
        }
      }
    }
    throw new LauncherResolutionError(issue("launcher.config.atomic_write_failed", "The launcher configuration write was interrupted and rolled back.", ["Inspect the preserved backup and retry the explicit save intent."]));
  }
}
function mergeOpenCodeManagedRegion(text3, path19, value2) {
  const errors = [];
  parse(text3, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length)
    throw new LauncherResolutionError(issue("launcher.opencode.jsonc_invalid", "OpenCode JSONC must be valid before a managed region can be updated.", ["Fix syntax without deleting user-owned provider or credential keys."]));
  return applyEdits(text3, modify(text3, [...path19], value2, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" }
  }));
}

// packages/launcher/dist/process/execute.js
import { spawn } from "node:child_process";
import path7 from "node:path";

// packages/launcher/dist/records/launch-record.js
import path6 from "node:path";

// packages/launcher/dist/resolve.js
var secretArgument2 = /^--?(?:api[_-]?key|token|secret|password|credential)(?:=|$)/iu;
var secretInlineValue2 = /(?:api[_-]?key|token|secret|password|credential)\s*=/iu;
function hasControlCharacter2(value2) {
  return value2.includes("\0") || value2.includes("\r") || value2.includes("\n");
}
function hasUnsafeModelCharacter(value2) {
  return /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value2);
}
function safePassthrough(arguments_) {
  for (const argument of arguments_) {
    if (hasControlCharacter2(argument) || secretArgument2.test(argument) || secretInlineValue2.test(argument))
      return issue("launcher.argv.secret_or_unsafe", "Passthrough arguments cannot contain secrets or control characters.", ["Use an environment key reference or a credential provider instead."]);
  }
  return void 0;
}
function safeModelSelector(value2) {
  if (!value2.trim() || hasUnsafeModelCharacter(value2) || secretArgument2.test(value2) || secretInlineValue2.test(value2))
    return issue("launcher.model.invalid", "Model selectors must be non-blank and cannot contain secrets or control characters.", ["Use a model name or wildcard pattern without credential values."]);
  return void 0;
}
function missingEnvironmentKey(preset, available) {
  if (available === void 0)
    return void 0;
  const keys = new Set(available);
  return preset.env_key_refs.find((key) => !keys.has(key));
}
function resolveLaunch(input) {
  const trace = [];
  const config = mergeLauncherConfig(input);
  if ("code" in config)
    return failure(config, trace);
  const selected = resolvePreset(input, config, trace);
  if ("ok" in selected)
    return selected;
  const passthrough = input.passthrough ?? [];
  const passthroughIssue = safePassthrough(passthrough);
  if (passthroughIssue)
    return failure(passthroughIssue, trace);
  const explicit = input.explicit ?? {};
  const presetMode = selected.preset.delivery_mode === "managed_app_server" ? "managed" : "direct";
  const harness = explicit.harness ?? selected.preset.harness;
  const mode = explicit.mode ?? presetMode;
  const backend = explicit.backend ?? selected.preset.backend;
  const modelSelector = explicit.modelSelector ?? selected.preset.model_selector;
  const deliveryMode = explicit.deliveryMode ?? selected.preset.delivery_mode;
  if (!harnesses.has(harness) || !modes.has(mode) || !backends.has(backend))
    return failure(issue("launcher.selection.invalid", "Harness, mode, or backend is not supported.", [
      "Use a configured harness/backend preset or explicit supported value."
    ]), trace);
  const modelIssue = safeModelSelector(modelSelector);
  if (modelIssue)
    return failure(modelIssue, trace);
  const missingKey = missingEnvironmentKey(selected.preset, input.availableEnvironmentKeys);
  if (missingKey)
    return failure(issue("launcher.environment.secret_missing", "A required credential reference is unavailable.", [
      "Provide the named credential through the configured environment or credential provider."
    ]), trace);
  if (harness !== selected.preset.harness || mode !== presetMode || backend !== selected.preset.backend || deliveryMode !== selected.preset.delivery_mode)
    return failure(issue("launcher.override.preset_incompatible", "Explicit launch selection conflicts with dependencies supplied by the selected preset.", [
      "Use a preset for the requested harness, backend, mode, and delivery combination, or omit the conflicting override."
    ]), trace);
  if (Object.keys(explicit).length > 0)
    trace.push({
      code: "launcher.override.explicit",
      source: "explicit",
      detail: "explicit values applied after invoked presets and configuration defaults"
    });
  const provisional = {
    harness,
    mode,
    backend,
    modelSelector,
    deliveryMode,
    adapterId: "unqualified",
    executable: selected.preset.binary_override ?? harness
  };
  const snapshot = capabilityFor(provisional, input.capabilities ?? builtInCapabilities);
  if (!snapshot)
    return failure(issue("launcher.launch.unavailable", "No launch contribution is available for this harness/backend/model/mode combination.", [
      "Choose a listed launchable capability or install/configure its adapter."
    ]), trace);
  const truth = capabilityTruth(snapshot, input.now, input.qualificationMaxAgeMs ?? defaultQualificationMaxAgeMs);
  if (!truth.launchable) {
    if (snapshot.launchContribution && truth.launch.status === "unavailable")
      return failure(issue("launcher.launch.unavailable", "The selected configuration is not launchable.", [truth.launch.remediation]), trace);
    const code = truth.status === "registration_only" ? "launcher.capability.registration_only" : truth.status === "stale" ? "launcher.capability.stale" : truth.status === "invalid_evidence" ? "launcher.capability.invalid_evidence" : "launcher.capability.unqualified";
    return failure(issue(code, "The selected capability is not qualified for launch.", [
      truth.remediation
    ]), trace);
  }
  trace.push({
    code: "launcher.capability.qualified",
    source: "capability",
    detail: `${snapshot.capability.capability_id}:${truth.status}`
  });
  const warnings = [];
  if (truth.delivery.readiness !== "ready")
    warnings.push(issue("launcher.delivery.not_ready", truth.delivery.reason, [truth.delivery.remediation], "warning"));
  const plan = {
    schemaVersion: "golem.launch-plan/v1",
    ok: true,
    selection: {
      ...provisional,
      adapterId: snapshot.capability.capability_id,
      executable: selected.preset.binary_override ?? snapshot.executable
    },
    preset: { name: selected.preset.name, source: selected.source },
    executableRequirement: {
      path: selected.preset.binary_override ?? snapshot.executable,
      mode
    },
    environmentKeyRefs: [...selected.preset.env_key_refs].sort(),
    effectiveArgvIntent: [
      selected.preset.binary_override ?? snapshot.executable,
      ...selected.preset.native_args,
      ...passthrough
    ],
    qualification: {
      status: snapshot.capability.qualification,
      source: snapshot.evidenceSource,
      policy: snapshot.evidencePolicy,
      ...snapshot.capability.evidence_version ? { version: snapshot.capability.evidence_version } : {},
      observedAt: snapshot.evidenceObservedAt ?? ""
    },
    launch: redactLaunchFacts(truth.launch),
    delivery: redactDeliveryFacts(truth.delivery),
    capabilityFacts: {
      deliveryMode: snapshot.capability.delivery_mode,
      deliveryFlow: snapshot.deliveryFlow,
      readiness: snapshot.capability.readiness,
      integrationLayers: [...snapshot.capability.integration_layers].sort(),
      controlFeatures: [...snapshot.controlFeatures].sort()
    },
    warnings,
    trace
  };
  return deepFreeze(plan);
}
function listLauncher(input) {
  const config = mergeLauncherConfig({
    ...input.user ? { user: input.user } : {},
    ...input.project ? { project: input.project } : {}
  });
  const capabilities = listCapabilities(input.capabilities ?? builtInCapabilities, input.now, input.qualificationMaxAgeMs ?? defaultQualificationMaxAgeMs);
  if ("code" in config)
    return deepFreeze({ presets: [], capabilities, issues: [config] });
  return deepFreeze({
    presets: config.presets.map((preset) => ({
      name: preset.name,
      harness: preset.harness,
      backend: preset.backend,
      modelSelector: preset.model_selector
    })).sort((left, right) => `${left.harness}:${left.name}`.localeCompare(`${right.harness}:${right.name}`)),
    capabilities,
    issues: []
  });
}

// packages/adapters/opencode/dist/config.js
import { parse as parse2 } from "jsonc-parser";
var OPENCODE_PROVIDER_PATH = ["provider", "golem"];
var OPENCODE_PROVIDER_MARKER = "golem.opencode.providers/v1";
var OpenCodeConfigError = class extends Error {
  code;
  constructor(code) {
    super(code);
    this.name = "OpenCodeConfigError";
    this.code = code;
  }
};
function validJsonc(text3) {
  const errors = [];
  const value2 = parse2(text3, errors, {
    allowTrailingComma: true,
    disallowComments: false
  });
  return errors.length === 0 && !!value2 && typeof value2 === "object" && !Array.isArray(value2);
}
function openCodeManagedProviderRegion(observations) {
  const providers2 = {};
  for (const observation of [...observations].sort((left, right) => left.provider.localeCompare(right.provider))) {
    providers2[observation.provider] = {
      enabled: observation.available,
      model: observation.modelPattern ?? (observation.provider === "openai" ? "gpt-*" : "*"),
      qualification: observation.responseObserved && observation.deliveryObserved ? "supported" : "unqualified",
      ...observation.version ? { version: observation.version } : {}
    };
  }
  return {
    managed_by: OPENCODE_PROVIDER_MARKER,
    providers: providers2
  };
}
async function createFileConfigPort() {
  return {
    readText: async (path19) => {
      try {
        return await readFile(path19, "utf8");
      } catch (error2) {
        if (error2 && typeof error2 === "object" && "code" in error2 && error2.code === "ENOENT")
          return void 0;
        throw new OpenCodeConfigError("adapter.opencode.config.read_failed");
      }
    },
    writeBackup: async (path19, text3) => {
      await mkdir(dirname(path19), { recursive: true });
      await writeFile(path19, text3, "utf8");
    },
    writeTemporary: async (path19, text3) => {
      await mkdir(dirname(path19), { recursive: true });
      await writeFile(path19, text3, "utf8");
    },
    commitTemporary: async (temporaryPath, targetPath) => {
      await mkdir(dirname(targetPath), { recursive: true });
      await rename(temporaryPath, targetPath);
    },
    rollback: async (targetPath, backupPath) => {
      await rename(backupPath, targetPath);
    },
    removeTemporary: async (path19) => {
      await rm(path19, { force: true });
    }
  };
}
async function setupOpenCodeConfig(input) {
  const port = input.port ?? await createFileConfigPort();
  const source = await port.readText(input.path) ?? "{}\n";
  if (!validJsonc(source))
    throw new OpenCodeConfigError("adapter.opencode.config.invalid");
  const next = mergeOpenCodeManagedRegion(source, OPENCODE_PROVIDER_PATH, openCodeManagedProviderRegion(input.observations));
  const setup = {
    targetPath: input.path,
    managedPath: OPENCODE_PROVIDER_PATH,
    sourceBytes: Buffer.byteLength(source),
    nextBytes: Buffer.byteLength(next),
    changed: source !== next,
    dryRun: !input.apply,
    text: next
  };
  if (!input.apply || source === next)
    return setup;
  const backupPath = `${input.path}.golem-opencode.bak`;
  const temporaryPath = `${input.path}.golem-opencode.tmp`;
  let temporaryCleanupEligible = false;
  try {
    await port.writeBackup(backupPath, source);
    temporaryCleanupEligible = true;
    await port.writeTemporary(temporaryPath, next);
    await port.commitTemporary(temporaryPath, input.path);
  } catch {
    try {
      await port.rollback(input.path, backupPath);
    } catch {
    }
    if (temporaryCleanupEligible) {
      try {
        await port.removeTemporary(temporaryPath);
      } catch {
      }
    }
    throw new OpenCodeConfigError("adapter.opencode.config.atomic_write_failed");
  }
  return setup;
}

// packages/adapters/opencode/dist/ids.js
import { createHash } from "node:crypto";

// packages/adapters/opencode/dist/composition.js
import { resolve } from "node:path";

// packages/adapters/opencode/dist/probes.js
import { spawnSync } from "node:child_process";

// packages/compiler/dist/hash.js
import crypto6 from "node:crypto";

// packages/compiler/dist/render.js
import fs6 from "node:fs";
import path8 from "node:path";
var lockName = ".golem-render-lock.json";
function lockPath(outputDir) {
  return path8.join(outputDir, lockName);
}
function readLock(outputDir) {
  const state = readLockState(outputDir);
  return state.state === "valid" ? state.lock : void 0;
}
function validLock(value2) {
  if (!value2 || typeof value2 !== "object")
    return false;
  const candidate = value2;
  return candidate.schemaVersion === "golem.render-lock/v1" && typeof candidate.target === "string" && typeof candidate.version === "string" && typeof candidate.manifestSha256 === "string" && Array.isArray(candidate.files) && candidate.files.every((file) => file && typeof file.outputPath === "string" && typeof file.mode === "number" && typeof file.sha256 === "string" && Array.isArray(file.provenance));
}
function readLockState(outputDir) {
  if (!fs6.existsSync(outputDir))
    return { state: "missing" };
  try {
    const parsed = JSON.parse(fs6.readFileSync(lockPath(outputDir), "utf8"));
    return validLock(parsed) ? { state: "valid", lock: parsed } : { state: "invalid" };
  } catch {
    return { state: "invalid" };
  }
}
function inspectRender(outputDir) {
  return readLock(outputDir);
}

// apps/control-plane/src/browser-settings-services.ts
import { z as z19 } from "zod";

// apps/control-plane/src/launch-agent.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import crypto7 from "node:crypto";
import fs7 from "node:fs";
import path9 from "node:path";
function escapeXml(value2) {
  return value2.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
function stringValue(value2) {
  return `<string>${escapeXml(value2)}</string>`;
}
function plistPath(directory, label) {
  if (!label.startsWith("dev.golem."))
    throw new Error("LaunchAgent label must remain in the dev.golem namespace");
  return path9.join(directory, `${label}.plist`);
}
function fsyncDirectory2(directory) {
  const descriptor = fs7.openSync(directory, "r");
  try {
    fs7.fsyncSync(descriptor);
  } finally {
    fs7.closeSync(descriptor);
  }
}
function removeDurably(target) {
  try {
    fs7.unlinkSync(target);
    fsyncDirectory2(path9.dirname(target));
  } catch (error2) {
    if (!isCode(error2, "ENOENT")) throw error2;
  }
}
function atomicWrite(target, value2, options) {
  const temporary = `${target}.${crypto7.randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs7.openSync(temporary, "wx", options?.mode ?? 384);
    fs7.writeFileSync(descriptor, value2, "utf8");
    fs7.fchmodSync(descriptor, options?.mode ?? 384);
    fs7.fsyncSync(descriptor);
    fs7.closeSync(descriptor);
    descriptor = void 0;
    fs7.renameSync(temporary, target);
    options?.afterRename?.();
    fsyncDirectory2(path9.dirname(target));
  } catch (error2) {
    if (descriptor !== void 0) fs7.closeSync(descriptor);
    removeDurably(temporary);
    throw error2;
  }
}
function isCode(error2, code) {
  return typeof error2 === "object" && error2 !== null && "code" in error2 && error2.code === code;
}
function launchctlBoundary() {
  return {
    run: (arguments_) => {
      const result2 = spawnSync2("/bin/launchctl", arguments_, {
        encoding: "utf8"
      });
      return Object.freeze({
        status: result2.status ?? 1,
        stdout: result2.stdout ?? "",
        stderr: result2.stderr ?? result2.error?.message ?? ""
      });
    }
  };
}
function launchDomain(uid) {
  if (!Number.isInteger(uid) || uid < 0)
    throw new Error("LaunchAgent requires a non-negative per-user uid");
  return `gui/${uid}`;
}
function launchTarget(label, uid) {
  if (!label.startsWith("dev.golem."))
    throw new Error("LaunchAgent label must remain in the dev.golem namespace");
  return `${launchDomain(uid)}/${label}`;
}
function run(options, arguments_) {
  return (options.runner ?? launchctlBoundary()).run(arguments_);
}
function mustSucceed(result2, action) {
  if (result2.status === 0) return;
  throw new Error(
    `${action} failed: ${(result2.stderr || result2.stdout).trim()}`
  );
}
function renderLaunchAgent(definition) {
  if (!definition.label.startsWith("dev.golem."))
    throw new Error("LaunchAgent label must remain in the dev.golem namespace");
  for (const value2 of [definition.program, definition.workingDirectory])
    if (!path9.isAbsolute(value2))
      throw new Error("LaunchAgent paths must be absolute");
  const argumentsXml = [definition.program, ...definition.arguments].map(stringValue).join("");
  const environmentXml = Object.entries(definition.environment).sort(([left], [right]) => left.localeCompare(right)).map(([key, value2]) => `<key>${escapeXml(key)}</key>${stringValue(value2)}`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key>${stringValue(definition.label)}<key>ProgramArguments</key><array>${argumentsXml}</array><key>WorkingDirectory</key>${stringValue(definition.workingDirectory)}<key>EnvironmentVariables</key><dict>${environmentXml}</dict><key>RunAtLoad</key><false/></dict></plist>
`;
}
function writeDefinition(directory, definition, options) {
  fs7.mkdirSync(directory, { recursive: true, mode: 448 });
  const target = plistPath(directory, definition.label);
  const backupPath = `${target}.previous`;
  const hadExisting = fs7.existsSync(target);
  const prior = hadExisting ? fs7.readFileSync(target, "utf8") : void 0;
  if (prior !== void 0) atomicWrite(backupPath, prior);
  try {
    atomicWrite(target, renderLaunchAgent(definition), {
      ...options?.writeFault ? { afterRename: options.writeFault.afterRename } : {}
    });
    return hadExisting ? Object.freeze({ path: target, backupPath }) : Object.freeze({ path: target });
  } catch (error2) {
    if (hadExisting && fs7.existsSync(backupPath))
      atomicWrite(target, fs7.readFileSync(backupPath, "utf8"));
    else removeDurably(target);
    throw error2;
  }
}
function installLaunchAgent(directory, definition, options) {
  const install = writeDefinition(directory, definition, options);
  if (!options) return install;
  try {
    mustSucceed(
      run(options, ["bootstrap", launchDomain(options.uid), install.path]),
      "launchctl bootstrap"
    );
    return install;
  } catch (error2) {
    rollbackLaunchAgent(install);
    throw error2;
  }
}
function updateLaunchAgent(directory, definition, options) {
  const install = writeDefinition(directory, definition, options);
  if (!options) return install;
  try {
    run(options, ["bootout", launchTarget(definition.label, options.uid)]);
    mustSucceed(
      run(options, ["bootstrap", launchDomain(options.uid), install.path]),
      "launchctl bootstrap update"
    );
    return install;
  } catch (error2) {
    rollbackLaunchAgent(install, options);
    throw error2;
  }
}
function rollbackLaunchAgent(install, options) {
  if (install.backupPath && fs7.existsSync(install.backupPath))
    atomicWrite(install.path, fs7.readFileSync(install.backupPath, "utf8"));
  else removeDurably(install.path);
  if (!options || !fs7.existsSync(install.path)) return;
  const label = path9.basename(install.path).replace(/\.plist$/u, "");
  run(options, ["bootout", launchTarget(label, options.uid)]);
  mustSucceed(
    run(options, ["bootstrap", launchDomain(options.uid), install.path]),
    "launchctl bootstrap rollback"
  );
}
function startLaunchAgent(options) {
  return run(options, [
    "kickstart",
    "-k",
    launchTarget(options.label, options.uid)
  ]);
}
function stopLaunchAgent(options) {
  return run(options, [
    "kill",
    "SIGTERM",
    launchTarget(options.label, options.uid)
  ]);
}
function statusLaunchAgent(options) {
  const target = launchTarget(options.label, options.uid);
  const result2 = run(options, ["print", target]);
  return Object.freeze({
    label: options.label,
    target,
    installed: fs7.existsSync(plistPath(options.directory, options.label)),
    loaded: result2.status === 0,
    detail: (result2.stdout || result2.stderr).trim()
  });
}

// apps/control-plane/src/browser-settings-services.ts
var renderTargets = [
  "cc",
  "cc-marketplace",
  "codex",
  "opencode",
  "pi"
];
var providers = [
  "openai",
  "ollama_cloud",
  "ollama_local"
];
var migrationActionSchema = z19.object({
  id: z19.string().min(1).max(512),
  kind: z19.enum([
    "create",
    "attach",
    "review",
    "quarantine",
    "ignore",
    "retire"
  ])
}).passthrough();
var migrationPlanOutputSchema = z19.object({
  schema_version: z19.literal("golem.compat-migration-plan/v1"),
  plan_hash: z19.string().regex(/^[a-f0-9]{64}$/u),
  actions: z19.array(migrationActionSchema).max(1e4)
}).passthrough();
var migrationStatusOutputSchema = z19.object({
  schema_version: z19.literal("golem.compat-migration-status/v1"),
  status: z19.enum(["applied", "rolled_back", "failed"]),
  plan_hash: z19.string().regex(/^[a-f0-9]{64}$/u)
}).passthrough().nullable();
var cutoverGateOutputSchema = z19.object({
  code: z19.string().min(1).max(128),
  passed: z19.boolean()
}).passthrough();
var cutoverPlanOutputSchema = z19.object({
  schema_version: z19.literal("golem.canonical-cutover-plan/v1"),
  plan_hash: z19.string().regex(/^[a-f0-9]{64}$/u),
  eligible: z19.boolean(),
  canonical_revision: z19.number().int().nonnegative(),
  gates: z19.array(cutoverGateOutputSchema).max(32)
}).passthrough();
var cutoverStatusOutputSchema = z19.object({
  schema_version: z19.literal("golem.canonical-cutover-state/v1"),
  plan_hash: z19.string().regex(/^[a-f0-9]{64}$/u),
  phase: z19.enum([
    "quiesced",
    "checkpointed",
    "soaking",
    "stable",
    "rollback_required",
    "rolled_back"
  ]),
  canonical_revision: z19.number().int().nonnegative()
}).passthrough().nullable();
var BrowserSettingsServiceError = class extends Error {
  code;
  httpStatus;
  constructor(code, httpStatus) {
    super(code);
    this.name = "BrowserSettingsServiceError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
};
function canonical(value2) {
  if (Array.isArray(value2)) return value2.map(canonical);
  if (value2 && typeof value2 === "object") {
    return Object.fromEntries(
      Object.entries(value2).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)])
    );
  }
  return value2;
}
function digest(value2) {
  return crypto8.createHash("sha256").update(JSON.stringify(canonical(value2))).digest("hex");
}
function planHash(value2) {
  return `sha256:${digest(value2)}`;
}
function isCode2(error2, code) {
  return typeof error2 === "object" && error2 !== null && "code" in error2 && error2.code === code;
}
function readText(target) {
  try {
    return fs8.readFileSync(target, "utf8");
  } catch (error2) {
    if (isCode2(error2, "ENOENT")) return void 0;
    throw error2;
  }
}
function atomicWriteText(target, contents, mode = 384) {
  fs8.mkdirSync(path10.dirname(target), { recursive: true, mode: 448 });
  const temporary = path10.join(
    path10.dirname(target),
    `.${path10.basename(target)}.${crypto8.randomUUID()}.tmp`
  );
  try {
    fs8.writeFileSync(temporary, contents, { encoding: "utf8", mode });
    fs8.renameSync(temporary, target);
  } finally {
    fs8.rmSync(temporary, { force: true });
  }
}
function atomicWriteJson(target, value2) {
  atomicWriteText(target, `${JSON.stringify(value2, null, 2)}
`);
}
function configPort() {
  return {
    readText: async (target) => readText(target),
    writeBackup: async (target, text3) => atomicWriteText(target, text3),
    writeTemporary: async (target, text3) => atomicWriteText(target, text3),
    commitTemporary: async (temporary, target) => {
      fs8.mkdirSync(path10.dirname(target), { recursive: true, mode: 448 });
      fs8.renameSync(temporary, target);
    },
    rollback: async (target, backup) => {
      const contents = readText(backup);
      if (contents === void 0)
        throw new Error("settings backup unavailable");
      atomicWriteText(target, contents);
    },
    removeTemporary: async (target) => {
      fs8.rmSync(target, { force: true });
    }
  };
}
function safeText(value2, maximum = 512) {
  return value2.replace(
    /\b(prompt|cookie|csrf|bearer|fence|token|secret|password|credential)\s*[:=][^\r\n]*/giu,
    "$1: [REDACTED]"
  ).replace(/\bBearer\s+[A-Za-z0-9._-]+/giu, "Bearer [REDACTED]").replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY))=\S+/gu, "$1=[REDACTED]").replace(/(?:^|\s)(?:~\/|\/)[^\s]+/gu, " [REDACTED_PATH]").trim().slice(0, maximum) || "No action is required.";
}
function hasExecutable(name, environment) {
  const result2 = spawnSync3("/usr/bin/env", ["which", name], {
    env: environment,
    stdio: "ignore",
    timeout: 5e3
  });
  return result2.status === 0;
}
function safeRelativePath(value2) {
  return value2.length > 0 && value2.length <= 256 && !path10.isAbsolute(value2) && value2 !== ".." && !value2.startsWith(`..${path10.sep}`) && !value2.split(path10.sep).includes("..");
}
function fileDigest(target) {
  try {
    return crypto8.createHash("sha256").update(fs8.readFileSync(target)).digest("hex");
  } catch (error2) {
    if (isCode2(error2, "ENOENT")) return void 0;
    throw error2;
  }
}
function managedFileDigest(target, file) {
  if (!file.beginMarker || !file.endMarker) return fileDigest(target);
  try {
    const text3 = fs8.readFileSync(target, "utf8");
    if (text3.split(file.beginMarker).length !== 2 || text3.split(file.endMarker).length !== 2)
      return void 0;
    const start = text3.indexOf(file.beginMarker) + file.beginMarker.length;
    const contentStart = text3.startsWith("\r\n", start) ? start + 2 : text3.startsWith("\n", start) ? start + 1 : start;
    const end = text3.indexOf(file.endMarker, contentStart);
    if (end < contentStart) return void 0;
    return crypto8.createHash("sha256").update(text3.slice(contentStart, end)).digest("hex");
  } catch (error2) {
    if (isCode2(error2, "ENOENT")) return void 0;
    throw error2;
  }
}
function storedState(value2) {
  if (!value2 || typeof value2 !== "object" || Array.isArray(value2))
    return void 0;
  const row = value2;
  if (row.schema_version !== "golem.browser-settings-state/v1" || !Number.isInteger(row.revision) || row.revision < 0 || !Array.isArray(row.receipts))
    return void 0;
  const receipts = [];
  for (const candidate of row.receipts.slice(-200)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      return void 0;
    const receipt = candidate;
    if (typeof receipt.key_digest !== "string" || typeof receipt.fingerprint !== "string" || typeof receipt.command_id !== "string" || typeof receipt.command_kind !== "string" || !["pending", "completed", "rejected", "failed"].includes(
      String(receipt.status)
    ) || typeof receipt.created_at !== "string")
      return void 0;
    const parsedResult = receipt.result === void 0 ? void 0 : BrowserSettingsCommandResultSchema.safeParse(receipt.result);
    if (parsedResult && !parsedResult.success) return void 0;
    receipts.push({
      key_digest: receipt.key_digest,
      fingerprint: receipt.fingerprint,
      command_id: receipt.command_id,
      command_kind: receipt.command_kind,
      status: receipt.status,
      created_at: receipt.created_at,
      ...typeof receipt.completed_at === "string" ? { completed_at: receipt.completed_at } : {},
      ...parsedResult?.success ? { result: parsedResult.data } : {},
      ...typeof receipt.error_code === "string" ? { error_code: receipt.error_code } : {}
    });
  }
  return {
    schema_version: "golem.browser-settings-state/v1",
    revision: row.revision,
    receipts
  };
}
function commandFingerprint(input) {
  const { idempotency_key: _idempotencyKey, ...safeInput } = input;
  return digest(safeInput);
}
function keyDigest(key) {
  return digest({ idempotency_key: key });
}
function endpointDelivery(endpoints) {
  if (endpoints.some(
    (endpoint3) => endpoint3.state === "healthy" && endpoint3.controlState === "enabled" && endpoint3.consumerReady && endpoint3.consumptionObserved && endpoint3.deliveryObserved && !endpoint3.deliveryFailed
  ))
    return "ready";
  if (endpoints.some((endpoint3) => endpoint3.controlState === "held"))
    return "held";
  if (endpoints.some((endpoint3) => endpoint3.deliveryMode === "next_turn"))
    return "next_turn";
  if (endpoints.some((endpoint3) => endpoint3.deliveryMode === "pull"))
    return "pull_only";
  return "unavailable";
}
function providerCapabilityId(provider) {
  return `opencode.${provider === "ollama_local" ? "ollama-local" : provider === "ollama_cloud" ? "ollama-cloud" : "openai"}.direct`;
}
var BrowserSettingsServicesImpl = class {
  #options;
  #statePath;
  #backupRoot;
  #launcherConfigPath;
  #migrationEntry;
  #environment;
  #now;
  #inFlight = /* @__PURE__ */ new Map();
  #state;
  constructor(options) {
    this.#options = options;
    this.#statePath = path10.join(
      options.home,
      "control-plane",
      "settings-command-receipts.json"
    );
    this.#backupRoot = path10.join(
      options.home,
      "control-plane",
      "settings-backups"
    );
    this.#launcherConfigPath = options.launcherConfigPath ?? path10.join(options.home, "launcher.jsonc");
    this.#migrationEntry = options.migrationEntry ?? path10.resolve(
      path10.dirname(options.cliEntry),
      "../packages/compat/bin/migration-plan.mjs"
    );
    this.#environment = options.environment ?? process.env;
    this.#now = options.now ?? (() => (/* @__PURE__ */ new Date()).toISOString());
    const persisted = readText(this.#statePath);
    if (persisted === void 0) {
      this.#state = {
        schema_version: "golem.browser-settings-state/v1",
        revision: 0,
        receipts: []
      };
    } else {
      try {
        const parsed = storedState(JSON.parse(persisted));
        if (!parsed) throw new Error("invalid settings receipt store");
        this.#state = parsed;
      } catch {
        throw new BrowserSettingsServiceError(
          "browser.settings.unavailable",
          503
        );
      }
    }
  }
  #persist() {
    this.#state.receipts = this.#state.receipts.slice(-200);
    atomicWriteJson(this.#statePath, this.#state);
  }
  #renderDirectory(target) {
    return path10.join(
      this.#options.home,
      "renders",
      target === "cc" ? "cc-plugin" : target
    );
  }
  #renderBackup(target) {
    return path10.join(this.#backupRoot, `render-${target}`);
  }
  #renderLockBackup(target) {
    return path10.join(this.#backupRoot, `render-${target}.legacy-lock.json`);
  }
  #legacyRenderLock(target, directory) {
    const source = readText(path10.join(this.#options.home, "substrate.lock"));
    if (source === void 0) return void 0;
    let root;
    try {
      const parsed = JSON.parse(source);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return void 0;
      root = parsed;
    } catch {
      return void 0;
    }
    const targets = root.targets;
    if (!targets || typeof targets !== "object" || Array.isArray(targets))
      return void 0;
    const key = `${target}::${directory}`;
    const value2 = targets[key];
    if (!value2 || typeof value2 !== "object" || Array.isArray(value2))
      return void 0;
    const entry2 = value2;
    if (entry2.target !== target || entry2.out_dir !== directory)
      return void 0;
    const rows = entry2.files;
    if (!rows || typeof rows !== "object" || Array.isArray(rows))
      return void 0;
    const files = [];
    for (const row of Object.values(rows).slice(
      0,
      500
    )) {
      if (!row || typeof row !== "object" || Array.isArray(row))
        return void 0;
      const file = row;
      if (typeof file.output_path !== "string" || typeof file.output_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(file.output_sha256))
        return void 0;
      files.push({
        outputPath: file.output_path,
        expectedHash: file.output_sha256,
        ...file.kind === "block" && typeof file.begin_marker === "string" && typeof file.end_marker === "string" ? {
          beginMarker: file.begin_marker,
          endMarker: file.end_marker
        } : {}
      });
    }
    return {
      target,
      version: typeof root.package_version === "string" ? root.package_version : "legacy-lock-v1",
      manifestHash: digest({ target, files }),
      files
    };
  }
  #runSync(target, apply) {
    const result2 = spawnSync3(
      process.execPath,
      [
        this.#options.cliEntry,
        "sync",
        ...apply ? [] : ["--check"],
        "--target",
        target
      ],
      {
        cwd: path10.dirname(path10.dirname(this.#options.cliEntry)),
        env: {
          ...this.#environment,
          GOLEM_HOME: this.#options.home
        },
        stdio: "ignore",
        timeout: 12e4
      }
    );
    return result2.status ?? void 0;
  }
  #renderFacts(target, checkSource) {
    const directory = this.#renderDirectory(target);
    const rollbackAvailable = fs8.existsSync(this.#renderBackup(target));
    let lock;
    try {
      const typed = inspectRender(directory);
      lock = typed ? {
        target: typed.target,
        version: typed.version,
        manifestHash: typed.manifestSha256,
        files: typed.files.map((file) => ({
          outputPath: file.outputPath,
          expectedHash: file.sha256
        }))
      } : this.#legacyRenderLock(target, directory);
    } catch {
      return {
        target,
        status: "error",
        managedFiles: [],
        actualHashes: [],
        rollbackAvailable
      };
    }
    if (!lock)
      return {
        target,
        status: "missing",
        managedFiles: [],
        actualHashes: [],
        rollbackAvailable
      };
    const files = lock.files.map((file) => file.outputPath);
    if (lock.target !== target || files.some((file) => !safeRelativePath(file)))
      return {
        target,
        status: "error",
        version: lock.version,
        managedFiles: [],
        manifestHash: lock.manifestHash,
        actualHashes: [],
        rollbackAvailable
      };
    const actualHashes = lock.files.map(
      (file) => managedFileDigest(path10.join(directory, file.outputPath), file) ?? "missing"
    );
    const tamper = lock.files.some(
      (file, index) => actualHashes[index] !== file.expectedHash
    );
    let status = tamper ? "tamper" : "clean";
    if (checkSource && status === "clean") {
      const exit = this.#runSync(target, false);
      status = exit === 0 ? "clean" : exit === 1 ? "drift" : "error";
    }
    return {
      target,
      status,
      version: lock.version,
      managedFiles: files,
      manifestHash: lock.manifestHash,
      actualHashes,
      rollbackAvailable
    };
  }
  #renderPlan(target) {
    const facts = this.#renderFacts(target, true);
    return {
      facts,
      hash: planHash({
        kind: "render",
        target,
        status: facts.status,
        version: facts.version,
        manifest: facts.manifestHash,
        files: facts.managedFiles.map((file, index) => ({
          file,
          actual: facts.actualHashes[index]
        }))
      })
    };
  }
  #backupRender(target) {
    const source = this.#renderDirectory(target);
    const backup = this.#renderBackup(target);
    const lockBackup = this.#renderLockBackup(target);
    fs8.mkdirSync(this.#backupRoot, { recursive: true, mode: 448 });
    fs8.rmSync(backup, { recursive: true, force: true });
    fs8.rmSync(lockBackup, { force: true });
    if (!fs8.existsSync(source)) return false;
    fs8.cpSync(source, backup, {
      recursive: true,
      errorOnExist: true,
      preserveTimestamps: true
    });
    const legacyLock = readText(
      path10.join(this.#options.home, "substrate.lock")
    );
    if (legacyLock !== void 0) {
      try {
        const root = JSON.parse(legacyLock);
        const key = `${target}::${source}`;
        atomicWriteJson(lockBackup, {
          key,
          entry: root.targets?.[key] ?? null
        });
      } catch {
      }
    }
    return true;
  }
  #restoreRender(target) {
    const source = this.#renderBackup(target);
    if (!fs8.existsSync(source))
      throw new BrowserSettingsServiceError("browser.settings.conflict", 409);
    const destination = this.#renderDirectory(target);
    fs8.rmSync(destination, { recursive: true, force: true });
    fs8.mkdirSync(path10.dirname(destination), { recursive: true, mode: 448 });
    fs8.cpSync(source, destination, {
      recursive: true,
      errorOnExist: true,
      preserveTimestamps: true
    });
    const lockBackup = readText(this.#renderLockBackup(target));
    if (lockBackup !== void 0) {
      try {
        const stored = JSON.parse(lockBackup);
        const lockPath2 = path10.join(this.#options.home, "substrate.lock");
        const currentText = readText(lockPath2);
        const current = currentText ? JSON.parse(currentText) : { version: 1, targets: {} };
        if (typeof stored.key === "string") {
          current.targets ??= {};
          if (stored.entry === null) delete current.targets[stored.key];
          else current.targets[stored.key] = stored.entry;
          atomicWriteJson(lockPath2, current);
        }
      } catch {
        throw new BrowserSettingsServiceError(
          "browser.settings.unavailable",
          503
        );
      }
    }
  }
  #serviceStatus() {
    const service = this.#options.service;
    if (!service)
      return {
        installed: false,
        loaded: false,
        backup: false
      };
    try {
      const status = statusLaunchAgent({
        directory: service.directory,
        label: service.definition.label,
        uid: service.uid,
        ...service.runner ? { runner: service.runner } : {}
      });
      const target = path10.join(
        service.directory,
        `${service.definition.label}.plist`
      );
      return {
        installed: status.installed,
        loaded: status.loaded,
        backup: fs8.existsSync(`${target}.previous`)
      };
    } catch {
      return {
        installed: fs8.existsSync(
          path10.join(service.directory, `${service.definition.label}.plist`)
        ),
        loaded: false,
        backup: false
      };
    }
  }
  #servicePlan(action) {
    const status = this.#serviceStatus();
    return {
      status,
      hash: planHash({ kind: "service", action, status })
    };
  }
  #serviceInstall() {
    const service = this.#options.service;
    if (!service)
      throw new BrowserSettingsServiceError(
        "browser.settings.unavailable",
        503
      );
    const target = path10.join(
      service.directory,
      `${service.definition.label}.plist`
    );
    return {
      path: target,
      ...fs8.existsSync(`${target}.previous`) ? { backupPath: `${target}.previous` } : {}
    };
  }
  #ensureServiceCredential() {
    const service = this.#options.service;
    if (!service?.credentialPath) return;
    if (service.credential) {
      atomicWriteText(service.credentialPath, `${service.credential}
`);
      return;
    }
    if (!fs8.existsSync(service.credentialPath))
      throw new BrowserSettingsServiceError(
        "browser.settings.unavailable",
        503
      );
  }
  #runServiceAction(action) {
    const service = this.#options.service;
    if (!service)
      throw new BrowserSettingsServiceError(
        "browser.settings.unavailable",
        503
      );
    const commandOptions = {
      uid: service.uid,
      ...service.runner ? { runner: service.runner } : {}
    };
    if (action === "install" || action === "update")
      this.#ensureServiceCredential();
    switch (action) {
      case "install":
        installLaunchAgent(
          service.directory,
          service.definition,
          commandOptions
        );
        return;
      case "update":
        updateLaunchAgent(
          service.directory,
          service.definition,
          commandOptions
        );
        return;
      case "rollback":
        rollbackLaunchAgent(this.#serviceInstall(), commandOptions);
        return;
      case "start": {
        const result2 = startLaunchAgent({
          label: service.definition.label,
          ...commandOptions
        });
        if (result2.status !== 0)
          throw new BrowserSettingsServiceError(
            "browser.settings.unavailable",
            503
          );
        return;
      }
      case "stop": {
        const result2 = stopLaunchAgent({
          label: service.definition.label,
          ...commandOptions
        });
        if (result2.status !== 0)
          throw new BrowserSettingsServiceError(
            "browser.settings.unavailable",
            503
          );
        return;
      }
      case "restart": {
        const stopped = stopLaunchAgent({
          label: service.definition.label,
          ...commandOptions
        });
        if (stopped.status !== 0)
          throw new BrowserSettingsServiceError(
            "browser.settings.unavailable",
            503
          );
        const started = startLaunchAgent({
          label: service.definition.label,
          ...commandOptions
        });
        if (started.status !== 0)
          throw new BrowserSettingsServiceError(
            "browser.settings.unavailable",
            503
          );
      }
    }
  }
  #providerObservation(provider) {
    const endpoints = this.#options.runtimeProjection.endpoints();
    const capabilityId = providerCapabilityId(provider);
    const matches = endpoints.flatMap(
      (endpoint3) => endpoint3.capabilities.filter((capability3) => capability3.capability === capabilityId).map((capability3) => ({ endpoint: endpoint3, capability: capability3 }))
    );
    const delivered = matches.some(
      ({ endpoint: endpoint3 }) => endpoint3.consumptionObserved && endpoint3.deliveryObserved && !endpoint3.deliveryFailed
    );
    const evidence = matches.map(({ capability: capability3 }) => capability3.observedAt).sort().at(-1);
    const openAiCredentials = Boolean(
      this.#environment.OPENAI_API_KEY ?? this.#environment.OPENCODE_OPENAI_API_KEY
    );
    const cloudCredentials = Boolean(
      this.#environment.OLLAMA_API_KEY ?? this.#environment.OLLAMA_CLOUD_API_KEY
    );
    const localDaemon = Boolean(this.#environment.OLLAMA_HOST) || hasExecutable("ollama", this.#environment);
    const credentials = provider === "openai" ? openAiCredentials : provider === "ollama_cloud" ? cloudCredentials : false;
    const daemon = provider === "ollama_local" && localDaemon;
    return {
      provider,
      available: credentials || daemon,
      credentials,
      daemon,
      responseObserved: delivered,
      deliveryObserved: delivered,
      evidenceSource: matches.length ? "real_journey" : "registration",
      evidencePolicy: matches.length ? "observed" : "version_qualified",
      ...evidence ? { observedAt: evidence } : {}
    };
  }
  async #providerPlan(provider) {
    const source = readText(this.#options.openCodeConfigPath) ?? "{}\n";
    const setup = await setupOpenCodeConfig({
      path: this.#options.openCodeConfigPath,
      observations: providers.map(
        (candidate) => this.#providerObservation(candidate)
      )
    });
    return {
      hash: planHash({
        kind: "provider",
        provider,
        source: digest(source),
        next: digest(setup.text),
        changed: setup.changed
      }),
      changed: setup.changed
    };
  }
  #launcherDocument() {
    const source = readText(this.#launcherConfigPath) ?? "{}\n";
    try {
      return parseJsoncConfig(source, "user");
    } catch {
      throw new BrowserSettingsServiceError("browser.settings.invalid", 400);
    }
  }
  #presetPlan(input) {
    const document = this.#launcherDocument();
    const preset = LauncherPresetBodySchema.parse({
      ...input,
      native_args: [],
      env_key_refs: []
    });
    const nextConfig = {
      ...document.config,
      presets: [
        ...document.config.presets.filter(
          (candidate) => !(candidate.harness === preset.harness && candidate.name === preset.name)
        ),
        preset
      ]
    };
    const nextDocument = {
      ...document,
      config: nextConfig
    };
    const resolution = resolveLaunch({
      harness: preset.harness,
      preset: preset.name,
      isTTY: true,
      now: this.#now(),
      user: nextDocument
    });
    const plan = planConfigWrite(
      this.#launcherConfigPath,
      document,
      nextConfig
    );
    const prior = document.config.presets.find(
      (candidate) => candidate.harness === preset.harness && candidate.name === preset.name
    );
    const changed = !prior || digest(prior) !== digest(preset);
    return {
      document,
      nextConfig,
      plan,
      changed,
      hash: planHash({
        kind: "preset",
        source: digest(document.text),
        preset,
        launch_plan: digest(stableLaunchPlanJson(resolution)),
        next_bytes: plan.nextBytes
      })
    };
  }
  #runMigration(command2, planHash2) {
    const result2 = spawnSync3(
      process.execPath,
      [
        this.#migrationEntry,
        command2,
        "--home",
        this.#options.home,
        "--json",
        ...planHash2 ? ["--plan-hash", planHash2] : []
      ],
      {
        cwd: path10.dirname(this.#options.cliEntry),
        env: this.#environment,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 12e4
      }
    );
    if (result2.status !== 0 || result2.error) {
      const diagnostic = result2.stderr.trim();
      if (/^(?:(?:migration\.(?:not_applied|plan_hash_mismatch|review_required|source_changed))|(?:cutover\.(?:plan_hash_required|plan_hash_mismatch|preflight_failed|source_changed|state_invalid|not_active))):/u.test(
        diagnostic
      ))
        throw new BrowserSettingsServiceError("browser.settings.conflict", 409);
      throw new BrowserSettingsServiceError(
        "browser.settings.unavailable",
        503
      );
    }
    try {
      return JSON.parse(result2.stdout);
    } catch {
      throw new BrowserSettingsServiceError(
        "browser.settings.unavailable",
        503
      );
    }
  }
  #migrationPlanOutput() {
    const parsed = migrationPlanOutputSchema.safeParse(
      this.#runMigration("plan")
    );
    if (!parsed.success)
      throw new BrowserSettingsServiceError(
        "browser.settings.unavailable",
        503
      );
    return parsed.data;
  }
  #migrationStatusOutput() {
    const parsed = migrationStatusOutputSchema.safeParse(
      this.#runMigration("status")
    );
    if (!parsed.success)
      throw new BrowserSettingsServiceError(
        "browser.settings.unavailable",
        503
      );
    return parsed.data;
  }
  async #migrationView() {
    try {
      const plan = this.#migrationPlanOutput();
      const status = this.#migrationStatusOutput();
      const count = (kind) => plan.actions.filter((action) => action.kind === kind).length;
      const review = count("review");
      const quarantine = count("quarantine");
      return {
        status: status?.status === "applied" ? "applied" : status?.status === "rolled_back" ? "rolled_back" : review || quarantine ? "review_required" : "ready",
        plan_hash: `sha256:${plan.plan_hash}`,
        create: count("create"),
        attach: count("attach"),
        review,
        quarantine,
        backup_available: status !== void 0,
        rollback_available: status?.status === "applied"
      };
    } catch {
      return {
        status: "failed",
        create: 0,
        attach: 0,
        review: 0,
        quarantine: 0,
        backup_available: false,
        rollback_available: false
      };
    }
  }
  async #migrationPlan() {
    const plan = this.#migrationPlanOutput();
    return {
      plan,
      hash: `sha256:${plan.plan_hash}`,
      review: plan.actions.filter((action) => action.kind === "review").length,
      quarantine: plan.actions.filter((action) => action.kind === "quarantine").length,
      affected: plan.actions.filter(
        (action) => ["create", "attach", "review", "quarantine"].includes(action.kind)
      ).map((action) => `migration:${action.kind}:${action.id}`).slice(0, 500)
    };
  }
  #cutoverPlanOutput() {
    const parsed = cutoverPlanOutputSchema.safeParse(
      this.#runMigration("cutover-plan")
    );
    if (!parsed.success)
      throw new BrowserSettingsServiceError(
        "browser.settings.unavailable",
        503
      );
    return parsed.data;
  }
  #cutoverStatusOutput() {
    const parsed = cutoverStatusOutputSchema.safeParse(
      this.#runMigration("cutover-status")
    );
    if (!parsed.success)
      throw new BrowserSettingsServiceError(
        "browser.settings.unavailable",
        503
      );
    return parsed.data;
  }
  async #cutoverView() {
    try {
      const plan = this.#cutoverPlanOutput();
      const status = this.#cutoverStatusOutput();
      const failed = plan.gates.filter((gate) => !gate.passed).map((gate) => gate.code);
      return {
        status: status?.phase ?? (plan.eligible ? "ready" : failed.includes("cutover.migration_applied") ? "not_ready" : "blocked"),
        plan_hash: `sha256:${plan.plan_hash}`,
        canonical_revision: plan.canonical_revision,
        failed_gates: failed,
        rollback_available: status !== null && status.phase !== "rolled_back"
      };
    } catch {
      return {
        status: "failed",
        canonical_revision: 0,
        failed_gates: [],
        rollback_available: false
      };
    }
  }
  async #cutoverPlan() {
    const plan = this.#cutoverPlanOutput();
    return {
      plan,
      hash: `sha256:${plan.plan_hash}`,
      failed: plan.gates.filter((gate) => !gate.passed),
      affected: plan.gates.map((gate) => `cutover:gate:${gate.code}`).slice(0, 500)
    };
  }
  async snapshot() {
    const document = (() => {
      try {
        return this.#launcherDocument();
      } catch {
        return void 0;
      }
    })();
    const launcher = listLauncher({
      now: this.#now(),
      ...document ? { user: document } : {}
    });
    const endpoints = this.#options.runtimeProjection.endpoints();
    const service = this.#serviceStatus();
    const endpointByCapability = (id2) => endpoints.filter(
      (endpoint3) => endpoint3.capabilities.some(
        (capability3) => capability3.capability === id2
      )
    );
    const configuredBackend = (backend) => {
      if (backend === "native") return "not_applicable";
      if (backend === "openai")
        return this.#environment.OPENAI_API_KEY ? "configured" : "unconfigured";
      if (backend === "anthropic")
        return this.#environment.ANTHROPIC_API_KEY ? "configured" : "unconfigured";
      if (backend === "ollama_cloud")
        return this.#environment.OLLAMA_API_KEY ?? this.#environment.OLLAMA_CLOUD_API_KEY ? "configured" : "unconfigured";
      return this.#environment.OLLAMA_HOST || hasExecutable("ollama", this.#environment) ? "configured" : "unconfigured";
    };
    const userPresetKeys = new Set(
      document?.config.presets.map(
        (preset) => `${preset.harness}:${preset.name}`
      ) ?? []
    );
    const builtInPresetKeys = new Set(
      builtInPresets.map((preset) => `${preset.harness}:${preset.name}`)
    );
    const providerViews = providers.map((provider) => {
      const observation = this.#providerObservation(provider);
      const matched = endpointByCapability(providerCapabilityId(provider));
      const delivered = matched.some(
        (endpoint3) => endpoint3.consumptionObserved && endpoint3.deliveryObserved && !endpoint3.deliveryFailed
      );
      const qualification = delivered ? "supported" : observation.available ? "experimental" : "unknown";
      return {
        provider,
        configured: observation.credentials || observation.daemon,
        qualification,
        delivery_ready: delivered,
        rollback_available: fs8.existsSync(
          `${this.#options.openCodeConfigPath}.golem-opencode.bak`
        )
      };
    });
    const [migration2, cutover] = await Promise.all([
      this.#migrationView(),
      this.#cutoverView()
    ]);
    return BrowserSettingsSnapshotSchema.parse({
      schema_version: "golem.browser-settings/v1",
      revision: this.#state.revision,
      service: {
        installed: service.installed,
        process: service.loaded ? "running" : "stopped",
        api: "ready",
        delivery: endpointDelivery(endpoints),
        actions: [
          ...service.installed ? ["start", "update"] : ["install"],
          ...service.loaded ? ["stop", "restart"] : [],
          ...service.backup ? ["rollback"] : []
        ]
      },
      renders: renderTargets.map((target) => {
        const facts = this.#renderFacts(target, false);
        return {
          target,
          status: facts.status,
          ...facts.version ? { version: facts.version } : {},
          managed_files: facts.managedFiles,
          rollback_available: facts.rollbackAvailable
        };
      }),
      capabilities: launcher.capabilities.map((capability3) => {
        const matched = endpointByCapability(capability3.id);
        const healthy = matched.some(
          (endpoint3) => endpoint3.state === "healthy" && endpoint3.controlState !== "disabled"
        );
        const degraded = matched.some(
          (endpoint3) => endpoint3.state === "degraded" || endpoint3.deliveryFailed
        );
        const delivered = matched.some(
          (endpoint3) => endpoint3.consumptionObserved && endpoint3.deliveryObserved && !endpoint3.deliveryFailed
        );
        return {
          opaque_id: `cap_${digest(capability3.id).slice(0, 24)}`,
          harness: capability3.harness,
          backend: capability3.backend,
          model_pattern: builtInCapabilitiesModelPattern(capability3.id) ?? "*",
          binary: hasExecutable(
            capability3.harness === "claude" ? "claude" : capability3.harness,
            this.#environment
          ) ? "available" : "unavailable",
          provider: configuredBackend(capability3.backend),
          model: capability3.qualification === "supported" ? "supported" : capability3.qualification === "experimental" ? "experimental" : capability3.qualification === "unsupported" ? "unsupported" : "unknown",
          qualification: capability3.qualification,
          endpoint: healthy ? "healthy" : degraded ? "degraded" : "absent",
          delivery: capability3.deliveryMode === "next_turn" ? "next_turn" : capability3.deliveryMode === "pull" ? "pull_only" : delivered ? "ready" : capability3.delivery.readiness === "ineligible" ? "ineligible" : "not_ready",
          ...capability3.evidenceVersion ? { evidence_version: capability3.evidenceVersion } : {},
          ...capability3.observedAt ? { evidence_at: capability3.observedAt } : {},
          remedy: safeText(
            capability3.delivery.remediation || capability3.launch.remediation
          )
        };
      }),
      providers: providerViews,
      presets: launcher.presets.map((preset) => {
        const key = `${preset.harness}:${preset.name}`;
        return {
          name: preset.name,
          harness: preset.harness,
          backend: preset.backend,
          model_selector: preset.modelSelector,
          source: userPresetKeys.has(key) ? "user" : builtInPresetKeys.has(key) ? "built_in" : "user"
        };
      }),
      migration: migration2,
      cutover,
      unknown_config_keys_preserved: document !== void 0,
      unknown_config_key_count: document ? Object.keys(document.userOwned).length : 0,
      audit: [...this.#state.receipts].reverse().slice(0, 50).map((receipt) => ({
        command_id: receipt.command_id,
        command_kind: receipt.command_kind,
        status: receipt.status,
        created_at: receipt.created_at,
        ...receipt.completed_at ? { completed_at: receipt.completed_at } : {}
      }))
    });
  }
  async #execute(input) {
    const nextRevision = this.#state.revision + 1;
    switch (input.kind) {
      case "render.preview": {
        const plan = this.#renderPlan(input.target);
        return BrowserSettingsCommandResultSchema.parse({
          command_kind: input.kind,
          outcome: "previewed",
          summary: `Render ${input.target} is ${plan.facts.status}.`,
          plan_hash: plan.hash,
          changed: plan.facts.status !== "clean",
          affected: plan.facts.managedFiles.map(
            (file) => `render:${input.target}/${file}`
          ),
          rollback_available: plan.facts.rollbackAvailable,
          snapshot_revision: nextRevision
        });
      }
      case "render.apply": {
        const plan = this.#renderPlan(input.target);
        if (plan.hash !== input.plan_hash)
          throw new BrowserSettingsServiceError(
            "browser.settings.conflict",
            409
          );
        if (plan.facts.status === "tamper" || plan.facts.status === "error")
          throw new BrowserSettingsServiceError(
            "browser.settings.conflict",
            409
          );
        const backup = this.#backupRender(input.target);
        const exit = this.#runSync(input.target, true);
        if (exit !== 0) {
          if (backup) this.#restoreRender(input.target);
          throw new BrowserSettingsServiceError(
            "browser.settings.unavailable",
            503
          );
        }
        const current = this.#renderFacts(input.target, false);
        return BrowserSettingsCommandResultSchema.parse({
          command_kind: input.kind,
          outcome: "applied",
          summary: `Render ${input.target} was compiled from canonical substrate.`,
          changed: plan.facts.status !== "clean",
          affected: current.managedFiles.map(
            (file) => `render:${input.target}/${file}`
          ),
          rollback_available: backup,
          snapshot_revision: nextRevision
        });
      }
      case "render.rollback": {
        this.#restoreRender(input.target);
        const current = this.#renderFacts(input.target, false);
        return BrowserSettingsCommandResultSchema.parse({
          command_kind: input.kind,
          outcome: "rolled_back",
          summary: `Render ${input.target} was restored from its managed backup.`,
          changed: true,
          affected: current.managedFiles.map(
            (file) => `render:${input.target}/${file}`
          ),
          rollback_available: true,
          snapshot_revision: nextRevision
        });
      }
      case "service.preview": {
        const plan = this.#servicePlan(input.action);
        return BrowserSettingsCommandResultSchema.parse({
          command_kind: input.kind,
          outcome: "previewed",
          summary: `Service ${input.action} is ready for explicit confirmation.`,
          plan_hash: plan.hash,
          changed: true,
          affected: ["service:control-plane"],
          rollback_available: plan.status.backup,
          snapshot_revision: nextRevision
        });
      }
      case "service.apply": {
        const plan = this.#servicePlan(input.action);
        if (plan.hash !== input.plan_hash)
          throw new BrowserSettingsServiceError(
            "browser.settings.conflict",
            409
          );
        this.#runServiceAction(input.action);
        return BrowserSettingsCommandResultSchema.parse({
          command_kind: input.kind,
          outcome: "applied",
          summary: `Service ${input.action} completed.`,
          changed: true,
          affected: ["service:control-plane"],
          rollback_available: this.#serviceStatus().backup,
          snapshot_revision: nextRevision
        });
      }
      case "provider.preview": {
        const plan = await this.#providerPlan(input.provider);
        return BrowserSettingsCommandResultSchema.parse({
          command_kind: input.kind,
          outcome: "previewed",
          summary: `OpenCode ${input.provider} managed setup is ready for review.`,
          plan_hash: plan.hash,
          changed: plan.changed,
          affected: [`provider:opencode/${input.provider}`],
          rollback_available: fs8.existsSync(
            `${this.#options.openCodeConfigPath}.golem-opencode.bak`
          ),
          snapshot_revision: nextRevision
        });
      }
      case "provider.apply": {
        const plan = await this.#providerPlan(input.provider);
        if (plan.hash !== input.plan_hash)
          throw new BrowserSettingsServiceError(
            "browser.settings.conflict",
            409
          );
        await setupOpenCodeConfig({
          path: this.#options.openCodeConfigPath,
          observations: providers.map(
            (candidate) => this.#providerObservation(candidate)
          ),
          apply: true
        });
        return BrowserSettingsCommandResultSchema.parse({
          command_kind: input.kind,
          outcome: "applied",
          summary: `OpenCode ${input.provider} managed setup was applied without replacing other providers.`,
          changed: plan.changed,
          affected: [`provider:opencode/${input.provider}`],
          rollback_available: true,
          snapshot_revision: nextRevision
        });
      }
      case "provider.rollback": {
        const backup = `${this.#options.openCodeConfigPath}.golem-opencode.bak`;
        const source = readText(backup);
        if (source === void 0)
          throw new BrowserSettingsServiceError(
            "browser.settings.conflict",
            409
          );
        atomicWriteText(this.#options.openCodeConfigPath, source);
        return BrowserSettingsCommandResultSchema.parse({
          command_kind: input.kind,
          outcome: "rolled_back",
          summary: "OpenCode managed provider setup was restored.",
          changed: true,
          affected: ["provider:opencode"],
          rollback_available: true,
          snapshot_revision: nextRevision
        });
      }
      case "preset.preview": {
        const plan = this.#presetPlan(input.preset);
        return BrowserSettingsCommandResultSchema.parse({
          command_kind: input.kind,
          outcome: "previewed",
          summary: `Preset ${input.preset.name} resolves through the canonical launch plan.`,
          plan_hash: plan.hash,
          changed: plan.changed,
          affected: [`preset:${input.preset.harness}/${input.preset.name}`],
          rollback_available: fs8.existsSync(plan.plan.backupPath),
          snapshot_revision: nextRevision
        });
      }
      case "preset.apply": {
        const plan = this.#presetPlan(input.preset);
        if (plan.hash !== input.plan_hash)
          throw new BrowserSettingsServiceError(
            "browser.settings.conflict",
            409
          );
        await writeJsoncConfig(
          configPort(),
          plan.plan,
          plan.document,
          plan.nextConfig,
          "save_launcher_config"
        );
        return BrowserSettingsCommandResultSchema.parse({
          command_kind: input.kind,
          outcome: "applied",
          summary: `Preset ${input.preset.name} was saved while preserving unknown configuration.`,
          changed: plan.changed,
          affected: [`preset:${input.preset.harness}/${input.preset.name}`],
          rollback_available: true,
          snapshot_revision: nextRevision
        });
      }
      case "preset.rollback": {
        const backup = `${this.#launcherConfigPath}.golem-launcher.bak`;
        const source = readText(backup);
        if (source === void 0)
          throw new BrowserSettingsServiceError(
            "browser.settings.conflict",
            409
          );
        atomicWriteText(this.#launcherConfigPath, source);
        return BrowserSettingsCommandResultSchema.parse({
          command_kind: input.kind,
          outcome: "rolled_back",
          summary: "Launcher presets were restored from the managed backup.",
          changed: true,
          affected: ["preset:launcher"],
          rollback_available: true,
          snapshot_revision: nextRevision
        });
      }
      case "migration.preview": {
        const plan = await this.#migrationPlan();
        return BrowserSettingsCommandResultSchema.parse({
          command_kind: input.kind,
          outcome: "previewed",
          summary: plan.review || plan.quarantine ? "Migration requires explicit review or quarantine decisions." : "Migration dry-run is ready for exact-hash confirmation.",
          plan_hash: plan.hash,
          changed: plan.affected.length > 0,
          affected: plan.affected,
          rollback_available: false,
          snapshot_revision: nextRevision
        });
      }
      case "migration.apply": {
        const plan = await this.#migrationPlan();
        if (plan.hash !== input.plan_hash)
          throw new BrowserSettingsServiceError(
            "browser.settings.conflict",
            409
          );
        if (plan.review || plan.quarantine)
          throw new BrowserSettingsServiceError(
            "browser.settings.conflict",
            409
          );
        this.#runMigration("apply", plan.plan.plan_hash);
        return BrowserSettingsCommandResultSchema.parse({
          command_kind: input.kind,
          outcome: "applied",
          summary: "Legacy state was migrated from the confirmed dry-run with backups.",
          changed: true,
          affected: plan.affected,
          rollback_available: true,
          snapshot_revision: nextRevision
        });
      }
      case "migration.rollback": {
        this.#runMigration("rollback");
        return BrowserSettingsCommandResultSchema.parse({
          command_kind: input.kind,
          outcome: "rolled_back",
          summary: "Legacy migration was restored from its canonical backup.",
          changed: true,
          affected: ["migration:canonical-state"],
          rollback_available: false,
          snapshot_revision: nextRevision
        });
      }
      case "cutover.preview": {
        const plan = await this.#cutoverPlan();
        return BrowserSettingsCommandResultSchema.parse({
          command_kind: input.kind,
          outcome: "previewed",
          summary: plan.plan.eligible ? "Canonical C4 cutover is ready for exact-hash confirmation." : `Canonical C4 cutover is blocked by ${plan.failed.length} preflight gate(s).`,
          plan_hash: plan.hash,
          changed: true,
          affected: plan.affected,
          rollback_available: false,
          snapshot_revision: nextRevision
        });
      }
      case "cutover.apply": {
        const plan = await this.#cutoverPlan();
        if (plan.hash !== input.plan_hash || !plan.plan.eligible)
          throw new BrowserSettingsServiceError(
            "browser.settings.conflict",
            409
          );
        await this.#options.beforeCutover?.();
        this.#runMigration("cutover-apply", plan.plan.plan_hash);
        this.#options.afterCutover?.();
        return BrowserSettingsCommandResultSchema.parse({
          command_kind: input.kind,
          outcome: "applied",
          summary: "Canonical C4 authority was switched atomically and entered its soak window.",
          changed: true,
          affected: [
            "cutover:authority",
            "cutover:legacy-writers",
            "cutover:compatibility-export"
          ],
          rollback_available: true,
          snapshot_revision: nextRevision
        });
      }
      case "cutover.soak": {
        this.#runMigration("cutover-soak");
        return BrowserSettingsCommandResultSchema.parse({
          command_kind: input.kind,
          outcome: "applied",
          summary: "Canonical cutover soak gates passed and the C4 authority is stable.",
          changed: true,
          affected: ["cutover:soak"],
          rollback_available: true,
          snapshot_revision: nextRevision
        });
      }
      case "cutover.rollback": {
        await this.#options.beforeCutover?.();
        this.#runMigration("cutover-rollback");
        this.#options.afterCutover?.();
        return BrowserSettingsCommandResultSchema.parse({
          command_kind: input.kind,
          outcome: "rolled_back",
          summary: "Canonical facts were audited and the single authority pointer returned to C3.",
          changed: true,
          affected: ["cutover:authority", "cutover:rollback-audit"],
          rollback_available: false,
          snapshot_revision: nextRevision
        });
      }
    }
  }
  async command(input) {
    const key = keyDigest(input.idempotency_key);
    const fingerprint3 = commandFingerprint(input);
    const existing = this.#state.receipts.find(
      (receipt2) => receipt2.key_digest === key
    );
    if (existing) {
      if (existing.fingerprint !== fingerprint3)
        throw new BrowserSettingsServiceError(
          "command.idempotency_mismatch",
          409
        );
      if (existing.status === "completed" && existing.result)
        return BrowserSettingsCommandResponseSchema.parse({
          schema_version: "golem.browser-settings-command/v1",
          command_id: existing.command_id,
          status: "completed",
          result: existing.result
        });
      if (existing.status === "pending") {
        const running = this.#inFlight.get(key);
        if (running) return running;
        return BrowserSettingsCommandResponseSchema.parse({
          schema_version: "golem.browser-settings-command/v1",
          command_id: existing.command_id,
          status: "pending"
        });
      }
      throw new BrowserSettingsServiceError(
        existing.error_code ?? "browser.settings.unavailable",
        existing.status === "rejected" ? 409 : 503
      );
    }
    const receipt = {
      key_digest: key,
      fingerprint: fingerprint3,
      command_id: `set_${crypto8.randomUUID()}`,
      command_kind: input.kind,
      status: "pending",
      created_at: this.#now()
    };
    this.#state.receipts.push(receipt);
    this.#persist();
    const operation2 = (async () => {
      try {
        const result2 = await this.#execute(input);
        const completed = {
          ...receipt,
          status: "completed",
          completed_at: this.#now(),
          result: result2
        };
        this.#state.receipts = this.#state.receipts.map(
          (candidate) => candidate.command_id === receipt.command_id ? completed : candidate
        );
        this.#state.revision += 1;
        this.#persist();
        return BrowserSettingsCommandResponseSchema.parse({
          schema_version: "golem.browser-settings-command/v1",
          command_id: receipt.command_id,
          status: "completed",
          result: result2
        });
      } catch (error2) {
        const serviceError = error2 instanceof BrowserSettingsServiceError ? error2 : new BrowserSettingsServiceError(
          "browser.settings.unavailable",
          503
        );
        const failed = {
          ...receipt,
          status: serviceError.code === "browser.settings.conflict" || serviceError.code === "browser.settings.invalid" || serviceError.code === "command.idempotency_mismatch" ? "rejected" : "failed",
          completed_at: this.#now(),
          error_code: serviceError.code
        };
        this.#state.receipts = this.#state.receipts.map(
          (candidate) => candidate.command_id === receipt.command_id ? failed : candidate
        );
        this.#state.revision += 1;
        this.#persist();
        throw serviceError;
      } finally {
        this.#inFlight.delete(key);
      }
    })();
    this.#inFlight.set(key, operation2);
    return operation2;
  }
};
function builtInCapabilitiesModelPattern(id2) {
  const patterns = {
    "codex.openai.managed": "gpt-*",
    "codex.openai.direct": "gpt-*",
    "opencode.openai.direct": "gpt-*",
    "opencode.ollama-local.direct": "*",
    "opencode.ollama-cloud.direct": "*",
    "claude.anthropic.direct": "claude-*",
    "claude.ollama-local.direct": "*",
    "claude.ollama-cloud.direct": "*",
    "pi.next-turn.pull": "*"
  };
  return patterns[id2];
}
function createBrowserSettingsServices(options) {
  return new BrowserSettingsServicesImpl(options);
}

// apps/control-plane/src/browser-work-services.ts
import crypto9 from "node:crypto";
var browserPageSize = 100;
function safeBrowserText(value2, maximum) {
  return value2.replace(/\bprompt\b[^\r\n]*/giu, "[REDACTED_PROMPT]").replace(
    /\b(prompt|cookie|csrf|bearer|fence)\s*:[^\r\n]*/giu,
    "$1: [REDACTED]"
  ).replace(/\bcommand\s+prose\b[^\r\n]*/giu, "[REDACTED_COMMAND]").replace(/\bBearer\s+[A-Za-z0-9._-]+/giu, "Bearer [REDACTED]").replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY))=\S+/gu, "$1=[REDACTED]").replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED]@").replace(/(?:^|\s)(?:~\/|\/)[^\s]+/gu, " [REDACTED_PATH]").slice(0, maximum);
}
function authorKind(author) {
  if (author === "human" || author.startsWith("human:")) return "human";
  if (author.startsWith("ses_") || author.startsWith("codex-") || author.startsWith("claude-"))
    return "session";
  return "system";
}
function ticketView(ticket, legalPhases, visibleIds, visibleStreamIds) {
  return BrowserWorkTicketSchema.parse({
    opaque_id: ticket.id,
    kind: ticket.kind,
    title: safeBrowserText(ticket.title, 256) || "Untitled",
    state: ticket.state,
    phase: ticket.phase,
    priority: ticket.priority,
    labels: ticket.labels.map(
      (label) => safeBrowserText(label, 64) || "[REDACTED]"
    ),
    ...ticket.parentId && (!visibleIds || visibleIds.has(ticket.parentId)) ? { parent_opaque_id: ticket.parentId } : {},
    ...ticket.streamId && (!visibleStreamIds || visibleStreamIds.has(ticket.streamId)) ? { stream_opaque_id: ticket.streamId } : {},
    ...ticket.wave === void 0 ? {} : { wave: ticket.wave },
    legal_phases: legalPhases,
    has_assignee: ticket.assignee !== void 0,
    revision: ticket.revision,
    updated_at: ticket.updatedAt
  });
}
function browserWorkCommentView(comment) {
  return BrowserWorkCommentSchema.parse({
    opaque_id: comment.id,
    ...comment.parentId ? { parent_opaque_id: comment.parentId } : {},
    author_kind: authorKind(comment.author),
    body: safeBrowserText(comment.body, 16384),
    tag: safeBrowserText(comment.tag, 64) || "note",
    status: safeBrowserText(comment.status, 64) || "open",
    revision: comment.revision,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt
  });
}
function browserWorkLinkView(link, subjectTicketId) {
  const opaqueId3 = BrowserOpaqueIdSchema.safeParse(link.id).success ? link.id : `lnk_${crypto9.createHash("sha256").update(link.id).digest("hex").slice(0, 24)}`;
  const targetTicketId = subjectTicketId && link.ticketId && link.ticketId !== subjectTicketId ? link.ticketId : link.targetTicketId;
  return BrowserWorkLinkSchema.parse({
    opaque_id: opaqueId3,
    target_opaque_id: targetTicketId,
    relation: link.relation,
    ...link.createdAt ? { created_at: link.createdAt } : {}
  });
}
function browserWorkStreamView(stream) {
  return BrowserWorkTrackerStreamSchema.parse({
    opaque_id: stream.id,
    name: safeBrowserText(stream.name, 256) || "Untitled stream",
    mode: stream.mode,
    description: safeBrowserText(stream.description, 4096),
    revision: stream.revision,
    updated_at: stream.updatedAt
  });
}
function browserWorkIdeaView(idea) {
  return BrowserWorkIdeaSchema.parse({
    opaque_id: idea.id,
    body: safeBrowserText(idea.body, 16384),
    status: idea.status,
    ...idea.promotedTicketId ? { promoted_ticket_opaque_id: idea.promotedTicketId } : {},
    created_at: idea.createdAt,
    updated_at: idea.updatedAt
  });
}
function assetMetadataView(asset) {
  return BrowserWorkAssetMetadataSchema.parse({
    opaque_id: asset.id,
    mime_type: asset.mimeType,
    byte_size: asset.byteSize,
    created_at: asset.createdAt
  });
}
function managementOperationView(operation2) {
  return BrowserWorkManagementOperationSchema.parse({
    opaque_id: operation2.id,
    operation_kind: operation2.kind,
    status: operation2.status,
    created_at: operation2.createdAt,
    updated_at: operation2.updatedAt
  });
}
function dispatchOperationView(operation2) {
  const parsed = BrowserWorkDispatchOperationSchema.safeParse({
    opaque_id: operation2.id,
    operation_kind: "dispatch",
    subject_opaque_id: operation2.ticketId,
    disposition: operation2.disposition,
    ...operation2.capability ? { capability: operation2.capability } : {},
    ...operation2.remediation ? { remediation: operation2.remediation } : {},
    ...operation2.settlement ? { settlement: operation2.settlement } : {},
    created_at: operation2.createdAt
  });
  return parsed.success ? parsed.data : void 0;
}
function descendingOperation(left, right) {
  return right.created_at.localeCompare(left.created_at) || right.opaque_id.localeCompare(left.opaque_id);
}
function pageOf(cursor) {
  if (!cursor) return 0;
  return Number(BrowserWorkProjectionCursorSchema.parse(cursor).slice(4));
}
function boundedPage(items, cursor) {
  const page3 = pageOf(cursor);
  const start = page3 * browserPageSize;
  const end = start + browserPageSize;
  return Object.freeze({
    items: items.slice(start, end),
    nextCursor: end < items.length ? BrowserWorkProjectionCursorSchema.parse(`bwp_${page3 + 1}`) : null
  });
}
function createBrowserWorkServices(options) {
  function scopedTicket2(projectId2, ticketId) {
    const detail = options.core.tickets.get(ticketId);
    return detail?.ticket.projectId === projectId2 ? detail : void 0;
  }
  function visibleTickets(projectId2) {
    const tickets = options.core.tickets.list({ projectId: projectId2 });
    const streams = options.core.streams.list(projectId2);
    return {
      tickets,
      ids: new Set(tickets.map((ticket) => ticket.id)),
      streams,
      streamIds: new Set(streams.map((stream) => stream.id))
    };
  }
  function safeTicket(ticket, visibleIds, visibleStreamIds) {
    return ticketView(
      ticket,
      options.core.tickets.legalTransitions(ticket.id),
      visibleIds,
      visibleStreamIds
    );
  }
  const service = {
    projection(stream, projectId2, cursor) {
      const resourceRevision = options.projectRevision(projectId2);
      if (stream === "tracker.board") {
        const visible = visibleTickets(projectId2);
        const page4 = boundedPage(visible.tickets, cursor);
        return BrowserWorkProjectionResponseSchema.parse({
          schema_version: "golem.browser-work-projection/v1",
          stream,
          resource_revision: resourceRevision,
          next_cursor: page4.nextCursor,
          items: page4.items.map(
            (ticket) => safeTicket(ticket, visible.ids, visible.streamIds)
          )
        });
      }
      if (stream === "tracker.tree") {
        const visible = visibleTickets(projectId2);
        const page4 = boundedPage(visible.tickets, cursor);
        return BrowserWorkProjectionResponseSchema.parse({
          schema_version: "golem.browser-work-projection/v1",
          stream,
          resource_revision: resourceRevision,
          next_cursor: page4.nextCursor,
          items: page4.items.map(
            (ticket) => safeTicket(ticket, visible.ids, visible.streamIds)
          )
        });
      }
      const managementOperations = options.management.controls.list(projectId2);
      if (stream === "management.controls") {
        const page4 = boundedPage(
          managementOperations.filter((operation2) => operation2.kind === "control").map(managementOperationView),
          cursor
        );
        return BrowserWorkProjectionResponseSchema.parse({
          schema_version: "golem.browser-work-projection/v1",
          stream,
          resource_revision: resourceRevision,
          next_cursor: page4.nextCursor,
          items: page4.items,
          roles: options.management.roles.list(projectId2).slice(0, browserPageSize).map(
            (role) => BrowserWorkRoleSchema.parse({
              opaque_id: role.id,
              name: safeBrowserText(role.name, 128) || "Untitled role",
              scope: role.scope,
              revision: role.revision,
              updated_at: role.updatedAt
            })
          ),
          gates: options.management.gates.list(projectId2).slice(0, browserPageSize).map(
            (gate) => BrowserWorkGateSchema.parse({
              opaque_id: gate.id,
              gate_kind: gate.kind,
              status: gate.status,
              question: safeBrowserText(gate.question, 4096) || "[REDACTED]",
              assignee_kind: gate.assignee === "human" || gate.assignee.startsWith("human:") ? "human" : "operator",
              updated_at: gate.updatedAt
            })
          ),
          ideas: options.management.ideas.list(projectId2).slice(0, browserPageSize).map(browserWorkIdeaView)
        });
      }
      const items = [
        ...managementOperations.filter((operation2) => operation2.kind !== "control").map(managementOperationView),
        ...options.ticketDispatch.operations(projectId2).map(dispatchOperationView).filter((operation2) => operation2 !== void 0)
      ].sort(descendingOperation);
      const page3 = boundedPage(items, cursor);
      return BrowserWorkProjectionResponseSchema.parse({
        schema_version: "golem.browser-work-projection/v1",
        stream,
        resource_revision: resourceRevision,
        next_cursor: page3.nextCursor,
        items: page3.items
      });
    },
    detail(projectId2, ticketId) {
      const detail = scopedTicket2(projectId2, ticketId);
      if (!detail) return void 0;
      const visible = visibleTickets(projectId2);
      return BrowserWorkDetailResponseSchema.parse({
        schema_version: "golem.browser-work-detail/v1",
        item: safeTicket(detail.ticket, visible.ids, visible.streamIds),
        body: safeBrowserText(detail.ticket.body, 16384),
        comments: detail.comments.slice(0, 500).map(browserWorkCommentView),
        links: detail.links.filter(
          (link) => visible.ids.has(link.ticketId) && visible.ids.has(link.targetTicketId)
        ).slice(0, 200).map((link) => browserWorkLinkView(link, ticketId)),
        children: visible.tickets.filter((ticket) => ticket.parentId === ticketId).slice(0, 200).map((ticket) => safeTicket(ticket, visible.ids, visible.streamIds)),
        streams: visible.streams.slice(0, browserPageSize).map(browserWorkStreamView),
        assets: options.management.assets.list({ projectId: projectId2, ticketId }).slice(0, browserPageSize).map(assetMetadataView)
      });
    },
    asset(projectId2, ticketId, assetId) {
      if (!scopedTicket2(projectId2, ticketId)) return void 0;
      const value2 = options.management.assets.read({
        projectId: projectId2,
        ticketId,
        assetId
      });
      return BrowserWorkAssetResponseSchema.parse({
        schema_version: "golem.browser-work-asset/v1",
        asset: assetMetadataView(value2.asset),
        content_base64: Buffer.from(value2.bytes).toString("base64")
      });
    },
    ticket(projectId2, ticketId) {
      const detail = scopedTicket2(projectId2, ticketId);
      if (!detail) return void 0;
      const visible = visibleTickets(projectId2);
      return safeTicket(detail.ticket, visible.ids, visible.streamIds);
    },
    idea(projectId2, ideaId) {
      const idea = options.management.ideas.list(projectId2).find((candidate) => candidate.id === ideaId);
      return idea ? browserWorkIdeaView(idea) : void 0;
    }
  };
  return Object.freeze(service);
}

// packages/persistence/dist/owner.js
import fs12 from "node:fs";
import path13 from "node:path";
import Database4 from "better-sqlite3";
import { Kysely as Kysely2, SqliteDialect as SqliteDialect2 } from "kysely";

// packages/persistence/dist/backup-health.js
import fs9 from "node:fs";
import Database2 from "better-sqlite3";
function sqlString(value2) {
  return `'${value2.replace(/'/gu, "''")}'`;
}
function health(database) {
  return Object.freeze({
    foreignKeys: numericPragma(database, "foreign_keys") === 1,
    journalMode: textPragma(database, "journal_mode"),
    busyTimeoutMs: numericPragma(database, "busy_timeout"),
    synchronous: textPragma(database, "synchronous"),
    integrity: textPragma(database, "integrity_check"),
    foreignKeyViolations: database.prepare("PRAGMA foreign_key_check").all().length,
    userVersion: currentVersion(database)
  });
}
function verifyDatabase(target) {
  const verified = new Database2(target, {
    readonly: true,
    fileMustExist: true
  });
  try {
    const result2 = health(verified);
    if (result2.integrity !== "ok" || result2.foreignKeyViolations > 0) {
      throw new PersistenceMigrationError("backup_failed", `database verification failed: integrity=${result2.integrity} foreign_keys=${result2.foreignKeyViolations}`);
    }
    return result2;
  } finally {
    verified.close();
  }
}
function backupDatabase(database, databasePath, clock) {
  const backupPath = `${databasePath}.golem-backup-${clock.now().replaceAll(/[:.]/gu, "-")}.db`;
  try {
    database.pragma("wal_checkpoint(PASSIVE)");
    database.exec(`VACUUM INTO ${sqlString(backupPath)}`);
    verifyDatabase(backupPath);
    return backupPath;
  } catch (error2) {
    if (error2 instanceof PersistenceMigrationError)
      throw error2;
    throw new PersistenceMigrationError("backup_failed", `backup failed before migration: ${error2 instanceof Error ? error2.message : String(error2)}`);
  }
}
function cloneDatabase(database, databasePath, clock) {
  const clonePath = `${databasePath}.golem-dry-run-${process.pid}-${clock.now().replaceAll(/[:.]/gu, "-")}.db`;
  database.exec(`VACUUM INTO ${sqlString(clonePath)}`);
  return clonePath;
}

// packages/persistence/dist/browser-principal-repository.js
import crypto10 from "node:crypto";
function digest2(value2) {
  return crypto10.createHash("sha256").update(value2).digest("hex");
}
function validText(value2) {
  return value2.trim().length > 0 && value2.length <= 512;
}
function validTimestamp2(value2) {
  return Number.isFinite(Date.parse(value2));
}
function active(row, now2) {
  return row.enabled === 1 && row.revoked_at === null && (row.expires_at === null || validTimestamp2(row.expires_at) && Date.parse(row.expires_at) > Date.parse(now2));
}
var BrowserPrincipalRepository = class {
  #database;
  #clock;
  constructor(database, clock) {
    this.#database = database;
    this.#clock = clock;
  }
  #binding(row, now2) {
    if (now2 !== void 0 && !active(row, now2))
      return void 0;
    const scopes = this.#database.prepare("SELECT project_id FROM browser_principal_scopes WHERE binding_id = ? ORDER BY project_id").all(row.id).map((scope) => scope.project_id);
    if (!scopes.includes(row.default_project_id))
      return void 0;
    return Object.freeze({
      id: row.id,
      actorId: row.actor_id,
      role: row.role,
      defaultProjectId: row.default_project_id,
      scopeProjectIds: Object.freeze(scopes),
      enabled: row.enabled === 1,
      version: Number(row.version),
      ...row.expires_at ? { expiresAt: row.expires_at } : {},
      ...row.revoked_at ? { revokedAt: row.revoked_at } : {}
    });
  }
  provision(input) {
    if (!validText(input.id) || !validText(input.actorId) || !validText(input.defaultProjectId) || input.scopeProjectIds.length === 0 || !input.scopeProjectIds.every(validText) || !input.scopeProjectIds.includes(input.defaultProjectId) || input.expiresAt !== void 0 && !validTimestamp2(input.expiresAt))
      throw new Error("principal binding provision is invalid");
    const scopes = [...new Set(input.scopeProjectIds)].sort();
    const now2 = this.#clock.now();
    const transaction = this.#database.transaction(() => {
      this.#database.prepare("INSERT INTO browser_principal_bindings (id, actor_id, role, default_project_id, enabled, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(input.id, input.actorId, input.role, input.defaultProjectId, input.enabled === false ? 0 : 1, input.expiresAt ?? null, now2, now2);
      const insertScope = this.#database.prepare("INSERT INTO browser_principal_scopes (binding_id, project_id) VALUES (?, ?)");
      for (const projectId2 of scopes)
        insertScope.run(input.id, projectId2);
    });
    transaction.immediate();
    const row = this.#database.prepare("SELECT id, actor_id, role, default_project_id, enabled, version, expires_at, revoked_at FROM browser_principal_bindings WHERE id = ?").get(input.id);
    if (!row)
      throw new Error("principal binding provision was not durable");
    const binding = this.#binding(row);
    if (!binding)
      throw new Error("principal binding scope is invalid");
    return binding;
  }
  bindCredential(input) {
    if (!validText(input.credential))
      throw new Error("principal credential is invalid");
    if (input.expiresAt !== void 0 && !validTimestamp2(input.expiresAt))
      throw new Error("principal credential expiry is invalid");
    const exists = this.#database.prepare("SELECT id FROM browser_principal_bindings WHERE id = ?").get(input.bindingId);
    if (!exists)
      throw new Error("principal binding is unknown");
    this.#database.prepare("INSERT INTO browser_principal_credentials (adapter, credential_digest, binding_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").run(input.adapter, digest2(input.credential), input.bindingId, input.expiresAt ?? null, this.#clock.now());
  }
  resolveCredential(input) {
    if (!validText(input.credential))
      return void 0;
    const row = this.#database.prepare(`SELECT binding.id, binding.actor_id, binding.role, binding.default_project_id, binding.enabled, binding.version, binding.expires_at, binding.revoked_at, credential.expires_at AS credential_expires_at FROM browser_principal_credentials AS credential JOIN browser_principal_bindings AS binding ON binding.id = credential.binding_id WHERE credential.adapter = ? AND credential.credential_digest = ? AND credential.revoked_at IS NULL AND (credential.expires_at IS NULL OR credential.expires_at > ?)`).get(input.adapter, digest2(input.credential), input.now);
    if (row && row.credential_expires_at !== null && (!validTimestamp2(row.credential_expires_at) || Date.parse(row.credential_expires_at) <= Date.parse(input.now)))
      return void 0;
    return row ? this.#binding(row, input.now) : void 0;
  }
  createBrowserSession(input) {
    if (!validText(input.session) || !validText(input.csrf) || !validTimestamp2(input.expiresAt) || Date.parse(input.expiresAt) <= Date.parse(input.now))
      return false;
    const binding = this.#database.prepare("SELECT id, actor_id, role, default_project_id, enabled, version, expires_at, revoked_at FROM browser_principal_bindings WHERE id = ?").get(input.bindingId);
    const resolved = binding ? this.#binding(binding, input.now) : void 0;
    if (!resolved || input.requireOperator && resolved.role !== "operator")
      return false;
    this.#database.prepare("INSERT INTO browser_principal_sessions (session_digest, csrf_digest, binding_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").run(digest2(input.session), digest2(input.csrf), input.bindingId, input.expiresAt, input.now);
    return true;
  }
  resolveBrowserSession(input) {
    if (!validText(input.session))
      return void 0;
    const row = this.#database.prepare(`SELECT binding.id, binding.actor_id, binding.role, binding.default_project_id, binding.enabled, binding.version, binding.expires_at, binding.revoked_at, session.csrf_digest, session.expires_at AS session_expires_at FROM browser_principal_sessions AS session JOIN browser_principal_bindings AS binding ON binding.id = session.binding_id WHERE session.session_digest = ? AND session.revoked_at IS NULL AND session.expires_at > ?`).get(digest2(input.session), input.now);
    if (!row || !validTimestamp2(row.session_expires_at) || Date.parse(row.session_expires_at) <= Date.parse(input.now) || input.csrf !== void 0 && digest2(input.csrf) !== row.csrf_digest)
      return void 0;
    return this.#binding(row, input.now);
  }
  revokeBinding(id2, now2) {
    const transaction = this.#database.transaction(() => {
      const result2 = this.#database.prepare("UPDATE browser_principal_bindings SET revoked_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND revoked_at IS NULL").run(now2, now2, id2);
      if (result2.changes > 0)
        this.#database.prepare("UPDATE browser_principal_sessions SET revoked_at = ? WHERE binding_id = ? AND revoked_at IS NULL").run(now2, id2);
      return result2.changes > 0;
    });
    return transaction.immediate();
  }
};

// packages/persistence/dist/clock.js
import crypto11 from "node:crypto";
var systemPersistenceClock = Object.freeze({
  now: () => (/* @__PURE__ */ new Date()).toISOString(),
  after: (milliseconds) => new Date(Date.now() + milliseconds).toISOString()
});
function createOwnerNonce() {
  return `owner_${crypto11.randomUUID()}`;
}

// packages/persistence/dist/command-receipt-repository.js
function json2(value2) {
  return JSON.stringify(value2);
}
function rowReceipt(row) {
  const parsed = (() => {
    try {
      const value2 = JSON.parse(row.result_json ?? "{}");
      return value2 && typeof value2 === "object" && !Array.isArray(value2) ? value2 : {};
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
    outcome_status: row.outcome_status,
    ...row.reason_code ? { reason_code: row.reason_code } : {},
    ...row.operation_id ? { operation_id: row.operation_id } : {},
    result: parsed,
    committed_at: row.committed_at
  });
}
var CommandReceiptRepository = class {
  #store;
  constructor(queries, database) {
    this.#store = new SyncKyselyTrackerStore(queries, database);
  }
  find(projectId2, idempotencyKey) {
    const row = this.#store.get(this.#store.queries.selectFrom("command_receipts").selectAll().where("project_id", "=", projectId2).where("idempotency_key", "=", idempotencyKey).limit(1));
    return row ? rowReceipt(row) : void 0;
  }
  record(input) {
    this.#store.run(this.#store.queries.insertInto("command_receipts").values({
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
      result_json: json2(input.result),
      committed_at: input.committed_at
    }));
  }
  transaction(fn) {
    return this.#store.transaction(() => fn());
  }
  gateway() {
    const receipts = this;
    return Object.freeze({
      receipts,
      transaction: (fn) => this.transaction(fn)
    });
  }
};

// packages/persistence/dist/committed-publication-repository.js
import crypto12 from "node:crypto";
function rowPublication(row) {
  const base = Object.freeze({
    id: row.id,
    projectId: row.project_id,
    category: row.category,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    resourceRevision: row.resource_revision,
    projectRevision: row.project_revision,
    schemaVersion: row.schema_version,
    policyVersion: row.policy_version,
    createdAt: row.created_at
  });
  return row.claim_token ? Object.freeze({ ...base, claimToken: row.claim_token }) : base;
}
var CommittedPublicationRepository = class {
  #database;
  constructor(database) {
    this.#database = database;
  }
  claim(input) {
    if (!input.workerId || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 128)
      throw new Error("committed publication claim input is invalid");
    return this.#database.transaction(() => {
      this.recover(input.now);
      const rows = this.#database.prepare(`SELECT id, project_id, category, resource_type, resource_id,
              resource_revision, project_revision, schema_version,
              policy_version, created_at, claim_token
             FROM committed_publication_outbox
             WHERE status = 'pending'
             -- A project revision is the canonical cursor exposed by HTTP and
             -- WS. Timestamps may be equal (or supplied by a deterministic
             -- clock), so id ordering could publish revision N+1 before N.
             -- Scope first, then the committed revision, preserves the
             -- monotonic per-project replay contract without imposing a
             -- global cross-project sequence.
             ORDER BY project_id ASC, project_revision ASC, id ASC
             LIMIT ?`).all(input.limit);
      const claimed = [];
      for (const row of rows) {
        const claimToken = `cpub_${crypto12.randomUUID()}`;
        const changed = this.#database.prepare(`UPDATE committed_publication_outbox
               SET status = 'claimed', claim_owner = ?, claim_token = ?, claim_until = ?
               WHERE id = ? AND status = 'pending'`).run(input.workerId, claimToken, input.claimUntil, row.id);
        if (changed.changes !== 1)
          continue;
        claimed.push(rowPublication({
          ...row,
          claim_token: claimToken
        }));
      }
      return Object.freeze(claimed);
    }).immediate();
  }
  recover(now2) {
    const result2 = this.#database.prepare(`UPDATE committed_publication_outbox
         SET status = 'pending', claim_owner = NULL, claim_token = NULL, claim_until = NULL
         WHERE status = 'claimed' AND claim_until <= ?`).run(now2);
    return result2.changes;
  }
  ack(input) {
    return this.#database.prepare(`UPDATE committed_publication_outbox
           SET status = 'published', published_at = ?, claim_owner = NULL,
               claim_token = NULL, claim_until = NULL
           WHERE id = ? AND status = 'claimed' AND claim_token = ?`).run(input.publishedAt, input.id, input.claimToken).changes === 1;
  }
  projectRevision(projectId2) {
    const row = this.#database.prepare("SELECT revision FROM committed_project_revisions WHERE project_id = ?").get(projectId2);
    return row?.revision ?? 0;
  }
  outboxCount(projectId2) {
    const row = this.#database.prepare("SELECT count(*) AS count FROM committed_publication_outbox WHERE project_id = ?").get(projectId2);
    return Number(row?.count ?? 0);
  }
};

// packages/persistence/dist/lock.js
import fs10 from "node:fs";
import path11 from "node:path";
var fileSystem2 = fs10;
function guardPath(lockPath2) {
  return `${lockPath2}.guard`;
}
function metadataPath(ownerGuardPath) {
  return path11.join(ownerGuardPath, "owner.json");
}
function processIsGone(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error2) {
    return typeof error2 === "object" && error2 !== null && "code" in error2 && error2.code === "ESRCH";
  }
}
function readOwnerMetadata(target) {
  try {
    const parsed = JSON.parse(fileSystem2.readFileSync(metadataPath(target), "utf8"));
    if (typeof parsed.owner_id !== "string" || !parsed.owner_id || typeof parsed.pid !== "number" || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0 || typeof parsed.nonce !== "string" || !/^owner_[0-9a-f-]{36}$/iu.test(parsed.nonce) || typeof parsed.acquired_at !== "string")
      return void 0;
    return Object.freeze({
      owner_id: parsed.owner_id,
      pid: parsed.pid,
      nonce: parsed.nonce,
      acquired_at: parsed.acquired_at
    });
  } catch {
    return void 0;
  }
}
function isCode3(error2, code) {
  return typeof error2 === "object" && error2 !== null && "code" in error2 && error2.code === code;
}
function isSameOwner(lock, current) {
  return Boolean(current && current.owner_id === lock.ownerId && current.pid === lock.pid && current.nonce === lock.nonce);
}
function writeDiagnosticPointer(lockPath2, metadata) {
  const temporary = `${lockPath2}.${metadata.nonce}.tmp`;
  fileSystem2.writeFileSync(temporary, `${JSON.stringify(metadata)}
`, {
    encoding: "utf8",
    mode: 384
  });
  fileSystem2.renameSync(temporary, lockPath2);
}
function recoverStaleGuard(ownerGuardPath, expected) {
  const current = readOwnerMetadata(ownerGuardPath);
  if (!current || current.nonce !== expected.nonce || current.owner_id !== expected.owner_id || !processIsGone(current.pid))
    return false;
  try {
    fileSystem2.renameSync(ownerGuardPath, `${ownerGuardPath}.stale-${current.nonce}`);
    return true;
  } catch {
    return false;
  }
}
function acquireOwnerLock(lockPath2, ownerId, clock) {
  fileSystem2.mkdirSync(path11.dirname(lockPath2), {
    recursive: true,
    mode: 448
  });
  const ownerGuardPath = guardPath(lockPath2);
  const metadata = Object.freeze({
    owner_id: ownerId,
    pid: process.pid,
    nonce: createOwnerNonce(),
    acquired_at: clock.now()
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fileSystem2.mkdirSync(ownerGuardPath, { mode: 448 });
      fileSystem2.writeFileSync(metadataPath(ownerGuardPath), `${JSON.stringify(metadata)}
`, { encoding: "utf8", mode: 384 });
      writeDiagnosticPointer(lockPath2, metadata);
      return Object.freeze({
        lockPath: lockPath2,
        guardPath: ownerGuardPath,
        ownerId,
        nonce: metadata.nonce,
        pid: process.pid
      });
    } catch (error2) {
      if (!isCode3(error2, "EEXIST"))
        throw error2;
      const existing = readOwnerMetadata(ownerGuardPath);
      if (attempt === 0 && existing && processIsGone(existing.pid)) {
        if (recoverStaleGuard(ownerGuardPath, existing))
          continue;
      }
      throw new PersistenceOwnerConflictError(existing ? {
        owner_id: existing.owner_id,
        owner_nonce: existing.nonce,
        pid: existing.pid,
        state: processIsGone(existing.pid) ? "stale_recovery_raced" : "active"
      } : { state: "invalid", lock_path: lockPath2 });
    }
  }
  throw new PersistenceOwnerConflictError({
    state: "recovery_exhausted",
    lock_path: lockPath2
  });
}
function releaseOwnerLock(lock) {
  if (!isSameOwner(lock, readOwnerMetadata(lock.guardPath)))
    return;
  try {
    fileSystem2.rmSync(lock.guardPath, { recursive: true, force: true });
  } catch (error2) {
    if (!isCode3(error2, "ENOENT"))
      throw error2;
  }
}

// packages/persistence/dist/management-repository.js
function parseJson(value2) {
  if (!value2)
    return {};
  try {
    const parsed = JSON.parse(value2);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function json3(value2) {
  return JSON.stringify(value2);
}
function rowRole(row) {
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    scope: row.scope,
    definition: parseJson(row.definition_json),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}
function rowAssignment(row) {
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    ...row.session_id ? { sessionId: row.session_id } : {},
    ...row.generation_id ? { generationId: row.generation_id } : {},
    roleId: row.role_id,
    actor: row.actor,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at
  });
}
function rowGate(row) {
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    status: row.status,
    question: row.question,
    assignee: row.assignee,
    ...row.verdict_json ? { verdict: parseJson(row.verdict_json) } : {},
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}
function rowIdea(row) {
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    body: row.body,
    status: row.status,
    ...row.promoted_ticket_id ? { promotedTicketId: row.promoted_ticket_id } : {},
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}
function rowAsset(row) {
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    ticketId: row.ticket_id,
    relativePath: row.relative_path,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
    storagePath: row.storage_path,
    createdAt: row.created_at
  });
}
function rowOperation(row) {
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    ...row.session_id ? { sessionId: row.session_id } : {},
    ...row.generation_id ? { generationId: row.generation_id } : {},
    kind: row.kind,
    command: row.command,
    payload: parseJson(row.payload_json),
    status: row.status,
    actor: row.actor,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}
function rowAudit(row) {
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    subjectId: row.subject_id,
    actor: row.actor,
    details: parseJson(row.details_json),
    createdAt: row.created_at
  });
}
var TrackerManagementRepository = class {
  #store;
  constructor(queries, database) {
    this.#store = new SyncKyselyTrackerStore(queries, database);
  }
  #record(projectId2, kind, subjectId, idempotencyKey, actor3, details, now2) {
    this.#store.run(this.#store.queries.insertInto("management_audit").values({
      id: `maud_${globalThis.crypto.randomUUID()}`,
      project_id: projectId2,
      kind,
      subject_id: subjectId,
      actor: actor3,
      details_json: json3(details),
      created_at: now2
    }));
    this.#store.run(this.#store.queries.insertInto("management_outbox").values({
      id: `mout_${globalThis.crypto.randomUUID()}`,
      project_id: projectId2,
      kind,
      payload_json: json3({
        kind,
        subject_id: subjectId,
        ...details
      }),
      idempotency_key: idempotencyKey,
      status: "pending",
      created_at: now2
    }).onConflict((oc) => oc.columns(["project_id", "idempotency_key"]).doNothing()));
  }
  createRole(input) {
    return this.#store.transaction(() => {
      const existing = this.#store.get(this.#store.queries.selectFrom("management_roles").selectAll().where("id", "=", input.id));
      if (existing) {
        if (existing.scope === input.scope && existing.definition_json === json3(input.definition))
          return rowRole(existing);
        this.#store.run(this.#store.queries.updateTable("management_roles").set({
          definition_json: json3(input.definition),
          scope: input.scope,
          revision: existing.revision + 1,
          updated_at: input.now
        }).where("id", "=", input.id));
        this.#record(input.projectId, "role.updated", input.id, `role:${input.id}:${existing.revision + 1}`, input.actor, { name: input.name }, input.now);
        return rowRole(this.#store.get(this.#store.queries.selectFrom("management_roles").selectAll().where("id", "=", input.id)));
      }
      this.#store.run(this.#store.queries.insertInto("management_roles").values({
        id: input.id,
        project_id: input.projectId,
        name: input.name,
        scope: input.scope,
        definition_json: json3(input.definition),
        revision: 1,
        created_at: input.now,
        updated_at: input.now
      }));
      this.#record(input.projectId, "role.created", input.id, `role:${input.id}:1`, input.actor, { name: input.name }, input.now);
      return rowRole(this.#store.get(this.#store.queries.selectFrom("management_roles").selectAll().where("id", "=", input.id)));
    });
  }
  listRoles(projectId2) {
    return Object.freeze(this.#store.all(this.#store.queries.selectFrom("management_roles").selectAll().where("project_id", "=", projectId2).orderBy("name", "asc")).map(rowRole));
  }
  assignRole(input) {
    return this.#store.transaction(() => {
      const existing = this.#store.get(this.#store.queries.selectFrom("management_role_assignments").selectAll().where("project_id", "=", input.projectId).where("idempotency_key", "=", input.idempotencyKey));
      if (existing)
        return rowAssignment(existing);
      this.#store.run(this.#store.queries.insertInto("management_role_assignments").values({
        id: input.id,
        project_id: input.projectId,
        session_id: input.sessionId ?? null,
        generation_id: input.generationId ?? null,
        role_id: input.roleId,
        actor: input.actor,
        idempotency_key: input.idempotencyKey,
        created_at: input.now
      }));
      this.#record(input.projectId, "role.assigned", input.id, `assignment:${input.idempotencyKey}`, input.actor, {
        role_id: input.roleId,
        session_id: input.sessionId ?? null,
        generation_id: input.generationId ?? null
      }, input.now);
      return rowAssignment(this.#store.get(this.#store.queries.selectFrom("management_role_assignments").selectAll().where("id", "=", input.id)));
    });
  }
  createGate(input) {
    return this.#store.transaction(() => {
      const existing = this.#store.get(this.#store.queries.selectFrom("management_gates").selectAll().where("project_id", "=", input.projectId).where("idempotency_key", "=", input.idempotencyKey));
      if (existing)
        return rowGate(existing);
      this.#store.run(this.#store.queries.insertInto("management_gates").values({
        id: input.id,
        project_id: input.projectId,
        kind: input.kind,
        status: "awaiting",
        question: input.question,
        assignee: input.assignee,
        verdict_json: null,
        idempotency_key: input.idempotencyKey,
        created_at: input.now,
        updated_at: input.now
      }));
      this.#record(input.projectId, "gate.created", input.id, `gate:${input.idempotencyKey}`, input.actor, { kind: input.kind, assignee: input.assignee }, input.now);
      return rowGate(this.#store.get(this.#store.queries.selectFrom("management_gates").selectAll().where("id", "=", input.id)));
    });
  }
  answerGate(input) {
    return this.#store.transaction(() => {
      const existing = this.#store.get(this.#store.queries.selectFrom("management_gates").selectAll().where("id", "=", input.id).where("project_id", "=", input.projectId));
      if (!existing)
        return void 0;
      if (existing.status !== "awaiting")
        return rowGate(existing);
      this.#store.run(this.#store.queries.updateTable("management_gates").set({
        status: input.status,
        verdict_json: json3(input.verdict),
        updated_at: input.now
      }).where("id", "=", input.id).where("status", "=", "awaiting"));
      this.#record(input.projectId, `gate.${input.status}`, input.id, `gate:${input.id}:${input.status}`, input.actor, { verdict: input.verdict }, input.now);
      return rowGate(this.#store.get(this.#store.queries.selectFrom("management_gates").selectAll().where("id", "=", input.id)));
    });
  }
  listGates(projectId2) {
    return Object.freeze(this.#store.all(this.#store.queries.selectFrom("management_gates").selectAll().where("project_id", "=", projectId2).orderBy("created_at", "desc")).map(rowGate));
  }
  createIdea(input) {
    return this.#store.transaction(() => {
      const existing = this.#store.get(this.#store.queries.selectFrom("management_ideas").selectAll().where("project_id", "=", input.projectId).where("idempotency_key", "=", input.idempotencyKey));
      if (existing)
        return rowIdea(existing);
      this.#store.run(this.#store.queries.insertInto("management_ideas").values({
        id: input.id,
        project_id: input.projectId,
        body: input.body,
        status: "pending",
        promoted_ticket_id: null,
        idempotency_key: input.idempotencyKey,
        created_at: input.now,
        updated_at: input.now
      }));
      this.#record(input.projectId, "idea.created", input.id, `idea:${input.idempotencyKey}`, input.actor, {}, input.now);
      return rowIdea(this.#store.get(this.#store.queries.selectFrom("management_ideas").selectAll().where("id", "=", input.id)));
    });
  }
  popIdea(input) {
    return this.#store.transaction(() => {
      const existing = this.#store.get(this.#store.queries.selectFrom("management_ideas").selectAll().where("id", "=", input.id).where("project_id", "=", input.projectId));
      if (!existing)
        return void 0;
      if (existing.status !== "pending")
        return rowIdea(existing);
      this.#store.run(this.#store.queries.updateTable("management_ideas").set({ status: "popped", updated_at: input.now }).where("id", "=", input.id).where("status", "=", "pending"));
      this.#record(input.projectId, "idea.popped", input.id, `idea:${input.id}:popped`, input.actor, {}, input.now);
      return rowIdea(this.#store.get(this.#store.queries.selectFrom("management_ideas").selectAll().where("id", "=", input.id)));
    });
  }
  promoteIdea(input) {
    return this.#store.transaction(() => {
      const existing = this.#store.get(this.#store.queries.selectFrom("management_ideas").selectAll().where("id", "=", input.id).where("project_id", "=", input.projectId));
      if (!existing)
        return void 0;
      if (existing.status === "promoted")
        return rowIdea(existing);
      this.#store.run(this.#store.queries.updateTable("management_ideas").set({
        status: "promoted",
        promoted_ticket_id: input.ticketId,
        updated_at: input.now
      }).where("id", "=", input.id).where("status", "in", ["pending", "popped"]));
      this.#record(input.projectId, "idea.promoted", input.id, `idea:${input.id}:promoted`, input.actor, { ticket_id: input.ticketId }, input.now);
      return rowIdea(this.#store.get(this.#store.queries.selectFrom("management_ideas").selectAll().where("id", "=", input.id)));
    });
  }
  listIdeas(projectId2) {
    return Object.freeze(this.#store.all(this.#store.queries.selectFrom("management_ideas").selectAll().where("project_id", "=", projectId2).orderBy("created_at", "asc")).map(rowIdea));
  }
  putAsset(input) {
    return this.#store.transaction(() => {
      const existing = this.#store.get(this.#store.queries.selectFrom("management_assets").selectAll().where("project_id", "=", input.projectId).where("ticket_id", "=", input.ticketId).where("relative_path", "=", input.relativePath));
      if (existing)
        return rowAsset(existing);
      this.#store.run(this.#store.queries.insertInto("management_assets").values({
        id: input.id,
        project_id: input.projectId,
        ticket_id: input.ticketId,
        relative_path: input.relativePath,
        mime_type: input.mimeType,
        byte_size: input.byteSize,
        sha256: input.sha256,
        storage_path: input.storagePath,
        created_at: input.now
      }));
      this.#record(input.projectId, "asset.stored", input.id, `asset:${input.projectId}:${input.ticketId}:${input.relativePath}`, input.actor, {
        ticket_id: input.ticketId,
        mime_type: input.mimeType,
        byte_size: input.byteSize
      }, input.now);
      return rowAsset(this.#store.get(this.#store.queries.selectFrom("management_assets").selectAll().where("id", "=", input.id)));
    });
  }
  getAsset(input) {
    const row = this.#store.get(this.#store.queries.selectFrom("management_assets").selectAll().where("id", "=", input.id).where("project_id", "=", input.projectId).where("ticket_id", "=", input.ticketId));
    return row ? rowAsset(row) : void 0;
  }
  listAssets(input) {
    return Object.freeze(this.#store.all(this.#store.queries.selectFrom("management_assets").selectAll().where("project_id", "=", input.projectId).where("ticket_id", "=", input.ticketId).orderBy("created_at", "asc")).map(rowAsset));
  }
  createOperation(input) {
    return this.#store.transaction(() => {
      const existing = this.#store.get(this.#store.queries.selectFrom("management_operations").selectAll().where("project_id", "=", input.projectId).where("idempotency_key", "=", input.idempotencyKey));
      if (existing)
        return rowOperation(existing);
      this.#store.run(this.#store.queries.insertInto("management_operations").values({
        id: input.id,
        project_id: input.projectId,
        session_id: input.sessionId ?? null,
        generation_id: input.generationId ?? null,
        kind: input.kind,
        command: input.command,
        payload_json: json3(input.payload),
        status: "queued",
        actor: input.actor,
        idempotency_key: input.idempotencyKey,
        created_at: input.now,
        updated_at: input.now
      }));
      this.#record(input.projectId, `control.${input.command}`, input.id, `operation:${input.idempotencyKey}`, input.actor, {
        command: input.command,
        kind: input.kind,
        session_id: input.sessionId ?? null,
        generation_id: input.generationId ?? null
      }, input.now);
      return rowOperation(this.#store.get(this.#store.queries.selectFrom("management_operations").selectAll().where("id", "=", input.id)));
    });
  }
  getOperation(id2, projectId2) {
    const row = this.#store.get(this.#store.queries.selectFrom("management_operations").selectAll().where("id", "=", id2).where("project_id", "=", projectId2));
    return row ? rowOperation(row) : void 0;
  }
  listOperations(projectId2) {
    return Object.freeze(this.#store.all(this.#store.queries.selectFrom("management_operations").selectAll().where("project_id", "=", projectId2).orderBy("created_at", "desc")).map(rowOperation));
  }
  auditManagement(projectId2) {
    return Object.freeze(this.#store.all(this.#store.queries.selectFrom("management_audit").selectAll().where("project_id", "=", projectId2).orderBy("created_at", "desc")).map(rowAudit));
  }
};

// packages/persistence/dist/migrations.js
import fs11 from "node:fs";
import path12 from "node:path";
import Database3 from "better-sqlite3";
var fileSystem3 = fs11;
var pathBoundary = path12;
function ensureMigrationLedger(database) {
  database.exec(`
CREATE TABLE IF NOT EXISTS golem_migrations (
  id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`);
}
function appliedMigrations(database) {
  if (!tableExists(database, "golem_migrations"))
    return Object.freeze({ exists: false, rows: /* @__PURE__ */ new Map() });
  const rows = /* @__PURE__ */ new Map();
  try {
    for (const row of database.prepare("SELECT id, checksum FROM golem_migrations ORDER BY id").all()) {
      if (typeof row.id !== "string" || !row.id || typeof row.checksum !== "string" || !row.checksum || rows.has(row.id)) {
        throw new PersistenceMigrationError("migration_ledger_invalid", "migration ledger contains a malformed row");
      }
      rows.set(row.id, row.checksum);
    }
  } catch (error2) {
    if (error2 instanceof PersistenceMigrationError)
      throw error2;
    throw new PersistenceMigrationError("migration_ledger_invalid", `migration ledger is unreadable: ${error2 instanceof Error ? error2.message : String(error2)}`);
  }
  return Object.freeze({ exists: true, rows });
}
function assertMigrationState(database, scope) {
  const expected = migrationSet(scope);
  const ledger = appliedMigrations(database);
  const version2 = currentVersion(database);
  if (version2 > latestVersion(scope)) {
    throw new PersistenceMigrationError("schema_too_new", `${scope} schema version ${version2} is newer than supported version ${latestVersion(scope)}`);
  }
  const known = new Set(expected.map((entry2) => entry2.id));
  for (const id2 of ledger.rows.keys()) {
    if (!known.has(id2)) {
      throw new PersistenceMigrationError("schema_too_new", `${scope} migration ledger contains an unknown migration: ${id2}`);
    }
  }
  for (const entry2 of expected) {
    const stored = ledger.rows.get(entry2.id);
    if (stored && stored !== entry2.checksum) {
      throw new PersistenceMigrationError("checksum_drift", `${scope} migration checksum drift: ${entry2.id}`);
    }
  }
  return ledger.rows;
}
function planFor(database, scope, mode) {
  const migrations = migrationSet(scope);
  const applied = assertMigrationState(database, scope);
  const pending = migrations.filter((entry2) => !applied.has(entry2.id));
  const plan = {
    scope,
    mode,
    currentVersion: currentVersion(database),
    targetVersion: latestVersion(scope),
    migrations: migrations.map(({ id: id2, checksum }) => ({ id: id2, checksum })),
    pending: pending.map(({ id: id2, checksum }) => ({ id: id2, checksum })),
    requiresBackup: pending.length > 0,
    estimatedBackupBytes: numericPragma(database, "page_count") * numericPragma(database, "page_size")
  };
  const stablePlan = {
    scope: plan.scope,
    currentVersion: plan.currentVersion,
    targetVersion: plan.targetVersion,
    migrations: plan.migrations,
    pending: plan.pending,
    requiresBackup: plan.requiresBackup,
    estimatedBackupBytes: plan.estimatedBackupBytes
  };
  return Object.freeze({
    ...plan,
    planHash: sha256(JSON.stringify(stablePlan))
  });
}
function migrationAlreadyProvidesBaseline(database, scope, id2) {
  return scope === "tracker" && id2 === "tracker/001-baseline" && tableExists(database, "migration_audit");
}
function applyPlan(database, databasePath, plan, clock) {
  if (plan.pending.length === 0)
    return Object.freeze({ ...plan, applied: [] });
  const backupPath = backupDatabase(database, databasePath, clock);
  const definitions = migrationSet(plan.scope).filter((entry2) => plan.pending.some((pending) => pending.id === entry2.id));
  try {
    database.transaction(() => {
      ensureMigrationLedger(database);
      for (const definition of definitions) {
        if (!migrationAlreadyProvidesBaseline(database, plan.scope, definition.id))
          database.exec(definition.sql);
        database.prepare("INSERT INTO golem_migrations(id, checksum, applied_at) VALUES (?, ?, ?)").run(definition.id, definition.checksum, clock.now());
      }
      database.pragma(`user_version = ${plan.targetVersion}`);
      const appliedAt = clock.now();
      const auditId = sha256(`${plan.scope}:${plan.planHash}:${appliedAt}`).slice(0, 32);
      if (tableExists(database, "migration_audit"))
        database.prepare("INSERT INTO migration_audit(id, scope, plan_hash, backup_path, applied_at) VALUES (?, ?, ?, ?, ?)").run(auditId, plan.scope, plan.planHash, backupPath, appliedAt);
    })();
  } catch (error2) {
    throw new PersistenceMigrationError("migration_failed", `${plan.scope} migration failed; source rolled back: ${error2 instanceof Error ? error2.message : String(error2)}`);
  }
  verifyDatabase(databasePath);
  return Object.freeze({
    ...plan,
    backupPath,
    applied: definitions.map((definition) => definition.id)
  });
}
function dryRunPlan(database, databasePath, scope, clock) {
  const plan = planFor(database, scope, "dry-run");
  const clonePath = cloneDatabase(database, databasePath, clock);
  let clone;
  try {
    clone = new Database3(clonePath);
    configure(clone);
    const clonedPlan = planFor(clone, scope, "apply");
    const result2 = applyPlan(clone, clonePath, clonedPlan, clock);
    const checked = health(clone);
    if (checked.integrity !== "ok" || checked.foreignKeyViolations !== 0)
      throw new PersistenceMigrationError("migration_failed", `dry-run clone failed integrity=${checked.integrity} foreign_keys=${checked.foreignKeyViolations}`);
    return Object.freeze({
      ...plan,
      dryRun: {
        integrity: checked.integrity,
        foreignKeyViolations: checked.foreignKeyViolations,
        applied: result2.applied
      }
    });
  } finally {
    try {
      clone?.close();
    } catch {
    }
    try {
      fileSystem3.rmSync(clonePath, { force: true });
      const cloneName = pathBoundary.basename(clonePath);
      for (const entry2 of fileSystem3.readdirSync(pathBoundary.dirname(clonePath))) {
        if (entry2.startsWith(`${cloneName}.golem-backup-`))
          fileSystem3.rmSync(pathBoundary.join(pathBoundary.dirname(clonePath), entry2), { force: true });
      }
    } catch {
    }
  }
}

// packages/persistence/dist/repositories.js
import crypto13 from "node:crypto";

// packages/persistence/dist/endpoint-repository.js
function json4(value2) {
  return JSON.stringify(value2);
}
function accepted(endpointId, revision, fence) {
  return Object.freeze({
    disposition: "accepted",
    code: "runtime.endpoint.accepted",
    endpointId,
    revision,
    ...fence === void 0 ? {} : { ownerFence: fence }
  });
}
function rejected(code, details) {
  return Object.freeze({
    disposition: "rejected",
    code,
    ...details ? { details } : {}
  });
}
function live(state) {
  return state === "claiming" || state === "healthy" || state === "degraded";
}
function terminal(state) {
  return state === "ended" || state === "errored" || state === "superseded";
}
function compareTime(left, right) {
  return Date.parse(left) - Date.parse(right);
}
function redactIdentifier(value2) {
  return value2.replace(/((?:owner[_-]?token|access[_-]?token|api[_-]?key|openai[_-]?api[_-]?key|token|credential|password|secret|bearer)\s*[=:]\s*)([^\s,;|]+)/giu, "$1[REDACTED]");
}
function consumedEvidence(evidence) {
  return evidence.consumed === true || evidence.consumptionObserved === true || evidence.consumption === "observed";
}
var RuntimeEndpointRepository = class {
  #database;
  #clock;
  constructor(database, clock) {
    this.#database = database;
    this.#clock = clock;
  }
  #emit(row, kind, now2) {
    const id2 = sha256(`endpoint:${row.endpoint_id}:${row.revision}:${kind}`).slice(0, 32);
    this.#database.prepare("INSERT OR IGNORE INTO runtime_outbox(id, destination, payload_json, status, created_at, attempts) VALUES (?, 'tracker', ?, 'pending', ?, 0)").run(id2, json4({
      kind,
      endpointId: row.endpoint_id,
      generationId: row.generation_id,
      routeKind: row.route_kind,
      revision: row.revision,
      ownerFence: row.owner_fence
    }), new Date(Date.parse(now2) + row.revision).toISOString());
  }
  #row(endpointId) {
    return this.#database.prepare("SELECT endpoint_id, generation_id, route_kind, revision, state, owner_fence, owner_instance_id, delivery_mode, readiness_state, control_state, consumer_ready, consumption_observed, delivery_observed, delivery_failed, claimed_at, heartbeat_at, expires_at, superseded_at FROM endpoint_claims WHERE endpoint_id = ?").get(endpointId);
  }
  #nextRevision(generationId) {
    const row = this.#database.prepare("SELECT MAX(revision) AS revision FROM endpoint_claims WHERE generation_id = ?").get(generationId);
    return (row?.revision ?? 0) + 1;
  }
  #validateGeneration(generationId) {
    const row = this.#database.prepare("SELECT lifecycle_state FROM session_generations WHERE generation_id = ?").get(generationId);
    if (!row)
      return rejected("runtime.endpoint.generation_unresolved");
    if (terminal(row.lifecycle_state))
      return rejected("runtime.endpoint.generation_terminal", {
        remedy: "select a non-terminal generation"
      });
    return void 0;
  }
  #validateOwner(input) {
    const row = this.#row(input.endpointId);
    if (!row)
      return { error: rejected("runtime.endpoint.unresolved") };
    if (row.generation_id !== input.generationId || row.owner_instance_id !== input.ownerInstanceId || row.owner_fence !== input.ownerFence)
      return {
        error: rejected("runtime.endpoint.fence_stale", {
          generationId: row.generation_id,
          expectedFence: row.owner_fence,
          receivedFence: input.ownerFence
        })
      };
    if (!live(row.state))
      return { error: rejected("runtime.endpoint.fence_stale") };
    const now2 = this.#clock.now();
    if (row.expires_at && compareTime(row.expires_at, now2) <= 0)
      return { error: rejected("runtime.endpoint.lease_expired") };
    return { row };
  }
  claim(input) {
    if (!input.ownerInstanceId.trim())
      return rejected("runtime.endpoint.owner_invalid");
    if (!Number.isInteger(input.leaseMs) || input.leaseMs < 1)
      return rejected("runtime.endpoint.lease_invalid");
    return this.#database.transaction(() => {
      const generationError = this.#validateGeneration(input.generationId);
      if (generationError)
        return generationError;
      const now2 = this.#clock.now();
      const fenceRow = this.#database.prepare("SELECT MAX(fence) AS fence FROM endpoint_fences WHERE generation_id = ? AND route_kind = ?").get(input.generationId, input.routeKind);
      const fence = (fenceRow?.fence ?? 0) + 1;
      const endpointId = input.endpointId ?? `endpoint_${sha256(`${input.generationId}:${input.routeKind}:${input.ownerInstanceId}:${fence}`).slice(0, 24)}`;
      const existing = this.#row(endpointId);
      if (existing) {
        if (live(existing.state) && existing.generation_id === input.generationId && existing.route_kind === input.routeKind && existing.owner_instance_id === input.ownerInstanceId)
          return accepted(existing.endpoint_id, existing.revision, existing.owner_fence);
        return rejected("runtime.endpoint.endpoint_conflict");
      }
      const prior = this.#database.prepare("SELECT endpoint_id, generation_id, route_kind, revision, state, owner_fence, owner_instance_id, delivery_mode, readiness_state, control_state, consumer_ready, consumption_observed, delivery_observed, delivery_failed, claimed_at, heartbeat_at, expires_at, superseded_at FROM endpoint_claims WHERE generation_id = ? AND route_kind = ? AND state IN ('claiming', 'healthy', 'degraded') ORDER BY owner_fence DESC LIMIT 1").get(input.generationId, input.routeKind);
      const revision = this.#nextRevision(input.generationId);
      if (prior) {
        this.#database.prepare("UPDATE endpoint_claims SET state = 'superseded', superseded_at = ?, revision = ? WHERE endpoint_id = ?").run(now2, revision, prior.endpoint_id);
      }
      const expiresAt = this.#clock.after(input.leaseMs);
      this.#database.prepare("INSERT INTO endpoint_fences(generation_id, route_kind, fence, allocated_at, owner_instance_id) VALUES (?, ?, ?, ?, ?)").run(input.generationId, input.routeKind, fence, now2, input.ownerInstanceId);
      this.#database.prepare("INSERT INTO endpoint_claims(endpoint_id, generation_id, route_kind, revision, state, owner_fence, owner_instance_id, delivery_mode, readiness_state, control_state, consumer_ready, consumption_observed, delivery_observed, delivery_failed, claimed_at, heartbeat_at, expires_at, superseded_at) VALUES (?, ?, ?, ?, 'claiming', ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, NULL)").run(endpointId, input.generationId, input.routeKind, revision, fence, input.ownerInstanceId, input.deliveryMode, input.readiness ?? "uninitialized", input.controlState ?? "disabled", now2, now2, expiresAt);
      this.#emit({
        endpoint_id: endpointId,
        generation_id: input.generationId,
        route_kind: input.routeKind,
        revision,
        owner_fence: fence
      }, "endpoint.claimed", now2);
      return accepted(endpointId, revision, fence);
    })();
  }
  heartbeat(input) {
    if (!Number.isInteger(input.leaseMs) || input.leaseMs < 1)
      return rejected("runtime.endpoint.lease_invalid");
    return this.#database.transaction(() => {
      const generationError = this.#validateGeneration(input.generationId);
      if (generationError)
        return generationError;
      const checked = this.#validateOwner(input);
      if (checked.error)
        return checked.error;
      const row = checked.row;
      const now2 = this.#clock.now();
      const revision = row.revision + 1;
      this.#database.prepare("UPDATE endpoint_claims SET revision = ?, heartbeat_at = ?, expires_at = ? WHERE endpoint_id = ?").run(revision, input.heartbeatAt ?? now2, this.#clock.after(input.leaseMs), row.endpoint_id);
      this.#emit({ ...row, revision }, "endpoint.heartbeat", now2);
      return accepted(row.endpoint_id, revision);
    })();
  }
  reportHealth(input) {
    return this.#database.transaction(() => {
      const generationError = this.#validateGeneration(input.generationId);
      if (generationError)
        return generationError;
      const checked = this.#validateOwner(input);
      if (checked.error)
        return checked.error;
      const row = checked.row;
      const now2 = this.#clock.now();
      const revision = row.revision + 1;
      this.#database.prepare("UPDATE endpoint_claims SET state = ?, revision = ? WHERE endpoint_id = ?").run(input.state, revision, row.endpoint_id);
      this.#emit({ ...row, revision }, "endpoint.health", now2);
      return accepted(row.endpoint_id, revision);
    })();
  }
  reportReadiness(input) {
    return this.#database.transaction(() => {
      const generationError = this.#validateGeneration(input.generationId);
      if (generationError)
        return generationError;
      const checked = this.#validateOwner(input);
      if (checked.error)
        return checked.error;
      const row = checked.row;
      const now2 = this.#clock.now();
      const revision = row.revision + 1;
      this.#database.prepare("UPDATE endpoint_claims SET delivery_mode = ?, readiness_state = ?, control_state = ?, revision = ? WHERE endpoint_id = ?").run(input.deliveryMode, input.readiness, input.controlState ?? row.control_state, revision, row.endpoint_id);
      this.#emit({ ...row, revision }, "endpoint.readiness", now2);
      return accepted(row.endpoint_id, revision);
    })();
  }
  probe(input) {
    return this.#database.transaction(() => {
      const generationError = this.#validateGeneration(input.generationId);
      if (generationError)
        return generationError;
      const checked = this.#validateOwner(input);
      if (checked.error)
        return checked.error;
      const row = checked.row;
      const now2 = this.#clock.now();
      const revision = row.revision + 1;
      const readiness = input.readiness ?? (input.consumerReady ? "ready" : "held_waiting");
      this.#database.prepare("UPDATE endpoint_claims SET readiness_state = ?, consumer_ready = ?, revision = ? WHERE endpoint_id = ?").run(readiness, input.consumerReady ? 1 : 0, revision, row.endpoint_id);
      this.#emit({ ...row, revision }, "endpoint.consumer_probe", now2);
      return accepted(row.endpoint_id, revision);
    })();
  }
  reportDelivery(input) {
    return this.#database.transaction(() => {
      const generationError = this.#validateGeneration(input.generationId);
      if (generationError)
        return generationError;
      const checked = this.#validateOwner(input);
      if (checked.error)
        return checked.error;
      const row = checked.row;
      const now2 = this.#clock.now();
      const revision = row.revision + 1;
      const readiness = input.readiness ?? (input.status === "failed" ? "unhealthy" : row.readiness_state);
      this.#database.prepare("UPDATE endpoint_claims SET readiness_state = ?, delivery_observed = ?, delivery_failed = ?, revision = ? WHERE endpoint_id = ?").run(readiness, input.status === "delivered" ? 1 : row.delivery_observed, input.status === "failed" ? 1 : input.status === "delivered" ? 0 : row.delivery_failed, revision, row.endpoint_id);
      this.#emit({ ...row, revision }, `endpoint.delivery.${input.status}`, now2);
      return accepted(row.endpoint_id, revision);
    })();
  }
  reportCapability(input) {
    if (!input.capability.capability.trim())
      return rejected("runtime.endpoint.capability_invalid");
    return this.#database.transaction(() => {
      const generationError = this.#validateGeneration(input.generationId);
      if (generationError)
        return generationError;
      const checked = this.#validateOwner(input);
      if (checked.error)
        return checked.error;
      const row = checked.row;
      const now2 = this.#clock.now();
      const revision = row.revision + 1;
      const id2 = sha256(
        // A readiness transition can legitimately follow the initial status
        // observation in the same clock tick. Include the observed capability
        // facts, not just the timestamp, so the durable projection records that
        // transition instead of mistaking it for a replay.
        `${row.endpoint_id}:${input.capability.capability}:${input.capability.evidenceKind}:${input.capability.observedAt}:${input.capability.qualification}:${input.capability.deliveryMode}:${input.capability.readiness}:${json4(input.evidence)}`
      ).slice(0, 32);
      if (this.#database.prepare("SELECT id FROM capability_observations WHERE id = ?").get(id2))
        return {
          disposition: "ignored",
          code: "runtime.endpoint.capability_duplicate",
          endpointId: row.endpoint_id,
          revision: row.revision
        };
      this.#database.prepare("INSERT OR REPLACE INTO capability_observations(id, endpoint_id, capability, adapter_id, adapter_version, qualification_state, delivery_mode, readiness_state, evidence_kind, evidence_json, observed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id2, row.endpoint_id, input.capability.capability, input.capability.adapterId, input.capability.adapterVersion, input.capability.qualification, input.capability.deliveryMode, input.capability.readiness, input.capability.evidenceKind, json4(input.evidence), input.capability.observedAt, input.capability.expiresAt ?? null);
      this.#database.prepare("UPDATE endpoint_claims SET consumption_observed = CASE WHEN ? = 1 THEN 1 ELSE consumption_observed END, revision = ? WHERE endpoint_id = ?").run(consumedEvidence(input.evidence) ? 1 : 0, revision, row.endpoint_id);
      this.#emit({ ...row, revision }, "endpoint.capability", now2);
      return accepted(row.endpoint_id, revision);
    })();
  }
  release(input) {
    return this.#database.transaction(() => {
      const generationError = this.#validateGeneration(input.generationId);
      if (generationError)
        return generationError;
      const checked = this.#validateOwner(input);
      if (checked.error)
        return checked.error;
      const row = checked.row;
      const now2 = this.#clock.now();
      const revision = row.revision + 1;
      this.#database.prepare("UPDATE endpoint_claims SET state = 'released', readiness_state = 'uninitialized', control_state = 'disabled', revision = ?, expires_at = NULL WHERE endpoint_id = ?").run(revision, row.endpoint_id);
      this.#emit({ ...row, revision }, "endpoint.released", now2);
      return accepted(row.endpoint_id, revision);
    })();
  }
  expire(now2 = this.#clock.now()) {
    return this.#database.transaction(() => {
      const rows = this.#database.prepare("SELECT endpoint_claims.endpoint_id, endpoint_claims.generation_id, endpoint_claims.route_kind, endpoint_claims.revision, endpoint_claims.state, endpoint_claims.owner_fence, endpoint_claims.owner_instance_id, endpoint_claims.delivery_mode, endpoint_claims.readiness_state, endpoint_claims.control_state, endpoint_claims.consumer_ready, endpoint_claims.consumption_observed, endpoint_claims.delivery_observed, endpoint_claims.delivery_failed, endpoint_claims.claimed_at, endpoint_claims.heartbeat_at, endpoint_claims.expires_at, endpoint_claims.superseded_at, session_generations.lifecycle_state AS generation_lifecycle_state FROM endpoint_claims JOIN session_generations ON session_generations.generation_id = endpoint_claims.generation_id WHERE endpoint_claims.state IN ('claiming', 'healthy', 'degraded') AND endpoint_claims.expires_at IS NOT NULL AND endpoint_claims.expires_at <= ? ORDER BY endpoint_claims.generation_id, endpoint_claims.route_kind, endpoint_claims.owner_fence").all(now2);
      return rows.map((row) => {
        if (terminal(row.generation_lifecycle_state))
          return rejected("runtime.endpoint.generation_terminal", {
            remedy: "select a non-terminal generation"
          });
        const revision = row.revision + 1;
        this.#database.prepare("UPDATE endpoint_claims SET state = 'expired', readiness_state = 'uninitialized', control_state = 'disabled', revision = ?, superseded_at = NULL, expires_at = NULL WHERE endpoint_id = ?").run(revision, row.endpoint_id);
        this.#emit({ ...row, revision }, "endpoint.expired", now2);
        return accepted(row.endpoint_id, revision);
      });
    })();
  }
  #getCapabilities(endpointId, redact2 = true) {
    return Object.freeze(this.#database.prepare("SELECT id, capability, adapter_id, adapter_version, qualification_state, delivery_mode, readiness_state, evidence_kind, observed_at, expires_at FROM capability_observations WHERE endpoint_id = ? ORDER BY observed_at DESC, id DESC").all(endpointId).map((row) => Object.freeze({
      capability: redact2 ? redactIdentifier(row.capability) : row.capability,
      adapterId: redact2 ? redactIdentifier(row.adapter_id) : row.adapter_id,
      adapterVersion: row.adapter_version,
      qualification: row.qualification_state,
      deliveryMode: row.delivery_mode,
      readiness: row.readiness_state,
      evidenceKind: row.evidence_kind,
      observedAt: row.observed_at,
      ...row.expires_at ? { expiresAt: row.expires_at } : {}
    })));
  }
  #viewRow(row) {
    return Object.freeze({
      endpointId: redactIdentifier(row.endpoint_id),
      generationId: row.generation_id,
      routeKind: row.route_kind,
      revision: row.revision,
      state: row.state,
      ownerFence: row.owner_fence,
      ownerInstanceId: redactIdentifier(row.owner_instance_id),
      deliveryMode: row.delivery_mode,
      readiness: row.readiness_state,
      controlState: row.control_state,
      consumerReady: row.consumer_ready === 1,
      consumptionObserved: row.consumption_observed === 1,
      deliveryObserved: row.delivery_observed === 1,
      deliveryFailed: row.delivery_failed === 1,
      claimedAt: row.claimed_at,
      ...row.heartbeat_at ? { heartbeatAt: row.heartbeat_at } : {},
      ...row.expires_at ? { expiresAt: row.expires_at } : {},
      ...row.superseded_at ? { supersededAt: row.superseded_at } : {},
      capabilities: this.#getCapabilities(row.endpoint_id)
    });
  }
  get(endpointId) {
    const row = this.#row(endpointId);
    return row ? this.#viewRow(row) : void 0;
  }
  list(generationId) {
    return Object.freeze(this.#database.prepare("SELECT endpoint_id, generation_id, route_kind, revision, state, owner_fence, owner_instance_id, delivery_mode, readiness_state, control_state, consumer_ready, consumption_observed, delivery_observed, delivery_failed, claimed_at, heartbeat_at, expires_at, superseded_at FROM endpoint_claims WHERE generation_id = ? ORDER BY route_kind, owner_fence DESC, endpoint_id").all(generationId).map((row) => this.#viewRow(row)));
  }
  eligibility(input) {
    return this.#classifyEligibility(input, ["ready"], false);
  }
  deliveryEligibility(input) {
    const result2 = this.#classifyEligibility(input, ["ready", "pull_only", "next_turn"], true);
    if (result2.disposition !== "eligible" || !result2.endpoint)
      return Object.freeze({ ...result2, disposition: "ineligible" });
    const disposition = result2.endpoint.readiness === "ready" ? "ready" : result2.endpoint.readiness === "pull_only" ? "pull_only" : "next_turn";
    return Object.freeze({ ...result2, disposition });
  }
  #classifyEligibility(input, acceptedReadiness, requireControl) {
    const now2 = input.now ?? this.#clock.now();
    const generation2 = this.#database.prepare("SELECT lifecycle_state FROM session_generations WHERE generation_id = ?").get(input.generationId);
    const facts = {
      generationId: input.generationId,
      routeKind: input.routeKind
    };
    if (!generation2)
      return {
        disposition: "ineligible",
        code: "runtime.endpoint.generation_unresolved",
        remedy: "select a known generation",
        facts
      };
    if (terminal(generation2.lifecycle_state))
      return {
        disposition: "ineligible",
        code: "runtime.endpoint.generation_terminal",
        remedy: "select a non-terminal generation",
        facts
      };
    const row = this.#database.prepare("SELECT endpoint_id, generation_id, route_kind, revision, state, owner_fence, owner_instance_id, delivery_mode, readiness_state, control_state, consumer_ready, consumption_observed, delivery_observed, delivery_failed, claimed_at, heartbeat_at, expires_at, superseded_at FROM endpoint_claims WHERE generation_id = ? AND route_kind = ? AND state IN ('claiming', 'healthy', 'degraded') ORDER BY owner_fence DESC LIMIT 1").get(input.generationId, input.routeKind);
    if (!row)
      return {
        disposition: "ineligible",
        code: "runtime.endpoint.unclaimed",
        remedy: "claim the endpoint",
        facts
      };
    const endpoint3 = this.#viewRow(row);
    const endpointFacts2 = {
      ...facts,
      endpointId: redactIdentifier(row.endpoint_id),
      ownerFence: row.owner_fence
    };
    const expectedFence = input.expectedOwnerFence ?? input.expectedFence;
    if (expectedFence !== void 0 && expectedFence !== row.owner_fence)
      return {
        disposition: "ineligible",
        code: "runtime.endpoint.queued_fence_stale",
        remedy: "refresh endpoint eligibility before delivery",
        endpoint: endpoint3,
        facts: {
          ...endpointFacts2,
          expectedFence,
          currentFence: row.owner_fence
        }
      };
    if (row.expires_at && compareTime(row.expires_at, now2) <= 0)
      return {
        disposition: "ineligible",
        code: "runtime.endpoint.lease_expired",
        remedy: "renew the endpoint lease",
        endpoint: endpoint3,
        facts: endpointFacts2
      };
    if (row.state !== "healthy")
      return {
        disposition: "ineligible",
        code: "runtime.endpoint.health_unready",
        remedy: "report a healthy endpoint",
        endpoint: endpoint3,
        facts: endpointFacts2
      };
    if (row.control_state !== "enabled" && (input.routeKind === "control" || requireControl))
      return {
        disposition: "ineligible",
        code: "runtime.endpoint.control_disabled",
        remedy: "enable endpoint control",
        endpoint: endpoint3,
        facts: endpointFacts2
      };
    if (!acceptedReadiness.includes(row.readiness_state))
      return {
        disposition: "ineligible",
        code: "runtime.endpoint.readiness_unready",
        remedy: "report delivery readiness",
        endpoint: endpoint3,
        facts: endpointFacts2
      };
    if (!input.requiredCapability)
      return {
        disposition: "eligible",
        code: "runtime.endpoint.eligible",
        remedy: "none",
        endpoint: endpoint3,
        facts: endpointFacts2
      };
    if (!row.consumer_ready)
      return {
        disposition: "ineligible",
        code: "runtime.endpoint.consumer_unready",
        remedy: "probe a ready consumer",
        endpoint: endpoint3,
        facts: endpointFacts2
      };
    if (row.delivery_failed || !row.delivery_observed && !row.consumption_observed)
      return {
        disposition: "ineligible",
        code: "runtime.endpoint.delivery_unready",
        remedy: "report successful delivery",
        endpoint: endpoint3,
        facts: endpointFacts2
      };
    const storedCapability = this.#getCapabilities(row.endpoint_id, false).find((candidate) => candidate.capability === input.requiredCapability && (!candidate.expiresAt || compareTime(candidate.expiresAt, now2) > 0));
    if (!storedCapability)
      return {
        disposition: "ineligible",
        code: "runtime.endpoint.capability_unqualified",
        remedy: "report verified capability evidence",
        endpoint: endpoint3,
        facts: endpointFacts2
      };
    const capability3 = Object.freeze({
      ...storedCapability,
      capability: redactIdentifier(storedCapability.capability),
      adapterId: redactIdentifier(storedCapability.adapterId)
    });
    const capabilityFacts = {
      ...endpointFacts2,
      capability: redactIdentifier(capability3.capability)
    };
    if (capability3.deliveryMode !== row.delivery_mode)
      return {
        disposition: "ineligible",
        code: "runtime.endpoint.capability_mode_mismatch",
        remedy: "report capability for endpoint delivery mode",
        endpoint: endpoint3,
        capability: capability3,
        facts: capabilityFacts
      };
    if (capability3.qualification !== "supported")
      return {
        disposition: "ineligible",
        code: "runtime.endpoint.capability_unqualified",
        remedy: "report supported capability evidence",
        endpoint: endpoint3,
        capability: capability3,
        facts: capabilityFacts
      };
    if (capability3.readiness !== row.readiness_state)
      return {
        disposition: "ineligible",
        code: "runtime.endpoint.capability_unready",
        remedy: "report ready capability evidence",
        endpoint: endpoint3,
        capability: capability3,
        facts: capabilityFacts
      };
    if (!row.consumption_observed)
      return {
        disposition: "ineligible",
        code: "runtime.endpoint.capability_consumption_unverified",
        remedy: "report verified consumption evidence",
        endpoint: endpoint3,
        capability: capability3,
        facts: capabilityFacts
      };
    return {
      disposition: "eligible",
      code: "runtime.endpoint.eligible",
      remedy: "none",
      endpoint: endpoint3,
      capability: capability3,
      facts: capabilityFacts
    };
  }
};

// packages/domain/dist/explain.js
function explanation(code, severity, facts) {
  return { code, severity, facts };
}

// packages/domain/dist/lifecycle.js
var lifecycleRank = {
  starting: 0,
  idle: 1,
  active: 1,
  waiting: 1,
  ending: 2,
  ended: 3,
  errored: 3,
  superseded: 3
};
var terminalStates2 = /* @__PURE__ */ new Set([
  "ended",
  "errored",
  "superseded"
]);
function isTerminal(state) {
  return terminalStates2.has(state);
}
function lifecycleDecision(current, next) {
  const currentRank = lifecycleRank[current] ?? 0;
  const nextRank = lifecycleRank[next] ?? 0;
  const facts = { current, next, currentRank, nextRank };
  if (current === next)
    return {
      disposition: "ignored",
      explanation: explanation("domain.lifecycle.duplicate", "info", facts)
    };
  if (nextRank < currentRank)
    return {
      disposition: "rejected",
      explanation: explanation(isTerminal(current) ? "domain.lifecycle.terminal" : "domain.lifecycle.regression", "error", facts)
    };
  if (isTerminal(current) && !isTerminal(next))
    return {
      disposition: "rejected",
      explanation: explanation("domain.lifecycle.terminal", "error", facts)
    };
  return {
    disposition: "applied",
    explanation: explanation("domain.event.applied", "info", facts)
  };
}

// packages/persistence/dist/session-repository.js
function objectJson(value2) {
  if (!value2)
    return {};
  try {
    const parsed = JSON.parse(value2);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function stableValue(value2) {
  if (Array.isArray(value2))
    return value2.map(stableValue);
  if (!value2 || typeof value2 !== "object")
    return value2;
  return Object.fromEntries(Object.entries(value2).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, stableValue(nested)]));
}
function json5(value2) {
  return JSON.stringify(stableValue(value2));
}
function terminal2(value2) {
  return value2 === "ended" || value2 === "errored" || value2 === "superseded";
}
function rank(value2) {
  return lifecycleRank[value2] ?? 0;
}
function version(signal) {
  return {
    source: signal.clocks.source_event_at ?? signal.clocks.source_observed_at,
    tie: `${signal.event_id}:${signal.producer_instance_id}`
  };
}
function compareVersion(left, right) {
  const source = left.source.localeCompare(right.source);
  if (source !== 0)
    return source;
  return left.tie.localeCompare(right.tie);
}
function provenance2(version_, signal) {
  return {
    eventId: signal.event_id,
    producerInstanceId: signal.producer_instance_id,
    sourceTime: version_.source,
    tieBreak: version_.tie
  };
}
function readVersion(value2) {
  if (typeof value2.sourceTime !== "string" || typeof value2.tieBreak !== "string")
    return void 0;
  return { source: value2.sourceTime, tie: value2.tieBreak };
}
function readFieldVersion(value2, key) {
  const candidate = value2[key];
  return candidate && typeof candidate === "object" && !Array.isArray(candidate) ? readVersion(candidate) : void 0;
}
function isTerminalState(value2) {
  return terminal2(value2);
}
function generationRef(signal) {
  const payload2 = signal.payload;
  if ("generation" in payload2)
    return {
      projectId: payload2.generation.project_id,
      sessionId: payload2.generation.session_id,
      generationId: payload2.generation.generation_id
    };
  return void 0;
}
function aliasKey(input) {
  return [
    input.projectId,
    input.harness,
    input.aliasKind,
    input.producerId ?? null,
    input.alias
  ];
}
var RuntimeSessionRepository = class {
  #database;
  #clock;
  constructor(database, clock) {
    this.#database = database;
    this.#clock = clock;
  }
  attachAlias(input) {
    const transaction = this.#database.transaction(() => {
      const result2 = this.#attachAlias(input);
      if (result2.disposition === "accepted" && result2.sessionId)
        this.#recordAliasEffect(input, result2.sessionId, result2.generationId);
      return result2;
    });
    return transaction();
  }
  apply(input) {
    const transaction = this.#database.transaction(() => this.#apply(input));
    return transaction();
  }
  #apply(input) {
    const signal = input.signal;
    const ref = generationRef(signal);
    if (!ref)
      return {
        disposition: "rejected",
        code: "runtime.session.invalid_payload"
      };
    const project2 = this.#database.prepare("SELECT project_id FROM projects WHERE project_id = ?").get(ref.projectId);
    if (!project2)
      return {
        disposition: "rejected",
        code: "runtime.session.project_unresolved",
        details: { projectId: ref.projectId }
      };
    if (input.alias) {
      if (input.alias.projectId !== ref.projectId || input.alias.harness !== signal.harness)
        return {
          disposition: "review",
          code: "runtime.session.alias_scope_conflict"
        };
      const existing = this.#database.prepare("SELECT session_id, generation_id FROM session_aliases WHERE project_id = ? AND harness = ? AND alias_kind = ? AND COALESCE(producer_id, '') = COALESCE(?, '') AND alias = ?").get(...aliasKey(input.alias));
      if (existing && existing.session_id !== ref.sessionId)
        return {
          disposition: "review",
          code: "runtime.session.alias_conflict",
          details: { scope: "project_harness_producer" }
        };
      if (!existing && !input.alias.sessionId)
        return {
          disposition: "review",
          code: "runtime.session.alias_unresolved"
        };
      if (existing && existing.session_id === null)
        return {
          disposition: "review",
          code: "runtime.session.alias_unresolved"
        };
    }
    if (signal.payload.kind === "session.started" || signal.payload.kind === "session.resumed")
      return this.#start(signal, input.alias);
    const row = this.#database.prepare("SELECT * FROM session_generations WHERE project_id = ? AND session_id = ? AND generation_id = ?").get(ref.projectId, ref.sessionId, ref.generationId);
    if (!row) {
      this.#queuePending(signal, ref);
      return {
        disposition: "review",
        code: "runtime.session.generation_pending",
        sessionId: ref.sessionId,
        generationId: ref.generationId
      };
    }
    if (signal.payload.kind === "session.metadata_patched")
      return this.#patchMetadata(row, signal);
    if (signal.payload.kind === "session.activity" || signal.payload.kind === "session.idle" || signal.payload.kind === "session.waiting" || signal.payload.kind === "session.ended")
      return this.#lifecycle(row, signal);
    return {
      disposition: "rejected",
      code: "runtime.session.unsupported_event"
    };
  }
  #queuePending(signal, ref) {
    this.#database.prepare("INSERT OR REPLACE INTO session_pending_events(event_id, project_id, session_id, generation_id, event_json, source_observed_at, received_at, producer_instance_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(signal.event_id, ref.projectId, ref.sessionId, ref.generationId, json5(signal), signal.clocks.source_event_at ?? signal.clocks.source_observed_at, signal.clocks.received_at, signal.producer_instance_id);
  }
  #start(signal, alias) {
    const ref = generationRef(signal);
    if (!ref)
      return {
        disposition: "rejected",
        code: "runtime.session.invalid_payload"
      };
    const payload2 = signal.payload;
    if (payload2.kind !== "session.started" && payload2.kind !== "session.resumed")
      return {
        disposition: "rejected",
        code: "runtime.session.invalid_payload"
      };
    const existing = this.#database.prepare("SELECT * FROM session_generations WHERE project_id = ? AND session_id = ? AND generation_id = ?").get(ref.projectId, ref.sessionId, ref.generationId);
    if (existing)
      return {
        disposition: "duplicate",
        code: "runtime.session.generation_duplicate",
        sessionId: ref.sessionId,
        generationId: ref.generationId
      };
    if (payload2.kind === "session.resumed") {
      const parentId = payload2.resumed_from_generation_id;
      const parent2 = typeof parentId === "string" && parentId.length > 0 ? this.#database.prepare("SELECT generation_id FROM session_generations WHERE project_id = ? AND session_id = ? AND generation_id = ?").get(ref.projectId, ref.sessionId, parentId) : void 0;
      if (!parent2) {
        this.#queuePending(signal, ref);
        return {
          disposition: "review",
          code: "runtime.session.generation_parent_pending",
          sessionId: ref.sessionId,
          generationId: ref.generationId
        };
      }
    }
    const now2 = this.#clock.now();
    const v = version(signal);
    this.#database.prepare("INSERT OR IGNORE INTO logical_sessions(session_id, project_id, provenance_json, created_at) VALUES (?, ?, ?, ?)").run(ref.sessionId, ref.projectId, json5(provenance2(v, signal)), now2);
    const active2 = this.#database.prepare("SELECT generation_id, lifecycle_state, lifecycle_provenance_json FROM session_generations WHERE project_id = ? AND session_id = ? AND lifecycle_state NOT IN ('ended','errored','superseded') ORDER BY ordinal DESC").get(ref.projectId, ref.sessionId);
    let createdState = "starting";
    let createdLifecycle = provenance2(v, signal);
    let createdEndedAt = null;
    if (active2) {
      const prior = objectJson(active2.lifecycle_provenance_json);
      const priorVersion = readVersion(prior);
      if (!priorVersion || compareVersion(v, priorVersion) > 0) {
        this.#database.prepare("UPDATE session_generations SET lifecycle_state = 'superseded', lifecycle_provenance_json = ?, ended_at = ? WHERE generation_id = ?").run(json5(provenance2(v, signal)), v.source, active2.generation_id);
      } else {
        createdState = "superseded";
        createdLifecycle = prior;
        createdEndedAt = priorVersion.source;
      }
    }
    const ordinal = Number(this.#database.prepare("SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM session_generations WHERE project_id = ? AND session_id = ?").get(ref.projectId, ref.sessionId)?.next ?? 1);
    const metadata = payload2.kind === "session.started" ? payload2.metadata ?? {} : {};
    const fieldProv = Object.fromEntries(Object.keys(metadata).map((key) => [key, provenance2(v, signal)]));
    const parent = payload2.kind === "session.resumed" ? payload2.resumed_from_generation_id ?? null : null;
    this.#database.prepare("INSERT INTO session_generations(generation_id, session_id, project_id, ordinal, harness, lifecycle_state, lifecycle_schema_version, lifecycle_provenance_json, field_schema_version, field_provenance_json, source_observed_at, received_at, activity_at, materialized_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, 'golem.lifecycle/v1', ?, 'golem.fields/v1', ?, ?, ?, NULL, ?, ?)").run(ref.generationId, ref.sessionId, ref.projectId, ordinal, signal.harness, createdState, json5(createdLifecycle), json5(fieldProv), signal.clocks.source_observed_at, signal.clocks.received_at, now2, createdEndedAt);
    this.#database.prepare("INSERT INTO generation_projection(project_id, session_id, generation_id, revision, metadata_json, field_provenance_json, parent_generation_id, continuation, actor_activity_at, observed_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL, ?)").run(ref.projectId, ref.sessionId, ref.generationId, json5(metadata), json5(fieldProv), parent, parent ? "resume" : null, now2);
    const sessionRevision = this.#ensureSessionProjection(ref.projectId, ref.sessionId, metadata, fieldProv, now2);
    const started = this.#accepted(ref, sessionRevision, "runtime.session.generation_started", signal);
    if (alias) {
      const aliasResult = this.#attachAlias(alias, ref.sessionId, ref.generationId);
      if (aliasResult.disposition === "accepted")
        this.#recordAliasEffect(alias, ref.sessionId, ref.generationId);
    }
    this.#replayPending(ref.projectId, ref.sessionId);
    return started;
  }
  #replayPending(projectId2, sessionId) {
    const pending = this.#database.prepare("SELECT event_id, event_json FROM session_pending_events WHERE project_id = ? AND session_id = ? ORDER BY source_observed_at, event_id, producer_instance_id").all(projectId2, sessionId);
    for (const item of pending) {
      const pendingSignal = JSON.parse(item.event_json);
      const result2 = this.#apply({ signal: pendingSignal });
      if (result2.disposition !== "review")
        this.#database.prepare("DELETE FROM session_pending_events WHERE event_id = ?").run(item.event_id);
    }
  }
  #patchMetadata(row, signal) {
    if (terminal2(row.lifecycle_state))
      return {
        disposition: "ignored",
        code: "runtime.session.terminal_immutable",
        sessionId: row.session_id,
        generationId: row.generation_id
      };
    if (signal.payload.kind !== "session.metadata_patched")
      return {
        disposition: "rejected",
        code: "runtime.session.invalid_payload"
      };
    const projection = this.#database.prepare("SELECT * FROM generation_projection WHERE project_id = ? AND session_id = ? AND generation_id = ?").get(row.project_id, row.session_id, row.generation_id);
    if (!projection)
      return {
        disposition: "rejected",
        code: "runtime.session.projection_missing"
      };
    const incoming = version(signal);
    const metadata = { ...objectJson(projection.metadata_json) };
    const provenanceMap = { ...objectJson(projection.field_provenance_json) };
    let changed = false;
    for (const [key, value2] of Object.entries(signal.payload.metadata)) {
      const prior = readVersion(provenanceMap[key] && typeof provenanceMap[key] === "object" ? provenanceMap[key] : {});
      if (!prior || compareVersion(incoming, prior) > 0) {
        metadata[key] = value2;
        provenanceMap[key] = provenance2(incoming, signal);
        changed = true;
      }
    }
    for (const key of signal.clear_fields) {
      const prior = readVersion(provenanceMap[key] && typeof provenanceMap[key] === "object" ? provenanceMap[key] : {});
      if (!prior || compareVersion(incoming, prior) > 0) {
        delete metadata[key];
        provenanceMap[key] = provenance2(incoming, signal);
        changed = true;
      }
    }
    if (!changed)
      return {
        disposition: "ignored",
        code: "runtime.session.field_stale",
        sessionId: row.session_id,
        generationId: row.generation_id,
        revision: projection.revision
      };
    const now2 = this.#clock.now();
    const revision = projection.revision + 1;
    this.#database.prepare("UPDATE generation_projection SET revision = ?, metadata_json = ?, field_provenance_json = ?, updated_at = ? WHERE project_id = ? AND session_id = ? AND generation_id = ?").run(revision, json5(metadata), json5(provenanceMap), now2, row.project_id, row.session_id, row.generation_id);
    this.#updateSessionProjection(row.project_id, row.session_id, metadata, provenanceMap, now2);
    return this.#accepted({
      projectId: row.project_id,
      sessionId: row.session_id,
      generationId: row.generation_id
    }, revision, "runtime.session.metadata_patched", signal);
  }
  #lifecycle(row, signal) {
    const projection = this.#database.prepare("SELECT * FROM generation_projection WHERE project_id = ? AND session_id = ? AND generation_id = ?").get(row.project_id, row.session_id, row.generation_id);
    if (!projection)
      return {
        disposition: "rejected",
        code: "runtime.session.projection_missing"
      };
    const payload2 = signal.payload;
    const next = payload2.kind === "session.ended" ? payload2.disposition : payload2.kind === "session.activity" ? "active" : payload2.kind === "session.idle" ? "idle" : "waiting";
    const incoming = version(signal);
    const prior = readVersion(objectJson(row.lifecycle_provenance_json));
    const currentFields = objectJson(projection.field_provenance_json);
    const priorActivity = readFieldVersion(currentFields, "__activity");
    const activityApplies = payload2.kind === "session.activity" && (!priorActivity || compareVersion(incoming, priorActivity) > 0);
    const decision = lifecycleDecision(row.lifecycle_state, next);
    const lifecycleApplies = decision.disposition === "applied" && (rank(next) > rank(row.lifecycle_state) || rank(next) === rank(row.lifecycle_state) && (!prior || compareVersion(incoming, prior) > 0));
    if (!lifecycleApplies && !activityApplies)
      return {
        disposition: "ignored",
        code: isTerminalState(row.lifecycle_state) ? "runtime.session.terminal_immutable" : "runtime.session.lifecycle_stale",
        sessionId: row.session_id,
        generationId: row.generation_id,
        revision: projection.revision
      };
    const now2 = this.#clock.now();
    const activity = activityApplies ? incoming.source : row.activity_at;
    const state = lifecycleApplies ? next : row.lifecycle_state;
    const activityPresent = Boolean(activity || priorActivity);
    const canonicalRevision = (isTerminalState(state) ? 3 : rank(state) > 0 ? 2 : 1) + (activityPresent ? 1 : 0);
    const revision = Math.max(projection.revision, canonicalRevision);
    const lifecycleProvenance = lifecycleApplies ? provenance2(incoming, signal) : objectJson(row.lifecycle_provenance_json);
    const endedAt = isTerminalState(state) ? lifecycleApplies ? incoming.source : row.ended_at : null;
    const fieldProvenance = {
      ...currentFields,
      ...activityApplies ? { __activity: provenance2(incoming, signal) } : {}
    };
    this.#database.prepare("UPDATE session_generations SET lifecycle_state = ?, lifecycle_provenance_json = ?, activity_at = ?, ended_at = ? WHERE project_id = ? AND session_id = ? AND generation_id = ?").run(state, json5(lifecycleProvenance), activity, endedAt, row.project_id, row.session_id, row.generation_id);
    this.#database.prepare("UPDATE generation_projection SET revision = ?, field_provenance_json = ?, actor_activity_at = ?, updated_at = ? WHERE project_id = ? AND session_id = ? AND generation_id = ?").run(revision, json5(fieldProvenance), activity, now2, row.project_id, row.session_id, row.generation_id);
    this.#touchSessionProjection(row.project_id, row.session_id, activityApplies ? activity : void 0, now2, revision);
    return this.#accepted({
      projectId: row.project_id,
      sessionId: row.session_id,
      generationId: row.generation_id
    }, revision, activityApplies && !lifecycleApplies ? "runtime.session.activity_after_terminal" : `runtime.session.lifecycle_${state}`, signal);
  }
  #accepted(ref, revision, code, signal) {
    const outboxId = sha256(`session:${signal.event_id}:${ref.sessionId}:${revision}`).slice(0, 32);
    const now2 = this.#clock.now();
    this.#database.prepare("INSERT OR IGNORE INTO runtime_outbox(id, destination, payload_json, status, created_at, attempts) VALUES (?, 'tracker', ?, 'pending', ?, 0)").run(outboxId, json5({
      event_id: signal.event_id,
      event_kind: signal.event_kind,
      session_id: ref.sessionId,
      generation_id: ref.generationId,
      revision
    }), now2);
    return {
      disposition: "accepted",
      code,
      sessionId: ref.sessionId,
      ...ref.generationId ? { generationId: ref.generationId } : {},
      revision
    };
  }
  #commandSignal(context, kind, payload2, clearFields = []) {
    return {
      schema_version: "golem.runtime-signal/v1",
      event_id: context.eventId,
      event_kind: kind,
      producer: "session-command",
      producer_instance_id: context.producerInstanceId,
      harness: context.harness,
      correlation_id: context.eventId,
      deduplication_key: `session-command:${context.eventId}`,
      clocks: {
        source_observed_at: context.sourceObservedAt,
        received_at: context.receivedAt,
        materialized_at: context.receivedAt
      },
      provenance: {
        source: "api",
        confidence: "verified",
        evidence_id: context.eventId
      },
      clear_fields: [...clearFields],
      payload: payload2
    };
  }
  #checkRevision(context) {
    const view = this.get(context.projectId, context.sessionId);
    if (!view)
      return {
        disposition: "rejected",
        code: "runtime.session.session_unresolved"
      };
    if (view.revision !== context.expectedRevision)
      return {
        disposition: "rejected",
        code: "runtime.session.revision_conflict",
        revision: view.revision,
        sessionId: context.sessionId,
        generationId: context.generationId
      };
    return void 0;
  }
  rename(input) {
    const conflict = this.#checkRevision(input);
    if (conflict)
      return conflict;
    return this.apply({
      signal: this.#commandSignal(input, "session.metadata_patched", {
        kind: "session.metadata_patched",
        generation: {
          project_id: input.projectId,
          session_id: input.sessionId,
          generation_id: input.generationId
        },
        metadata: { name: input.name }
      })
    });
  }
  patchMetadata(input) {
    const conflict = this.#checkRevision(input);
    if (conflict)
      return conflict;
    return this.apply({
      signal: this.#commandSignal(input, "session.metadata_patched", {
        kind: "session.metadata_patched",
        generation: {
          project_id: input.projectId,
          session_id: input.sessionId,
          generation_id: input.generationId
        },
        metadata: input.metadata
      }, input.clearFields ?? [])
    });
  }
  end(input) {
    const conflict = this.#checkRevision(input);
    if (conflict)
      return conflict;
    return this.apply({
      signal: this.#commandSignal(input, "session.ended", {
        kind: "session.ended",
        generation: {
          project_id: input.projectId,
          session_id: input.sessionId,
          generation_id: input.generationId
        },
        disposition: input.disposition
      })
    });
  }
  #ensureSessionProjection(projectId2, sessionId, metadata, fields, now2) {
    const before = this.#database.prepare("SELECT revision FROM session_projection WHERE project_id = ? AND session_id = ?").get(projectId2, sessionId);
    if (before) {
      this.#database.prepare("UPDATE session_projection SET revision = revision + 1, updated_at = ? WHERE project_id = ? AND session_id = ?").run(now2, projectId2, sessionId);
      return before.revision + 1;
    }
    this.#database.prepare("INSERT OR IGNORE INTO session_projection(project_id, session_id, revision, metadata_json, field_provenance_json, role_json, actor_activity_at, observed_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, NULL, NULL, ?)").run(projectId2, sessionId, json5(metadata), json5(fields), typeof metadata.role === "string" ? metadata.role : null, now2);
    return 1;
  }
  #updateSessionProjection(projectId2, sessionId, metadata, fields, now2) {
    this.#database.prepare("UPDATE session_projection SET revision = revision + 1, metadata_json = ?, field_provenance_json = ?, role_json = ?, updated_at = ? WHERE project_id = ? AND session_id = ?").run(json5(metadata), json5(fields), typeof metadata.role === "string" ? metadata.role : null, now2, projectId2, sessionId);
  }
  #touchSessionProjection(projectId2, sessionId, activity, now2, minimumRevision) {
    const revision = minimumRevision ? this.#database.prepare("SELECT revision FROM session_projection WHERE project_id = ? AND session_id = ?").get(projectId2, sessionId)?.revision ?? 0 : void 0;
    if (activity === void 0)
      this.#database.prepare(`UPDATE session_projection SET revision = ${revision === void 0 ? "revision + 1" : `MAX(revision, ${revision})`}, updated_at = ? WHERE project_id = ? AND session_id = ?`).run(now2, projectId2, sessionId);
    else
      this.#database.prepare(`UPDATE session_projection SET revision = ${revision === void 0 ? "revision + 1" : `MAX(revision, ${revision})`}, actor_activity_at = ?, updated_at = ? WHERE project_id = ? AND session_id = ?`).run(activity, now2, projectId2, sessionId);
  }
  #attachAlias(input, sessionId = input.sessionId, generationId = input.generationId) {
    if (!sessionId)
      return {
        disposition: "review",
        code: "runtime.session.alias_unresolved"
      };
    const session2 = this.#database.prepare("SELECT project_id FROM logical_sessions WHERE project_id = ? AND session_id = ?").get(input.projectId, sessionId);
    if (!session2)
      return {
        disposition: "review",
        code: "runtime.session.alias_unresolved"
      };
    if (generationId) {
      const generation2 = this.#database.prepare("SELECT project_id FROM session_generations WHERE project_id = ? AND session_id = ? AND generation_id = ?").get(input.projectId, sessionId, generationId);
      if (!generation2)
        return {
          disposition: "review",
          code: "runtime.session.alias_unresolved"
        };
    }
    const existing = this.#database.prepare("SELECT session_id, generation_id FROM session_aliases WHERE project_id = ? AND harness = ? AND alias_kind = ? AND COALESCE(producer_id, '') = COALESCE(?, '') AND alias = ?").get(...aliasKey(input));
    if (existing && (existing.session_id !== sessionId || generationId && existing.generation_id && existing.generation_id !== generationId))
      return { disposition: "review", code: "runtime.session.alias_conflict" };
    if (existing && existing.session_id === sessionId && (existing.generation_id ?? null) === (generationId ?? null))
      return {
        disposition: "duplicate",
        code: "runtime.session.alias_duplicate",
        sessionId,
        ...generationId ? { generationId } : {}
      };
    if (!existing)
      this.#database.prepare("INSERT INTO session_aliases(project_id, harness, alias_kind, producer_id, alias, session_id, generation_id, source, provenance_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(input.projectId, input.harness, input.aliasKind, input.producerId ?? null, input.alias, sessionId, generationId ?? null, input.source, json5(input.provenance), this.#clock.now());
    return {
      disposition: "accepted",
      code: "runtime.session.alias_attached",
      sessionId,
      ...generationId ? { generationId } : {}
    };
  }
  #recordAliasEffect(input, sessionId, generationId) {
    const now2 = this.#clock.now();
    const row = this.#database.prepare("SELECT revision FROM session_projection WHERE project_id = ? AND session_id = ?").get(input.projectId, sessionId);
    if (!row)
      return;
    const revision = row.revision + 1;
    this.#database.prepare("UPDATE session_projection SET revision = ?, updated_at = ? WHERE project_id = ? AND session_id = ?").run(revision, now2, input.projectId, sessionId);
    const identity = [
      input.projectId,
      input.harness,
      input.aliasKind,
      input.producerId ?? "",
      input.alias,
      sessionId,
      generationId ?? ""
    ].join("|");
    const outboxId = sha256(`session.alias:${identity}:${revision}`).slice(0, 32);
    this.#database.prepare("INSERT OR IGNORE INTO runtime_outbox(id, destination, payload_json, status, created_at, attempts) VALUES (?, 'tracker', ?, 'pending', ?, 0)").run(outboxId, json5({
      event_id: `alias:${sha256(identity).slice(0, 24)}`,
      event_kind: "session.alias_attached",
      session_id: sessionId,
      generation_id: generationId,
      revision
    }), now2);
  }
  observe(input) {
    const transaction = this.#database.transaction(() => {
      const row = this.#database.prepare("SELECT * FROM session_projection WHERE project_id = ? AND session_id = ?").get(input.projectId, input.sessionId);
      if (!row)
        return {
          disposition: "rejected",
          code: "runtime.session.session_unresolved"
        };
      const generation2 = input.generationId ? this.#database.prepare("SELECT * FROM generation_projection WHERE project_id = ? AND session_id = ? AND generation_id = ?").get(input.projectId, input.sessionId, input.generationId) : void 0;
      if (input.generationId && !generation2)
        return {
          disposition: "rejected",
          code: "runtime.session.generation_unresolved",
          sessionId: input.sessionId,
          generationId: input.generationId
        };
      if (row.observed_at && input.observedAt <= row.observed_at || generation2?.observed_at && input.observedAt <= generation2.observed_at)
        return {
          disposition: "ignored",
          code: "runtime.session.observation_stale",
          sessionId: input.sessionId,
          ...input.generationId ? { generationId: input.generationId } : {},
          revision: row.revision
        };
      const now2 = this.#clock.now();
      const revision = row.revision + 1;
      const sessionFields = {
        ...objectJson(row.field_provenance_json),
        __observed: {
          sourceTime: input.observedAt,
          tieBreak: `observe:${input.sessionId}`
        }
      };
      this.#database.prepare("UPDATE session_projection SET revision = ?, field_provenance_json = ?, observed_at = ?, updated_at = ? WHERE project_id = ? AND session_id = ?").run(revision, json5(sessionFields), input.observedAt, now2, input.projectId, input.sessionId);
      if (generation2 && input.generationId) {
        const generationFields = {
          ...objectJson(generation2.field_provenance_json),
          __observed: {
            sourceTime: input.observedAt,
            tieBreak: `observe:${input.sessionId}`
          }
        };
        this.#database.prepare("UPDATE generation_projection SET revision = revision + 1, field_provenance_json = ?, observed_at = ?, updated_at = ? WHERE project_id = ? AND session_id = ? AND generation_id = ?").run(json5(generationFields), input.observedAt, now2, input.projectId, input.sessionId, input.generationId);
      }
      const identity = `observe:${input.projectId}:${input.sessionId}:${input.generationId ?? "session"}:${input.observedAt}`;
      const outboxId = sha256(identity).slice(0, 32);
      this.#database.prepare("INSERT OR IGNORE INTO runtime_outbox(id, destination, payload_json, status, created_at, attempts) VALUES (?, 'tracker', ?, 'pending', ?, 0)").run(outboxId, json5({
        event_id: identity,
        event_kind: "session.observed",
        session_id: input.sessionId,
        generation_id: input.generationId,
        revision,
        observed_at: input.observedAt
      }), now2);
      return {
        disposition: "accepted",
        code: "runtime.session.observed",
        sessionId: input.sessionId,
        ...input.generationId ? { generationId: input.generationId } : {},
        revision
      };
    });
    return transaction();
  }
  findAlias(input) {
    const row = this.#database.prepare("SELECT session_id, generation_id FROM session_aliases WHERE project_id = ? AND harness = ? AND alias_kind = ? AND COALESCE(producer_id, '') = COALESCE(?, '') AND alias = ?").get(...aliasKey(input));
    if (!row)
      return void 0;
    return {
      ...row.session_id ? { sessionId: row.session_id } : {},
      ...row.generation_id ? { generationId: row.generation_id } : {}
    };
  }
  resolveLogicalSession(projectId2, reference) {
    const candidates = /* @__PURE__ */ new Set();
    const direct = this.#database.prepare("SELECT session_id FROM logical_sessions WHERE project_id = ? AND session_id = ?").get(projectId2, reference);
    if (direct)
      candidates.add(direct.session_id);
    for (const row of this.#database.prepare("SELECT DISTINCT session_id FROM session_aliases WHERE project_id = ? AND alias = ? AND session_id IS NOT NULL").all(projectId2, reference))
      candidates.add(row.session_id);
    if (candidates.size !== 1)
      return void 0;
    const sessionId = [...candidates][0];
    if (!sessionId)
      return void 0;
    const session2 = this.get(projectId2, sessionId);
    return session2?.activeGenerationId ? Object.freeze({ sessionId, generationId: session2.activeGenerationId }) : void 0;
  }
  get(projectId2, sessionId) {
    const session2 = this.#database.prepare("SELECT * FROM session_projection WHERE project_id = ? AND session_id = ?").get(projectId2, sessionId);
    if (!session2)
      return void 0;
    const rows = this.#database.prepare("SELECT g.*, p.metadata_json, p.field_provenance_json, p.parent_generation_id, p.continuation, p.actor_activity_at, p.observed_at, p.revision FROM session_generations g JOIN generation_projection p ON p.project_id = g.project_id AND p.session_id = g.session_id AND p.generation_id = g.generation_id WHERE g.project_id = ? AND g.session_id = ? ORDER BY g.ordinal").all(projectId2, sessionId);
    const generations = rows.map((row) => ({
      generationId: row.generation_id,
      sessionId: row.session_id,
      projectId: row.project_id,
      ordinal: row.ordinal,
      harness: row.harness,
      state: row.lifecycle_state,
      metadata: objectJson(row.metadata_json),
      fieldProvenance: objectJson(row.field_provenance_json),
      lifecycleProvenance: objectJson(row.lifecycle_provenance_json),
      ...row.parent_generation_id ? {
        parentGenerationId: row.parent_generation_id,
        continuation: "resume"
      } : {},
      ...row.activity_at ? { activityAt: row.activity_at } : {},
      ...row.observed_at ? { observedAt: row.observed_at } : {},
      ...row.ended_at ? { endedAt: row.ended_at } : {},
      revision: row.revision
    }));
    const active2 = generations.find((generation2) => !terminal2(generation2.state));
    return {
      sessionId,
      projectId: projectId2,
      revision: session2.revision,
      metadata: objectJson(session2.metadata_json),
      fieldProvenance: objectJson(session2.field_provenance_json),
      ...session2.role_json ? { role: session2.role_json } : {},
      ...session2.actor_activity_at ? { activityAt: session2.actor_activity_at } : {},
      ...session2.observed_at ? { observedAt: session2.observed_at } : {},
      generationIds: generations.map((generation2) => generation2.generationId),
      ...active2 ? { activeGenerationId: active2.generationId } : {},
      generations
    };
  }
  list(projectId2) {
    return this.#database.prepare("SELECT session_id FROM logical_sessions WHERE project_id = ? ORDER BY session_id").all(projectId2).flatMap((row) => {
      const value2 = this.get(projectId2, row.session_id);
      return value2 ? [value2] : [];
    });
  }
};

// packages/persistence/dist/repositories.js
var cryptoBoundary = crypto13;
var maxOutboxAttempts = 5;
function json6(value2) {
  return JSON.stringify(value2);
}
function boundedLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("runtime outbox claim limit must be an integer from 1 to 100");
  return limit;
}
function retryDelayMs2(attempts) {
  return Math.min(6e4, 1e3 * 2 ** Math.max(0, attempts - 1));
}
function redactOutboxError(value2) {
  return value2.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED]@").replace(/\bBearer\s+[A-Za-z0-9._-]+/giu, "Bearer [REDACTED]").replace(/\b(token|authorization|password|secret)=([^\s&]+)/giu, "$1=[REDACTED]").replace(/\/[A-Za-z0-9._~\-/]{12,}/gu, "[PATH]").slice(0, 512);
}
function terminal3(state) {
  return state === "ended" || state === "errored" || state === "superseded";
}
function objectJson2(value2) {
  if (!value2)
    return {};
  try {
    const parsed = JSON.parse(value2);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function projectId() {
  return `prj_${cryptoBoundary.randomUUID()}`;
}
var RuntimeProjectRepository = class {
  #database;
  #clock;
  constructor(database, clock) {
    this.#database = database;
    this.#clock = clock;
  }
  #view(projectIdValue) {
    const project2 = this.#database.prepare("SELECT project_id, name, created_at FROM projects WHERE project_id = ?").get(projectIdValue);
    if (!project2)
      return void 0;
    const metadata = this.#database.prepare("SELECT name_source, metadata_json FROM project_metadata WHERE project_id = ?").get(projectIdValue);
    const identityKeys = this.#database.prepare("SELECT identity_key FROM project_identity_keys WHERE project_id = ? ORDER BY identity_key").all(projectIdValue).map((row) => row.identity_key);
    const locations = this.#database.prepare("SELECT location_id, project_id, canonical_path, observed_path, relation FROM project_locations WHERE project_id = ? ORDER BY created_at, location_id").all(projectIdValue).map((row) => {
      const state = this.#database.prepare("SELECT status, last_confirmed_at, provenance_json FROM project_location_state WHERE project_id = ? AND location_id = ?").get(row.project_id, row.location_id);
      return Object.freeze({
        locationId: row.location_id,
        canonicalPath: row.canonical_path,
        ...row.observed_path ? { observedPath: row.observed_path } : {},
        relation: row.relation,
        status: state?.status ?? "active",
        ...state?.last_confirmed_at ? { lastConfirmedAt: state.last_confirmed_at } : {},
        provenance: objectJson2(state?.provenance_json)
      });
    });
    return Object.freeze({
      projectId: project2.project_id,
      name: project2.name,
      nameSource: metadata?.name_source ?? "legacy_import",
      metadata: objectJson2(metadata?.metadata_json),
      identityKeys: Object.freeze(identityKeys),
      locations: Object.freeze(locations)
    });
  }
  get(projectIdValue) {
    return this.#view(projectIdValue);
  }
  findByCanonicalPath(canonicalPath) {
    const row = this.#database.prepare("SELECT project_id FROM project_locations WHERE canonical_path = ?").get(canonicalPath);
    return row ? this.#view(row.project_id) : void 0;
  }
  findByIdentityKey(identityKey) {
    const row = this.#database.prepare("SELECT project_id FROM project_identity_keys WHERE identity_key = ?").get(identityKey);
    return row ? this.#view(row.project_id) : void 0;
  }
  #ensureMetadata(projectIdValue, name, source, metadata, provenance3, now2) {
    const existing = this.#database.prepare("SELECT name_source FROM project_metadata WHERE project_id = ?").get(projectIdValue);
    const manual = existing?.name_source === "register";
    if (!existing) {
      this.#database.prepare("INSERT INTO project_metadata(project_id, name_source, metadata_json, provenance_json, updated_at) VALUES (?, ?, ?, ?, ?)").run(projectIdValue, source, json6(metadata), json6(provenance3), now2);
    } else {
      this.#database.prepare("UPDATE project_metadata SET name_source = ?, metadata_json = ?, provenance_json = ?, updated_at = ? WHERE project_id = ?").run(manual ? "register" : source, json6(metadata), json6(provenance3), now2, projectIdValue);
    }
    if (!manual || source === "register")
      this.#database.prepare("UPDATE projects SET name = ? WHERE project_id = ?").run(name, projectIdValue);
  }
  #ensureLocation(projectIdValue, location2, provenance3, now2) {
    const existingPath = this.#database.prepare("SELECT location_id, project_id, canonical_path, observed_path, relation FROM project_locations WHERE canonical_path = ?").get(location2.canonicalPath);
    if (existingPath && existingPath.project_id !== projectIdValue)
      throw new Error("runtime.project.identity_conflict");
    const existingLocation = this.#database.prepare("SELECT location_id, project_id, canonical_path, observed_path, relation FROM project_locations WHERE project_id = ? AND location_id = ?").get(projectIdValue, location2.locationId);
    if (existingLocation && existingLocation.canonical_path !== location2.canonicalPath)
      throw new Error("runtime.project.location_conflict");
    const resolvedLocation = existingLocation ?? existingPath;
    if (!resolvedLocation) {
      this.#database.prepare("INSERT INTO project_locations(location_id, project_id, canonical_path, observed_path, relation, source_observed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(location2.locationId, projectIdValue, location2.canonicalPath, location2.observedPath ?? null, location2.relation, location2.observedAt, now2);
    }
    const resolvedLocationId = resolvedLocation?.location_id ?? location2.locationId;
    this.#database.prepare("INSERT INTO project_location_state(project_id, location_id, status, last_confirmed_at, provenance_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, location_id) DO UPDATE SET status = excluded.status, last_confirmed_at = excluded.last_confirmed_at, provenance_json = excluded.provenance_json").run(projectIdValue, resolvedLocationId, location2.status ?? "active", now2, json6(provenance3));
    this.#database.prepare("INSERT OR IGNORE INTO location_aliases(project_id, location_id, alias_path, alias_kind, observed_at, provenance_json) VALUES (?, ?, ?, 'path', ?, ?)").run(projectIdValue, resolvedLocationId, location2.canonicalPath, now2, json6(provenance3));
    if (location2.observedPath)
      this.#database.prepare("INSERT OR IGNORE INTO location_aliases(project_id, location_id, alias_path, alias_kind, observed_at, provenance_json) VALUES (?, ?, ?, 'path', ?, ?)").run(projectIdValue, resolvedLocationId, location2.observedPath, now2, json6(provenance3));
    return resolvedLocationId;
  }
  #identityKey(projectIdValue, identityKey, source, provenance3, now2) {
    if (!identityKey)
      return;
    const existing = this.#database.prepare("SELECT project_id FROM project_identity_keys WHERE identity_key = ?").get(identityKey);
    if (existing && existing.project_id !== projectIdValue)
      throw new Error("runtime.project.identity_conflict");
    this.#database.prepare("INSERT INTO project_identity_keys(project_id, identity_key, source, provenance_json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, identity_key) DO UPDATE SET source = excluded.source, provenance_json = excluded.provenance_json, updated_at = excluded.updated_at").run(projectIdValue, identityKey, source, json6(provenance3), now2);
  }
  #worktreeAlias(projectIdValue, locationId, identityKey, provenance3, now2) {
    if (!identityKey?.startsWith("git-common:", 0))
      return;
    this.#database.prepare("INSERT OR IGNORE INTO location_aliases(project_id, location_id, alias_path, alias_kind, observed_at, provenance_json) VALUES (?, ?, ?, 'worktree', ?, ?)").run(projectIdValue, locationId, identityKey, now2, json6(provenance3));
  }
  #writeOutbox(projectIdValue, event, payload2, now2) {
    const outboxId = sha256(`project:${projectIdValue}:${event}:${JSON.stringify(payload2)}`).slice(0, 32);
    this.#database.prepare("INSERT OR IGNORE INTO runtime_outbox(id, destination, payload_json, status, created_at, attempts) VALUES (?, 'management', ?, 'pending', ?, 0)").run(outboxId, json6(payload2), now2);
    return outboxId;
  }
  #writeProjectEvent(projectIdValue, event, payload2, provenance3, now2) {
    const identity = `${projectIdValue}:${event}:${JSON.stringify(payload2)}`;
    const eventId = `evt_${sha256(identity).slice(0, 32)}`;
    this.#database.prepare("INSERT OR IGNORE INTO runtime_events(event_id, deduplication_key, event_kind, payload_json, provenance_json, source_observed_at, received_at, materialized_at, activity_at, metadata_version, disposition) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'golem.runtime-signal/v1', 'accepted')").run(eventId, `project:${identity}`, event, json6(payload2), json6(provenance3), now2, now2, now2, now2);
    return eventId;
  }
  observe(input) {
    return this.#database.transaction(() => {
      const now2 = this.#clock.now();
      const existingEvent = this.#database.prepare("SELECT event_id FROM runtime_events WHERE event_id = ? OR deduplication_key = ?").get(input.eventId, input.deduplicationKey);
      if (existingEvent) {
        const existing = this.#database.prepare("SELECT project_id, location_id FROM project_locations WHERE canonical_path = ?").get(input.location.canonicalPath);
        return Object.freeze({
          disposition: "duplicate",
          projectId: existing?.project_id ?? input.projectId ?? "",
          locationId: existing?.location_id ?? input.location.locationId
        });
      }
      const byIdentity = input.identityKey ? this.findByIdentityKey(input.identityKey) : void 0;
      const byPath = this.findByCanonicalPath(input.location.canonicalPath);
      if (byIdentity && byPath && byIdentity.projectId !== byPath.projectId)
        throw new Error("runtime.project.identity_conflict");
      const resolvedProjectId = input.projectId ?? byIdentity?.projectId ?? byPath?.projectId ?? projectId();
      if (input.projectId && byPath && byPath.projectId !== input.projectId)
        throw new Error("runtime.project.identity_conflict");
      this.#database.prepare("INSERT OR IGNORE INTO projects(project_id, name, created_at) VALUES (?, ?, ?)").run(resolvedProjectId, input.name, now2);
      this.#ensureMetadata(resolvedProjectId, input.name, input.source, input.metadata ?? {}, input.provenance, now2);
      const locationId = this.#ensureLocation(resolvedProjectId, input.location, input.provenance, now2);
      this.#worktreeAlias(resolvedProjectId, locationId, input.identityKey, input.provenance, now2);
      this.#identityKey(resolvedProjectId, input.identityKey, input.source, input.provenance, now2);
      this.#database.prepare("INSERT INTO runtime_events(event_id, deduplication_key, event_kind, payload_json, provenance_json, source_observed_at, received_at, materialized_at, activity_at, metadata_version, disposition) VALUES (?, ?, 'project.observed', ?, ?, ?, ?, ?, ?, 'golem.runtime-signal/v1', 'accepted')").run(input.eventId, input.deduplicationKey, json6(input.payload), json6(input.provenance), input.occurredAt, now2, now2, input.occurredAt);
      const outboxId = this.#writeOutbox(resolvedProjectId, "project.observed", {
        event_id: input.eventId,
        project_id: resolvedProjectId,
        location_id: locationId
      }, now2);
      return Object.freeze({
        disposition: "accepted",
        projectId: resolvedProjectId,
        locationId,
        outboxId
      });
    })();
  }
  attachLocation(input) {
    return this.#database.transaction(() => {
      const now2 = this.#clock.now();
      if (!this.#view(input.projectId))
        throw new Error("runtime.project.not_found");
      const provenance3 = {
        source: input.source,
        evidence: input.location.evidence
      };
      this.#ensureMetadata(input.projectId, input.name ?? this.#view(input.projectId)?.name ?? input.projectId, input.source, input.metadata ?? {}, provenance3, now2);
      const locationId = this.#ensureLocation(input.projectId, input.location, provenance3, now2);
      this.#worktreeAlias(input.projectId, locationId, input.identityKey, provenance3, now2);
      this.#identityKey(input.projectId, input.identityKey, input.source, provenance3, now2);
      const eventId = this.#writeProjectEvent(input.projectId, "project.location.attached", { project_id: input.projectId, location_id: locationId }, provenance3, now2);
      this.#writeOutbox(input.projectId, "project.location.attached", {
        event_id: eventId,
        project_id: input.projectId,
        location_id: locationId
      }, now2);
      return this.#view(input.projectId);
    })();
  }
  retireLocation(projectIdValue, locationId, reason) {
    return this.#database.transaction(() => {
      const now2 = this.#clock.now();
      if (!this.#view(projectIdValue))
        throw new Error("runtime.project.not_found");
      const changed = this.#database.prepare("UPDATE project_location_state SET status = 'retired', provenance_json = ? WHERE project_id = ? AND location_id = ?").run(json6({ source: "register", reason }), projectIdValue, locationId).changes;
      if (changed !== 1)
        throw new Error("runtime.project.location_not_found");
      const eventId = this.#writeProjectEvent(projectIdValue, "project.location.retired", { project_id: projectIdValue, location_id: locationId, reason }, { source: "register", reason }, now2);
      this.#writeOutbox(projectIdValue, "project.location.retired", {
        event_id: eventId,
        project_id: projectIdValue,
        location_id: locationId,
        reason
      }, now2);
      return this.#view(projectIdValue);
    })();
  }
  rename(projectIdValue, name, source = "register") {
    return this.#database.transaction(() => {
      const current = this.#view(projectIdValue);
      if (!current)
        throw new Error("runtime.project.not_found");
      const now2 = this.#clock.now();
      this.#ensureMetadata(projectIdValue, name, source, current.metadata, { source }, now2);
      const eventId = this.#writeProjectEvent(projectIdValue, "project.renamed", { project_id: projectIdValue, name }, { source }, now2);
      this.#writeOutbox(projectIdValue, "project.renamed", { event_id: eventId, project_id: projectIdValue, name }, now2);
      return this.#view(projectIdValue);
    })();
  }
};
var RuntimeRepository = class {
  #database;
  #clock;
  constructor(database, clock) {
    this.#database = database;
    this.#clock = clock;
  }
  runtimeProjectStorage() {
    return new RuntimeProjectRepository(this.#database, this.#clock);
  }
  runtimeSessionStorage() {
    return new RuntimeSessionRepository(this.#database, this.#clock);
  }
  runtimeEndpointStorage() {
    return new RuntimeEndpointRepository(this.#database, this.#clock);
  }
  record(input) {
    const transaction = this.#database.transaction(() => {
      const receivedAt = this.#clock.now();
      const materializedAt = this.#clock.now();
      const inserted = this.#database.prepare("INSERT OR IGNORE INTO runtime_events(event_id, deduplication_key, event_kind, payload_json, provenance_json, source_observed_at, received_at, materialized_at, activity_at, metadata_version, disposition) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'golem.event/v1', 'accepted')").run(input.eventId, input.deduplicationKey, input.eventKind, json6(input.payload), json6(input.provenance), input.occurredAt, receivedAt, materializedAt, input.occurredAt);
      if (inserted.changes === 0)
        return { disposition: "duplicate" };
      if (input.mutation.project) {
        const project2 = input.mutation.project;
        this.#database.prepare("INSERT OR IGNORE INTO projects(project_id, name, created_at) VALUES (?, ?, ?)").run(project2.projectId, project2.name, materializedAt);
        this.#database.prepare("INSERT OR IGNORE INTO project_locations(location_id, project_id, canonical_path, observed_path, relation, source_observed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(project2.locationId, project2.projectId, project2.canonicalPath, project2.observedPath ?? null, project2.relation, input.occurredAt, materializedAt);
      }
      if (input.mutation.generation) {
        const generation2 = input.mutation.generation;
        this.#database.prepare("INSERT OR IGNORE INTO logical_sessions(session_id, project_id, provenance_json, created_at) VALUES (?, ?, ?, ?)").run(generation2.sessionId, generation2.projectId, json6(input.provenance), materializedAt);
        this.#database.prepare("INSERT OR IGNORE INTO session_generations(generation_id, session_id, project_id, ordinal, harness, lifecycle_state, lifecycle_schema_version, lifecycle_provenance_json, field_schema_version, field_provenance_json, source_observed_at, received_at, activity_at, materialized_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(generation2.generationId, generation2.sessionId, generation2.projectId, generation2.ordinal, generation2.harness, generation2.state, generation2.lifecycleProvenance.schemaVersion, json6(generation2.lifecycleProvenance.details), generation2.fieldProvenance.schemaVersion, json6(generation2.fieldProvenance.details), input.occurredAt, receivedAt, input.occurredAt, materializedAt, terminal3(generation2.state) ? materializedAt : null);
      }
      const outboxId = sha256(`${input.eventId}:${input.outbox.destination}`).slice(0, 32);
      this.#database.prepare("INSERT INTO runtime_outbox(id, destination, payload_json, status, created_at, attempts) VALUES (?, ?, ?, 'pending', ?, 0)").run(outboxId, input.outbox.destination, json6(input.outbox.payload), materializedAt);
      if (input.failpoint === "before_commit")
        throw new RuntimeFailpointError("before_commit");
      return { disposition: "accepted", outboxId };
    });
    const result2 = transaction();
    if (result2.disposition === "accepted" && input.failpoint === "after_commit")
      throw new RuntimeFailpointError("after_commit");
    return result2;
  }
  /**
   * The materializer's atomic boundary: source event, producer watermark,
   * canonical mutation, explanation, and optional cross-store outbox record.
   * A lower-or-equal producer sequence is retained as an auditable stale event
   * but cannot mutate canonical rows or enqueue delivery.
   */
  materialize(input) {
    return this.#database.transaction(() => {
      const receivedAt = this.#clock.now();
      const materializedAt = this.#clock.now();
      const currentWatermark = this.#database.prepare("SELECT watermark FROM producer_watermarks WHERE producer_id = ?").get(input.producer.id);
      const priorSequence = currentWatermark ? Number(/^([0-9]+):/u.exec(currentWatermark.watermark)?.[1]) : void 0;
      const stale = input.producer.sequence !== void 0 && priorSequence !== void 0 && Number.isSafeInteger(priorSequence) && input.producer.sequence <= priorSequence;
      const disposition = stale ? "stale" : input.disposition;
      const inserted = this.#database.prepare("INSERT OR IGNORE INTO runtime_events(event_id, deduplication_key, event_kind, payload_json, provenance_json, source_observed_at, received_at, materialized_at, activity_at, metadata_version, disposition) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'golem.runtime-signal/v1', ?)").run(input.eventId, input.deduplicationKey, input.eventKind, json6(input.payload), json6(input.provenance), input.occurredAt, receivedAt, materializedAt, disposition === "accepted" ? input.occurredAt : null, disposition);
      if (inserted.changes === 0)
        return Object.freeze({ disposition: "duplicate" });
      this.#database.prepare("INSERT OR REPLACE INTO diagnostics(id, code, details_json, created_at) VALUES (?, ?, ?, ?)").run(sha256(`${input.eventId}:${input.explanation.code}`).slice(0, 32), input.explanation.code, json6({
        event_id: input.eventId,
        disposition,
        ...input.explanation.details
      }), materializedAt);
      if (disposition !== "accepted")
        return Object.freeze({
          disposition,
          materializedAt
        });
      if (input.producer.sequence !== void 0) {
        const watermark = `${input.producer.sequence}:${input.eventId}`;
        this.#database.prepare("INSERT INTO producer_watermarks(producer_id, watermark, source_observed_at, received_at, materialized_at, provenance_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(producer_id) DO UPDATE SET watermark = excluded.watermark, source_observed_at = excluded.source_observed_at, received_at = excluded.received_at, materialized_at = excluded.materialized_at, provenance_json = excluded.provenance_json").run(input.producer.id, watermark, input.occurredAt, receivedAt, materializedAt, json6(input.provenance));
      }
      if (input.mutation?.project) {
        const project2 = input.mutation.project;
        this.#database.prepare("INSERT OR IGNORE INTO projects(project_id, name, created_at) VALUES (?, ?, ?)").run(project2.projectId, project2.name, materializedAt);
        this.#database.prepare("INSERT OR IGNORE INTO project_locations(location_id, project_id, canonical_path, observed_path, relation, source_observed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(project2.locationId, project2.projectId, project2.canonicalPath, project2.observedPath ?? null, project2.relation, input.occurredAt, materializedAt);
      }
      let outboxId;
      if (input.outbox) {
        outboxId = sha256(`${input.eventId}:${input.outbox.destination}`).slice(0, 32);
        this.#database.prepare("INSERT INTO runtime_outbox(id, destination, payload_json, status, created_at, attempts) VALUES (?, ?, ?, 'pending', ?, 0)").run(outboxId, input.outbox.destination, json6(input.outbox.payload), materializedAt);
      }
      return Object.freeze({
        disposition: "accepted",
        ...outboxId ? { outboxId } : {},
        materializedAt
      });
    })();
  }
  #failClaim(id2, claimToken, error2) {
    const row = this.#database.prepare("SELECT attempts FROM runtime_outbox WHERE id = ? AND status = 'claimed' AND claim_token = ?").get(id2, claimToken);
    if (!row)
      return void 0;
    const permanent = row.attempts >= maxOutboxAttempts;
    const at = this.#clock.now();
    const nextAttemptAt = permanent ? void 0 : this.#clock.after(retryDelayMs2(row.attempts));
    this.#database.prepare("UPDATE runtime_outbox SET status = ?, claim_owner = NULL, claim_token = NULL, claim_until = NULL, retry_started_at = ?, next_attempt_at = ?, last_error = ?, permanent_failure_at = ? WHERE id = ? AND status = 'claimed' AND claim_token = ?").run(permanent ? "permanent_failure" : "pending", permanent ? null : at, nextAttemptAt ?? null, redactOutboxError(error2), permanent ? at : null, id2, claimToken);
    return Object.freeze({
      status: permanent ? "permanent_failure" : "pending",
      attempts: row.attempts,
      ...nextAttemptAt ? { nextAttemptAt } : {},
      ...permanent ? { permanentFailureAt: at } : {}
    });
  }
  #replayExpiredClaims() {
    const now2 = this.#clock.now();
    const expired = this.#database.prepare("SELECT id, claim_token FROM runtime_outbox WHERE status = 'claimed' AND claim_until < ? ORDER BY claim_until, id").all(now2);
    let replayed = 0;
    for (const row of expired)
      if (this.#failClaim(row.id, row.claim_token, "claim lease expired"))
        replayed += 1;
    return replayed;
  }
  claim(workerId, limit, leaseMs = 3e4) {
    if (!workerId.trim() || !Number.isInteger(leaseMs) || leaseMs < 1)
      throw new Error("runtime outbox claim requires a worker id and positive lease");
    const maximum = boundedLimit(limit);
    return this.#database.transaction(() => {
      this.#replayExpiredClaims();
      const now2 = this.#clock.now();
      const rows = this.#database.prepare("SELECT id, destination, payload_json, attempts FROM runtime_outbox WHERE status = 'pending' AND attempts < ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at, id LIMIT ?").all(maxOutboxAttempts, now2, maximum);
      const claimUntil = this.#clock.after(leaseMs);
      return rows.map((row) => {
        const claimToken = cryptoBoundary.randomUUID();
        const changed = this.#database.prepare("UPDATE runtime_outbox SET status = 'claimed', claim_owner = ?, claim_token = ?, claim_until = ?, next_attempt_at = NULL, attempts = attempts + 1 WHERE id = ? AND status = 'pending' AND attempts < ?").run(workerId, claimToken, claimUntil, row.id, maxOutboxAttempts).changes;
        if (changed !== 1)
          throw new Error("runtime outbox claim lost its transaction lease");
        return Object.freeze({
          id: row.id,
          destination: row.destination,
          payload: JSON.parse(row.payload_json),
          claimToken,
          attempts: row.attempts + 1
        });
      });
    })();
  }
  replay() {
    return this.#database.transaction(() => this.#replayExpiredClaims())();
  }
  ack(id2, claimToken) {
    return this.#database.prepare("UPDATE runtime_outbox SET status = 'published', published_at = ?, claim_owner = NULL, claim_token = NULL, claim_until = NULL, next_attempt_at = NULL WHERE id = ? AND status = 'claimed' AND claim_token = ?").run(this.#clock.now(), id2, claimToken).changes === 1;
  }
  fail(id2, claimToken, error2) {
    if (!error2.trim())
      throw new Error("runtime outbox failure requires an error");
    return this.#database.transaction(() => this.#failClaim(id2, claimToken, error2))();
  }
  health() {
    const now2 = this.#clock.now();
    const row = this.#database.prepare("SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END) AS claimed, SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published, SUM(CASE WHEN status = 'permanent_failure' THEN 1 ELSE 0 END) AS permanent_failures, MIN(CASE WHEN status = 'pending' AND retry_started_at IS NOT NULL THEN retry_started_at END) AS oldest_retry_at, MAX(published_at) AS last_success_at FROM runtime_outbox").get();
    const oldestRetryAt = row?.oldest_retry_at ?? void 0;
    return Object.freeze({
      pending: Number(row?.pending ?? 0),
      claimed: Number(row?.claimed ?? 0),
      published: Number(row?.published ?? 0),
      permanentFailures: Number(row?.permanent_failures ?? 0),
      ...oldestRetryAt ? {
        oldestRetryAgeMs: Math.max(0, Date.parse(now2) - Date.parse(oldestRetryAt))
      } : {},
      ...row?.last_success_at ? { lastSuccessAt: row.last_success_at } : {}
    });
  }
};

// packages/persistence/dist/runtime-projection-repository.js
function objectJson3(value2) {
  if (!value2)
    return {};
  try {
    const parsed = JSON.parse(value2);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function safeRows(rows, limit = 2e3) {
  return rows.length <= limit ? rows : rows.slice(0, limit);
}
var RuntimeProjectionRepository = class {
  #database;
  #projects;
  #sessions;
  #endpoints;
  constructor(database, projects, sessions, endpoints) {
    this.#database = database;
    this.#projects = projects;
    this.#sessions = sessions;
    this.#endpoints = endpoints;
  }
  projects() {
    const rows = this.#database.prepare("SELECT project_id FROM projects ORDER BY project_id LIMIT 2000").all();
    return rows.flatMap((row) => {
      const project2 = this.#projects.get(row.project_id);
      return project2 ? [project2] : [];
    });
  }
  sessions(projectId2) {
    if (projectId2)
      return this.#sessions.list(projectId2);
    return this.projects().flatMap((project2) => this.#sessions.list(project2.projectId));
  }
  endpoints(generationId) {
    if (generationId)
      return this.#endpoints.list(generationId);
    return this.sessions().flatMap((session2) => session2.generations.flatMap((generation2) => this.#endpoints.list(generation2.generationId)));
  }
  events() {
    const rows = this.#database.prepare("SELECT event_id, event_kind, payload_json, provenance_json, source_observed_at, received_at, materialized_at, disposition FROM runtime_events ORDER BY received_at, event_id LIMIT 2000").all();
    return safeRows(rows.map((row) => Object.freeze({
      eventId: row.event_id,
      eventKind: row.event_kind,
      payload: objectJson3(row.payload_json),
      provenance: objectJson3(row.provenance_json),
      sourceObservedAt: row.source_observed_at,
      receivedAt: row.received_at,
      materializedAt: row.materialized_at,
      disposition: row.disposition
    })));
  }
  diagnostics() {
    const rows = this.#database.prepare("SELECT id, code, details_json, created_at FROM diagnostics ORDER BY created_at, id LIMIT 2000").all();
    return safeRows(rows.map((row) => Object.freeze({
      id: row.id,
      code: row.code,
      details: objectJson3(row.details_json),
      createdAt: row.created_at
    })));
  }
  watermarks() {
    const rows = this.#database.prepare("SELECT producer_id, watermark, source_observed_at, received_at, materialized_at FROM producer_watermarks ORDER BY producer_id LIMIT 2000").all();
    return rows.map((row) => Object.freeze({
      producerId: row.producer_id,
      watermark: row.watermark,
      sourceObservedAt: row.source_observed_at,
      receivedAt: row.received_at,
      materializedAt: row.materialized_at
    }));
  }
  revision() {
    const row = this.#database.prepare("SELECT (SELECT COUNT(*) FROM runtime_events) AS events, (SELECT COUNT(*) FROM diagnostics) AS diagnostics, COALESCE((SELECT MAX(revision) FROM session_projection), 0) AS sessions, COALESCE((SELECT MAX(revision) FROM generation_projection), 0) AS generations, COALESCE((SELECT MAX(revision) FROM endpoint_claims), 0) AS endpoints").get();
    return row ? Math.max(row.events, row.diagnostics, row.sessions, row.generations, row.endpoints) : 0;
  }
};

// packages/persistence/dist/tracker-repository.js
import crypto14 from "node:crypto";
function parseObject(value2) {
  try {
    const parsed = JSON.parse(value2);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function parseClasses(value2) {
  try {
    const parsed = JSON.parse(value2);
    if (!Array.isArray(parsed))
      return ["tracker", "lifecycle", "custom"];
    const classes = parsed.filter((item) => item === "tracker" || item === "lifecycle" || item === "custom");
    return classes.length > 0 ? Object.freeze(classes) : ["tracker", "lifecycle", "custom"];
  } catch {
    return ["tracker", "lifecycle", "custom"];
  }
}
function endpoint2(value2) {
  const candidate = parseObject(value2);
  const capabilities = Array.isArray(candidate.capabilities) ? candidate.capabilities.filter((item) => Boolean(item) && typeof item === "object" && typeof item.capability === "string" && typeof item.qualification === "string" && typeof item.observedAt === "string") : [];
  return Object.freeze({
    recipientId: String(candidate.recipientId ?? ""),
    generationId: String(candidate.generationId ?? ""),
    endpointId: String(candidate.endpointId ?? ""),
    ownerFence: Number(candidate.ownerFence ?? 0),
    readiness: candidate.readiness ?? "uninitialized",
    mode: candidate.mode ?? "pull",
    capabilities: Object.freeze(capabilities.map((item) => ({ ...item })))
  });
}
function hydrateEnvelope(row) {
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    rootId: row.root_id,
    ...row.parent_id ? { parentId: row.parent_id } : {},
    idempotencyKey: row.idempotency_key,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    ...row.reply_to_recipient_id ? { replyToRecipientId: row.reply_to_recipient_id } : {},
    kind: row.kind,
    payload: parseObject(row.payload_json),
    endpoint: endpoint2(row.endpoint_json),
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    ...row.deadline_at ? { deadlineAt: row.deadline_at } : {},
    ...row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {},
    createdAt: row.created_at
  });
}
function hydrateClaim(row) {
  if (!row.claim_owner || !row.claim_token || !row.claim_until)
    throw new Error("claimed tracker envelope is missing its lease facts");
  return Object.freeze({
    ...hydrateEnvelope(row),
    status: "claimed",
    claimOwner: row.claim_owner,
    claimToken: row.claim_token,
    claimUntil: row.claim_until
  });
}
function hydrateEvent(row) {
  return Object.freeze({
    sequence: Number(row.sequence),
    projectId: row.project_id,
    id: row.id,
    deduplicationKey: row.deduplication_key,
    topic: row.topic,
    class: row.class,
    payload: parseObject(row.payload_json),
    createdAt: row.created_at
  });
}
function hydrateSubscription(row) {
  return Object.freeze({
    id: row.id,
    name: row.name,
    recipientId: row.recipient_id,
    topic: row.topic,
    classes: parseClasses(row.classes_json),
    cursor: Number(row.cursor_sequence),
    manual: row.manual === 1,
    status: row.status,
    createdAt: row.created_at
  });
}
function passiveEntry(row) {
  return Object.freeze({
    recipientId: row.recipient_id,
    ticketId: row.ticket_id,
    category: row.category,
    baseline: parseObject(row.baseline_json),
    value: parseObject(row.value_json),
    eventId: row.event_id
  });
}
function json7(value2) {
  return JSON.stringify(value2);
}
function redactDiagnostic3(value2) {
  return value2.replace(/\bBearer\s+[A-Za-z0-9._-]+/giu, "Bearer [REDACTED]").replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY))=\S+/gu, "$1=[REDACTED]").replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED]@").slice(0, 1024);
}
var TrackerRepository = class {
  #database;
  constructor(database) {
    this.#database = database;
  }
  listDispatchOperations(projectId2) {
    return Object.freeze(this.#database.prepare(`SELECT
						receipt.command_id,
						receipt.project_id,
						receipt.resource_id AS ticket_id,
						receipt.result_json,
						envelope.status AS envelope_status,
						receipt.committed_at
					FROM command_receipts AS receipt
					INNER JOIN tickets AS ticket
						ON ticket.id = receipt.resource_id
						AND ticket.project_id = receipt.project_id
					LEFT JOIN tracker_envelopes AS envelope
						ON envelope.project_id = receipt.project_id
						AND envelope.idempotency_key = receipt.idempotency_key
						AND envelope.kind = 'ticket_dispatch'
					WHERE receipt.project_id = ?
						AND receipt.command_kind = 'dispatch'
						AND receipt.resource_type = 'ticket'
						AND receipt.outcome_status = 'completed'
					ORDER BY receipt.committed_at DESC, receipt.command_id DESC`).all(projectId2).map((row) => Object.freeze({
      commandId: row.command_id,
      projectId: row.project_id,
      ticketId: row.ticket_id,
      result: parseObject(row.result_json),
      ...row.envelope_status ? { envelopeStatus: row.envelope_status } : {},
      committedAt: row.committed_at
    })));
  }
  #audit(kind, subjectId, details, now2) {
    this.#database.prepare("INSERT INTO tracker_delivery_audit(id, kind, subject_id, details_json, created_at) VALUES (?, ?, ?, ?, ?)").run(crypto14.randomUUID(), kind, subjectId, json7(details), now2);
  }
  #create(envelope, fingerprint3) {
    const existingId = this.#database.prepare("SELECT * FROM tracker_envelopes WHERE id = ?").get(envelope.id);
    if (existingId)
      return existingId.fingerprint === fingerprint3 ? { kind: "duplicate", envelope: hydrateEnvelope(existingId) } : { kind: "conflict", reason: "id" };
    const existingKey = this.#database.prepare("SELECT * FROM tracker_envelopes WHERE idempotency_key = ?").get(envelope.idempotencyKey);
    if (existingKey)
      return existingKey.fingerprint === fingerprint3 ? { kind: "duplicate", envelope: hydrateEnvelope(existingKey) } : { kind: "conflict", reason: "idempotency_key" };
    this.#database.prepare("INSERT INTO tracker_envelopes(id, project_id, root_id, parent_id, idempotency_key, fingerprint, sender_id, recipient_id, reply_to_recipient_id, kind, payload_json, endpoint_json, status, attempts, max_attempts, deadline_at, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(envelope.id, envelope.projectId, envelope.rootId, envelope.parentId ?? null, envelope.idempotencyKey, fingerprint3, envelope.senderId, envelope.recipientId, envelope.replyToRecipientId ?? null, envelope.kind, json7(envelope.payload), json7(envelope.endpoint), envelope.status, envelope.attempts, envelope.maxAttempts, envelope.deadlineAt ?? null, envelope.nextAttemptAt ?? null, envelope.createdAt);
    return { kind: "created", envelope };
  }
  createEnvelope(input) {
    return this.#database.transaction(() => {
      const result2 = this.#create(input.envelope, input.fingerprint);
      if (result2.kind === "created")
        this.#audit("envelope.created", input.envelope.id, { recipient_id: input.envelope.recipientId }, input.envelope.createdAt);
      return result2;
    })();
  }
  #recover(now2) {
    const expired = this.#database.prepare("SELECT * FROM tracker_envelopes WHERE status IN ('pending', 'claimed', 'retrying') AND deadline_at IS NOT NULL AND deadline_at <= ? ORDER BY created_at, id").all(now2);
    const leased = this.#database.prepare("SELECT * FROM tracker_envelopes WHERE status = 'claimed' AND claim_until <= ? ORDER BY claim_until, id").all(now2);
    const settled = [];
    for (const row of expired) {
      this.#database.prepare("UPDATE tracker_envelopes SET status = 'expired', claim_owner = NULL, claim_token = NULL, claim_until = NULL, next_attempt_at = NULL, last_error = 'delivery deadline elapsed' WHERE id = ? AND status IN ('pending', 'claimed', 'retrying')").run(row.id);
      const updated = this.#database.prepare("SELECT * FROM tracker_envelopes WHERE id = ?").get(row.id);
      if (updated) {
        settled.push(hydrateEnvelope(updated));
        this.#audit("envelope.expired", row.id, {}, now2);
      }
    }
    for (const row of leased) {
      if (row.deadline_at && row.deadline_at <= now2)
        continue;
      const exhausted = Number(row.attempts) >= Number(row.max_attempts);
      const changed = this.#database.prepare("UPDATE tracker_envelopes SET status = ?, claim_owner = NULL, claim_token = NULL, claim_until = NULL, next_attempt_at = ?, last_error = ? WHERE id = ? AND status = 'claimed' AND claim_token = ?").run(exhausted ? "dead_letter" : "retrying", exhausted ? null : now2, exhausted ? "claim lease expired after final attempt" : "claim lease expired", row.id, row.claim_token).changes;
      if (changed !== 1)
        continue;
      const updated = this.#database.prepare("SELECT * FROM tracker_envelopes WHERE id = ?").get(row.id);
      if (updated) {
        settled.push(hydrateEnvelope(updated));
        this.#audit(exhausted ? "envelope.dead_letter" : "envelope.lease_replayed", row.id, {}, now2);
      }
    }
    return Object.freeze(settled);
  }
  claimEnvelopes(input) {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#recover(input.now);
      const candidates = this.#database.prepare("SELECT * FROM tracker_envelopes WHERE status IN ('pending', 'retrying') AND (next_attempt_at IS NULL OR next_attempt_at <= ?) AND (deadline_at IS NULL OR deadline_at > ?) AND attempts < max_attempts ORDER BY created_at, id LIMIT ?").all(input.now, input.now, input.limit);
      const claims = [];
      for (const candidate of candidates) {
        const token2 = crypto14.randomUUID();
        const changed = this.#database.prepare("UPDATE tracker_envelopes SET status = 'claimed', attempts = attempts + 1, claim_owner = ?, claim_token = ?, claim_until = ?, next_attempt_at = NULL WHERE id = ? AND status IN ('pending', 'retrying') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)").run(input.workerId, token2, input.claimUntil, candidate.id, input.now).changes;
        if (changed !== 1)
          continue;
        const row = this.#database.prepare("SELECT * FROM tracker_envelopes WHERE id = ?").get(candidate.id);
        if (!row)
          throw new Error("claimed tracker envelope disappeared");
        claims.push(hydrateClaim(row));
        this.#audit("envelope.claimed", candidate.id, { worker_id: input.workerId }, input.now);
      }
      this.#database.exec("COMMIT");
      return Object.freeze(claims);
    } catch (error2) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
      }
      throw error2;
    }
  }
  settleEnvelope(input) {
    return this.#database.transaction(() => {
      const changed = this.#database.prepare("UPDATE tracker_envelopes SET status = ?, claim_owner = CASE WHEN ? = 'delivered' THEN claim_owner ELSE NULL END, claim_token = CASE WHEN ? = 'delivered' THEN claim_token ELSE NULL END, claim_until = CASE WHEN ? = 'delivered' THEN claim_until ELSE NULL END, next_attempt_at = ?, delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END, last_error = ? WHERE id = ? AND status = 'claimed' AND claim_token = ?").run(input.status, input.status, input.status, input.status, input.nextAttemptAt ?? null, input.status, input.now, input.error ? redactDiagnostic3(input.error) : null, input.id, input.claimToken).changes;
      if (changed !== 1)
        return void 0;
      const row = this.#database.prepare("SELECT * FROM tracker_envelopes WHERE id = ?").get(input.id);
      if (!row)
        return void 0;
      this.#audit(`envelope.${input.status}`, input.id, { error: input.error ? redactDiagnostic3(input.error) : null }, input.now);
      return hydrateEnvelope(row);
    })();
  }
  acknowledgeEnvelope(input) {
    return this.#database.transaction(() => {
      const row = this.#database.prepare("SELECT * FROM tracker_envelopes WHERE id = ?").get(input.id);
      if (!row || row.recipient_id !== input.recipientId)
        return false;
      const existing = this.#database.prepare("SELECT payload_json FROM tracker_envelope_acknowledgements WHERE envelope_id = ? AND acknowledgement_id = ?").get(input.id, input.acknowledgementId);
      if (row.status === "acknowledged")
        return Boolean(existing && existing.payload_json === json7(input.payload));
      if (!["claimed", "delivered"].includes(row.status) || row.claim_token !== input.claimToken)
        return false;
      const inserted = this.#database.prepare("INSERT OR IGNORE INTO tracker_envelope_acknowledgements(envelope_id, acknowledgement_id, recipient_id, payload_json, acknowledged_at) VALUES (?, ?, ?, ?, ?)").run(input.id, input.acknowledgementId, input.recipientId, json7(input.payload), input.now).changes;
      if (inserted === 0)
        return existing?.payload_json === json7(input.payload);
      const settled = this.#database.prepare("UPDATE tracker_envelopes SET status = 'acknowledged', acknowledged_at = COALESCE(acknowledged_at, ?), claim_owner = NULL, claim_token = NULL, claim_until = NULL WHERE id = ? AND recipient_id = ? AND status IN ('claimed', 'delivered') AND claim_token = ?").run(input.now, input.id, input.recipientId, input.claimToken).changes;
      if (settled !== 1)
        return false;
      this.#audit("envelope.acknowledged", input.id, { recipient_id: input.recipientId }, input.now);
      return true;
    })();
  }
  createReplyEnvelope(input) {
    return this.#database.transaction(() => {
      const parent = this.#database.prepare("SELECT * FROM tracker_envelopes WHERE id = ?").get(input.parentId);
      if (!parent)
        return { kind: "conflict", reason: "id" };
      if (parent.reply_to_recipient_id !== input.envelope.recipientId || parent.recipient_id !== input.envelope.senderId || !["claimed", "delivered"].includes(parent.status) || parent.claim_token !== input.claimToken)
        throw new Error("reply envelope does not match its durable reply route");
      const result2 = this.#create(input.envelope, input.fingerprint);
      if (result2.kind === "created")
        this.#audit("envelope.reply_created", input.envelope.id, { parent_id: input.parentId }, input.envelope.createdAt);
      return result2;
    })();
  }
  recoverEnvelopes(now2) {
    return this.#database.transaction(() => this.#recover(now2))();
  }
  appendBusEvent(input) {
    return this.#database.transaction(() => {
      const byId = this.#database.prepare("SELECT * FROM tracker_bus_events WHERE id = ?").get(input.event.id);
      if (byId)
        return byId.fingerprint === input.fingerprint ? { kind: "duplicate", event: hydrateEvent(byId) } : { kind: "conflict", reason: "id" };
      const byKey = this.#database.prepare("SELECT * FROM tracker_bus_events WHERE deduplication_key = ?").get(input.event.deduplicationKey);
      if (byKey)
        return byKey.fingerprint === input.fingerprint ? { kind: "duplicate", event: hydrateEvent(byKey) } : { kind: "conflict", reason: "deduplication_key" };
      this.#database.prepare("INSERT INTO tracker_bus_events(id, project_id, deduplication_key, fingerprint, topic, class, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(input.event.id, input.event.projectId, input.event.deduplicationKey, input.fingerprint, input.event.topic, input.event.class, json7(input.event.payload), input.event.createdAt);
      const row = this.#database.prepare("SELECT * FROM tracker_bus_events WHERE id = ?").get(input.event.id);
      if (!row)
        throw new Error("created bus event disappeared");
      this.#audit("bus.appended", row.id, { topic: row.topic }, row.created_at);
      return { kind: "created", event: hydrateEvent(row) };
    })();
  }
  upsertSubscription(input) {
    return this.#database.transaction(() => {
      this.#database.prepare("INSERT INTO tracker_subscriptions(id, name, recipient_id, topic, classes_json, cursor_sequence, manual, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(recipient_id, name) DO UPDATE SET topic = excluded.topic, classes_json = excluded.classes_json, cursor_sequence = MAX(tracker_subscriptions.cursor_sequence, excluded.cursor_sequence), manual = excluded.manual, status = excluded.status").run(input.id, input.name, input.recipientId, input.topic, json7(input.classes), input.cursor, input.manual ? 1 : 0, input.status, input.createdAt);
      const row = this.#database.prepare("SELECT * FROM tracker_subscriptions WHERE recipient_id = ? AND name = ?").get(input.recipientId, input.name);
      if (!row)
        throw new Error("subscription upsert disappeared");
      this.#audit("subscription.upserted", row.id, { recipient_id: row.recipient_id }, input.createdAt);
      return hydrateSubscription(row);
    })();
  }
  pendingSubscriptionEvents(input) {
    const subscriptionRow = this.#database.prepare("SELECT * FROM tracker_subscriptions WHERE id = ?").get(input.id);
    if (subscriptionRow?.status !== "active")
      return void 0;
    const subscription = hydrateSubscription(subscriptionRow);
    const placeholders = subscription.classes.map(() => "?").join(", ");
    const rows = this.#database.prepare(`SELECT * FROM tracker_bus_events WHERE topic = ? AND sequence > ? AND class IN (${placeholders}) ORDER BY sequence ASC LIMIT ?`).all(subscription.topic, subscription.cursor, ...subscription.classes, input.limit);
    const events = rows.map(hydrateEvent);
    return Object.freeze({
      subscription,
      events: Object.freeze(events),
      fromSequence: subscription.cursor,
      toSequence: events.at(-1)?.sequence ?? subscription.cursor
    });
  }
  advanceSubscriptionCursor(input) {
    if (input.toSequence < input.fromSequence)
      return false;
    return this.#database.prepare("UPDATE tracker_subscriptions SET cursor_sequence = ? WHERE id = ? AND cursor_sequence = ? AND status = 'active'").run(input.toSequence, input.id, input.fromSequence).changes === 1;
  }
  upsertPassiveDelta(input) {
    this.#database.transaction(() => {
      this.#database.prepare("INSERT INTO tracker_passive_slots(recipient_id, ticket_id, category, baseline_json, value_json, event_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(recipient_id, ticket_id, category) DO UPDATE SET sequence = (SELECT COALESCE(MAX(sequence), 0) + 1 FROM tracker_passive_slots), value_json = excluded.value_json, event_id = excluded.event_id, updated_at = excluded.updated_at").run(input.recipientId, input.ticketId, input.category, json7(input.baseline), json7(input.value), input.eventId, input.now, input.now);
      this.#audit("passive.coalesced", input.eventId, { recipient_id: input.recipientId }, input.now);
    })();
  }
  claimPassiveBatch(input) {
    return this.#database.transaction(() => {
      let cursor = this.#database.prepare("SELECT * FROM tracker_passive_cursors WHERE recipient_id = ?").get(input.recipientId);
      if (cursor?.lease_id && cursor.lease_until && cursor.lease_until > input.now)
        return void 0;
      if (!cursor) {
        this.#database.prepare("INSERT INTO tracker_passive_cursors(recipient_id, cursor_sequence, updated_at) VALUES (?, 0, ?)").run(input.recipientId, input.now);
        cursor = this.#database.prepare("SELECT * FROM tracker_passive_cursors WHERE recipient_id = ?").get(input.recipientId);
      }
      if (!cursor)
        throw new Error("passive cursor creation disappeared");
      let entries;
      let toSequence;
      if (cursor.pending_json && cursor.pending_to_sequence !== null) {
        const parsed = JSON.parse(cursor.pending_json);
        entries = Array.isArray(parsed) ? Object.freeze(parsed) : [];
        toSequence = cursor.pending_to_sequence;
      } else {
        const rows = this.#database.prepare("SELECT * FROM tracker_passive_slots WHERE recipient_id = ? AND sequence > ? ORDER BY sequence ASC").all(input.recipientId, cursor.cursor_sequence);
        if (rows.length === 0)
          return void 0;
        entries = Object.freeze(rows.map(passiveEntry));
        toSequence = Number(rows.at(-1)?.sequence);
        this.#database.prepare("UPDATE tracker_passive_cursors SET pending_json = ?, pending_to_sequence = ?, updated_at = ? WHERE recipient_id = ?").run(json7(entries), toSequence, input.now, input.recipientId);
      }
      const claimed = this.#database.prepare("UPDATE tracker_passive_cursors SET lease_id = ?, lease_until = ?, updated_at = ? WHERE recipient_id = ? AND (lease_id IS NULL OR lease_until <= ?)").run(input.leaseId, input.leaseUntil, input.now, input.recipientId, input.now).changes;
      if (claimed !== 1)
        return void 0;
      this.#audit("passive.claimed", input.leaseId, { recipient_id: input.recipientId }, input.now);
      return Object.freeze({
        recipientId: input.recipientId,
        leaseId: input.leaseId,
        leaseUntil: input.leaseUntil,
        cursor: cursor.cursor_sequence,
        body: entries.map((entry2) => `- ${entry2.ticketId}: ${entry2.category}`).join("\n"),
        entries
      });
    })();
  }
  commitPassiveBatch(input) {
    return this.#database.transaction(() => {
      const cursor = this.#database.prepare("SELECT * FROM tracker_passive_cursors WHERE recipient_id = ? AND lease_id = ?").get(input.recipientId, input.leaseId);
      if (!cursor || cursor.pending_to_sequence === null)
        return false;
      this.#database.prepare("DELETE FROM tracker_passive_slots WHERE recipient_id = ? AND sequence <= ?").run(input.recipientId, cursor.pending_to_sequence);
      const changed = this.#database.prepare("UPDATE tracker_passive_cursors SET cursor_sequence = ?, pending_json = NULL, pending_to_sequence = NULL, lease_id = NULL, lease_until = NULL, updated_at = ? WHERE recipient_id = ? AND lease_id = ?").run(cursor.pending_to_sequence, input.now, input.recipientId, input.leaseId).changes;
      if (changed === 1)
        this.#audit("passive.committed", input.leaseId, { recipient_id: input.recipientId }, input.now);
      return changed === 1;
    })();
  }
  releasePassiveBatch(input) {
    const changed = this.#database.prepare("UPDATE tracker_passive_cursors SET lease_id = NULL, lease_until = NULL, updated_at = ? WHERE recipient_id = ? AND lease_id = ? AND pending_json IS NOT NULL").run(input.now, input.recipientId, input.leaseId).changes;
    if (changed === 1)
      this.#audit("passive.released", input.leaseId, { recipient_id: input.recipientId }, input.now);
    return changed === 1;
  }
  prune(input) {
    return this.#database.transaction(() => {
      const events = this.#database.prepare("DELETE FROM tracker_bus_events WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM tracker_subscriptions s WHERE s.topic = tracker_bus_events.topic AND s.status IN ('active', 'offline') AND s.cursor_sequence < tracker_bus_events.sequence)").run(input.before).changes;
      const envelopes = this.#database.prepare("DELETE FROM tracker_envelopes WHERE created_at < ? AND status IN ('acknowledged', 'expired', 'cancelled') AND NOT EXISTS (SELECT 1 FROM tracker_envelopes child WHERE child.parent_id = tracker_envelopes.id)").run(input.before).changes;
      const auditId = crypto14.randomUUID();
      this.#database.prepare("INSERT INTO tracker_delivery_audit(id, kind, subject_id, details_json, created_at) VALUES (?, 'tracker.pruned', 'tracker', ?, ?)").run(auditId, json7({ events, envelopes }), input.now);
      return Object.freeze({ events, envelopes, auditId });
    })();
  }
  audit() {
    return this.#database.prepare("SELECT id, kind, subject_id, details_json, created_at FROM tracker_delivery_audit ORDER BY created_at, id").all().map((row) => Object.freeze({
      id: row.id,
      kind: row.kind,
      subjectId: row.subject_id,
      details: parseObject(row.details_json),
      createdAt: row.created_at
    }));
  }
};

// packages/persistence/dist/owner.js
var fileSystem4 = fs12;
var pathBoundary2 = path13;
function ensureParent(target) {
  fileSystem4.mkdirSync(pathBoundary2.dirname(target), {
    recursive: true,
    mode: 448
  });
}
function safeClose(database) {
  try {
    database?.close();
  } catch {
  }
}
var PersistenceOwner = class {
  #runtime;
  #tracker;
  #runtimeSql;
  #trackerSql;
  #runtimeRepository;
  #runtimeProjectionRepository;
  #trackerRepository;
  #trackerCoreRepository;
  #managementRepository;
  #commandReceiptRepository;
  #committedPublicationRepository;
  #browserPrincipalRepository;
  #paths;
  #ownerId;
  #clock;
  #lockPath;
  #ownerLock;
  #closed = false;
  #trackerBaseline;
  constructor(paths, options) {
    this.#paths = Object.freeze({ ...paths });
    this.#clock = options.clock ?? systemPersistenceClock;
    this.#ownerId = options.ownerId ?? sha256(`${paths.runtimePath}:${process.pid}:${this.#clock.now()}`).slice(0, 24);
    this.#lockPath = paths.lockPath ?? `${paths.runtimePath}.owner.lock`;
    this.#ownerLock = acquireOwnerLock(this.#lockPath, this.#ownerId, this.#clock);
    let runtime;
    let tracker;
    try {
      ensureParent(paths.runtimePath);
      ensureParent(paths.trackerPath);
      runtime = new Database4(paths.runtimePath);
      tracker = new Database4(paths.trackerPath);
      this.#runtime = runtime;
      this.#tracker = tracker;
      this.#runtimeSql = new Kysely2({
        dialect: new SqliteDialect2({
          database: runtime
        })
      });
      this.#trackerSql = new Kysely2({
        dialect: new SqliteDialect2({
          database: tracker
        })
      });
      const runtimePlan = planFor(runtime, "runtime", "apply");
      const trackerIsLegacy = hasTrackerTables(tracker) && !hasManagedTrackerSchema(tracker);
      const trackerPlan = trackerIsLegacy ? void 0 : planFor(tracker, "tracker", "apply");
      this.#trackerBaseline = trackerIsLegacy ? "unmanaged" : "managed";
      configure(runtime);
      applyPlan(runtime, paths.runtimePath, runtimePlan, this.#clock);
      if (this.#trackerBaseline === "managed" && trackerPlan) {
        tracker.pragma("busy_timeout = 1000");
        configure(tracker);
        applyPlan(tracker, paths.trackerPath, trackerPlan, this.#clock);
      }
      this.#runtimeRepository = new RuntimeRepository(runtime, this.#clock);
      this.#trackerRepository = new TrackerRepository(tracker);
      this.#runtimeProjectionRepository = new RuntimeProjectionRepository(runtime, this.#runtimeRepository.runtimeProjectStorage(), this.#runtimeRepository.runtimeSessionStorage(), this.#runtimeRepository.runtimeEndpointStorage());
      this.#trackerCoreRepository = new TrackerCoreRepository(this.#trackerSql, tracker);
      this.#managementRepository = new TrackerManagementRepository(this.#trackerSql, tracker);
      this.#commandReceiptRepository = new CommandReceiptRepository(this.#trackerSql, tracker);
      this.#committedPublicationRepository = new CommittedPublicationRepository(tracker);
      this.#browserPrincipalRepository = new BrowserPrincipalRepository(tracker, this.#clock);
    } catch (error2) {
      safeClose(runtime);
      safeClose(tracker);
      releaseOwnerLock(this.#ownerLock);
      throw error2;
    }
  }
  plan(scope, mode = "dry-run") {
    const database = scope === "runtime" ? this.#runtime : this.#tracker;
    const databasePath = scope === "runtime" ? this.#paths.runtimePath : this.#paths.trackerPath;
    return mode === "dry-run" ? dryRunPlan(database, databasePath, scope, this.#clock) : planFor(database, scope, "apply");
  }
  apply(scope, expectedPlanHash) {
    const database = scope === "runtime" ? this.#runtime : this.#tracker;
    const databasePath = scope === "runtime" ? this.#paths.runtimePath : this.#paths.trackerPath;
    const approvedPlan = planFor(database, scope, "apply");
    if (typeof expectedPlanHash !== "string" || !expectedPlanHash.trim() || expectedPlanHash !== approvedPlan.planHash)
      throw new PersistenceMigrationError("plan_mismatch", `${scope} migration plan no longer matches the approved dry-run`);
    if (scope === "tracker" && this.#trackerBaseline === "unmanaged")
      configure(this.#tracker);
    const plan = planFor(database, scope, "apply");
    if (expectedPlanHash !== plan.planHash)
      throw new PersistenceMigrationError("plan_mismatch", `${scope} migration plan changed while preparing the source database`);
    const result2 = applyPlan(database, databasePath, plan, this.#clock);
    if (scope === "tracker") {
      this.#trackerBaseline = "managed";
    }
    return result2;
  }
  checkpointAndBackup(scope) {
    return backupDatabase(scope === "runtime" ? this.#runtime : this.#tracker, scope === "runtime" ? this.#paths.runtimePath : this.#paths.trackerPath, this.#clock);
  }
  recordRuntimeTransaction(input) {
    return this.#runtimeRepository.record(input);
  }
  materializeRuntimeEvent(input) {
    return this.#runtimeRepository.materialize(input);
  }
  claimRuntimeOutbox(workerId, limit, leaseMs) {
    return this.#runtimeRepository.claim(workerId, limit, leaseMs);
  }
  replayRuntimeOutbox() {
    return this.#runtimeRepository.replay();
  }
  ackRuntimeOutbox(id2, claimToken) {
    return this.#runtimeRepository.ack(id2, claimToken);
  }
  failRuntimeOutbox(id2, claimToken, error2) {
    return this.#runtimeRepository.fail(id2, claimToken, error2);
  }
  runtimeOutboxHealth() {
    return this.#runtimeRepository.health();
  }
  runtimeProjectStorage() {
    return this.#runtimeRepository.runtimeProjectStorage();
  }
  runtimeSessionStorage() {
    return this.#runtimeRepository.runtimeSessionStorage();
  }
  runtimeEndpointStorage() {
    return this.#runtimeRepository.runtimeEndpointStorage();
  }
  runtimeProjectionStorage() {
    return this.#runtimeProjectionRepository;
  }
  trackerStorage() {
    return this.#trackerRepository;
  }
  trackerCoreStorage() {
    return this.#trackerCoreRepository;
  }
  managementStorage() {
    return this.#managementRepository;
  }
  commandGatewayStorage() {
    const receipts = this.#commandReceiptRepository;
    const storage = this.#commandReceiptRepository;
    return Object.freeze({
      receipts,
      transaction: (fn) => storage.transaction(fn)
    });
  }
  committedPublicationStorage() {
    return this.#committedPublicationRepository;
  }
  browserPrincipalStorage() {
    return this.#browserPrincipalRepository;
  }
  status() {
    return Object.freeze({
      owner: {
        lockPath: this.#lockPath,
        ownerId: this.#ownerId,
        nonce: this.#ownerLock.nonce,
        pid: process.pid
      },
      runtime: health(this.#runtime),
      tracker: {
        ...health(this.#tracker),
        baseline: this.#trackerBaseline
      }
    });
  }
  async close() {
    if (this.#closed)
      return;
    this.#closed = true;
    try {
      this.#runtime.pragma("wal_checkpoint(PASSIVE)");
      if (this.#trackerBaseline === "managed")
        this.#tracker.pragma("wal_checkpoint(PASSIVE)");
      await Promise.all([
        this.#runtimeSql.destroy(),
        this.#trackerSql.destroy()
      ]);
    } finally {
      safeClose(this.#runtime);
      safeClose(this.#tracker);
      releaseOwnerLock(this.#ownerLock);
    }
  }
};
function openPersistenceForControlPlane(paths, options = {}) {
  return new PersistenceOwner(paths, options);
}

// apps/control-plane/src/persistence.ts
function openControlPlanePersistence(paths, options) {
  return openPersistenceForControlPlane(paths, options);
}

// apps/control-plane/src/lifecycle.ts
import crypto24 from "node:crypto";
import fs15 from "node:fs";
import path17 from "node:path";
import websocket from "@fastify/websocket";
import Fastify from "fastify";

// apps/control-plane/src/api-v1.ts
import crypto16 from "node:crypto";

// apps/control-plane/src/errors.ts
import crypto15 from "node:crypto";
function correlationId(request) {
  const candidate = request.headers["x-correlation-id"];
  return typeof candidate === "string" && candidate.length > 0 && candidate.length <= 128 ? candidate : `corr_${crypto15.randomUUID()}`;
}
function errorEnvelope(request, code, message, details) {
  return ApiErrorV1Schema.parse({
    schema_version: "golem.api-error/v1",
    code,
    message,
    correlation_id: correlationId(request),
    ...details ? { details } : {}
  });
}
function fail(request, reply, statusCode, code, message, details) {
  return reply.code(statusCode).send(errorEnvelope(request, code, message, details));
}
function sendValidated(request, reply, schema2, value2) {
  const parsed = schema2.safeParse(value2);
  if (!parsed.success)
    return fail(
      request,
      reply,
      500,
      "response.invalid",
      "typed control-plane response could not be completed"
    );
  return reply.send(parsed.data);
}
function registerErrorEnvelope(app) {
  app.setErrorHandler((error2, request, reply) => {
    const statusCandidate = typeof error2 === "object" && error2 !== null && "statusCode" in error2 ? error2.statusCode : void 0;
    const statusCode = typeof statusCandidate === "number" && statusCandidate >= 400 && statusCandidate < 500 ? statusCandidate : 500;
    return fail(
      request,
      reply,
      statusCode,
      statusCode === 500 ? "response.invalid" : "request.invalid",
      statusCode === 500 ? "typed control-plane response could not be completed" : "typed control-plane request is invalid"
    );
  });
}

// apps/control-plane/src/api-v1.ts
function record(value2) {
  return value2 && typeof value2 === "object" && !Array.isArray(value2) ? value2 : {};
}
function value(request) {
  return record(request.body);
}
function rejectForgedIdentity(input) {
  return Object.keys(input).some(
    (key) => /^(?:actor|created_?by|role|project(?:_?id)?|session(?:_?id)?|bearer|authorization|owner(?:_?fence|_?id)?|fence|approval|storage|principal|scope|sender_?id|worker_?id)$/iu.test(
      key
    )
  ) ? "request authority is server-owned" : void 0;
}
function command(result2, status = "completed") {
  return {
    schema_version: "golem.api-command-outcome/v1",
    command_id: `cmd_${crypto16.randomUUID()}`,
    status,
    result: result2
  };
}
function page2(items, total = items.length) {
  return {
    schema_version: "golem.api-page/v1",
    items,
    next_cursor: null,
    total
  };
}
function statusFor(error2) {
  const code = error2?.code;
  if (code === "tracker.not_found") return 404;
  if (code === "tracker.conflict") return 409;
  if (code === "tracker.phase.invalid") return 409;
  if (error2 instanceof Error && (error2.name === "EnvelopeConflictError" || error2.name === "BusEventConflictError"))
    return 409;
  if (error2 instanceof Error && error2.name === "CommandGatewayError") {
    const gatewayError = error2;
    return gatewayError.httpStatus;
  }
  return 400;
}
function errorCode(error2) {
  const code = error2?.code;
  if (typeof code === "string") return code;
  if (error2 instanceof Error && error2.name === "CommandGatewayError") {
    const gatewayError = error2;
    return gatewayError.status;
  }
  return "api.request.invalid";
}
function publicError(request, reply, error2) {
  const raw = error2 instanceof Error ? error2.message : "request rejected";
  const message = raw.includes("caller.identity") ? raw : "typed API request was rejected";
  const code = error2 instanceof Error && error2.name === "EnvelopeConflictError" ? "delivery.conflict" : error2 instanceof Error && error2.name === "BusEventConflictError" ? "bus.conflict" : raw.includes("not eligible") ? "delivery.ineligible" : errorCode(error2);
  return fail(request, reply, statusFor(error2), code, message);
}
function normalizeQuery(request) {
  return record(request.query);
}
function expectedRevision(input, request, reply) {
  const candidate = input.expected_revision;
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    fail(
      request,
      reply,
      400,
      "tracker.revision.required",
      "expected_revision must be a positive safe integer"
    );
    return void 0;
  }
  return candidate;
}
function registerApiV1Routes(options) {
  const claims = /* @__PURE__ */ new Map();
  const subscriptions = /* @__PURE__ */ new Map();
  const busEvents = [];
  const gateway = options.gateway;
  const ticketDispatch = options.ticketDispatch;
  const guard = (request, reply) => {
    if (hasRequestAuthorityOverride(request)) {
      fail(
        request,
        reply,
        403,
        "browser.forbidden",
        "request authority is server-owned"
      );
      return void 0;
    }
    const action = request.method === "GET" ? "read" : "mutate";
    const context = options.principal.resolve(request, {
      action,
      allowBrowser: true,
      allowBearer: true
    });
    if (!context) {
      fail(
        request,
        reply,
        401,
        "browser.auth.required",
        "an authenticated principal binding is required"
      );
      return void 0;
    }
    if (!options.principal.policy.allows(context, action)) {
      fail(
        request,
        reply,
        403,
        "browser.forbidden",
        "the authenticated principal is not authorized"
      );
      return void 0;
    }
    return Object.freeze({
      projectId: context.defaultProjectId,
      actor: context.actorId,
      principal: context
    });
  };
  const withIdentity = (request, reply, _callerValue) => {
    const input = value(request);
    const forged = rejectForgedIdentity(input);
    if (forged) {
      fail(request, reply, 403, "caller.identity.spoofed", forged);
      return void 0;
    }
    return input;
  };
  const ticketInCallerScope = (callerValue, id2) => {
    const ticket = options.core.compatibility.getTicket(id2);
    return ticket !== void 0 && typeof ticket.project_id === "string" && options.principal.policy.allowsProject(
      callerValue.principal,
      ticket.project_id
    );
  };
  const ticketNotFound = (request, reply) => fail(request, reply, 404, "tracker.not_found", "ticket was not found");
  const dispatchCaller = (request, reply, source) => {
    if (source === "mcp" ? hasRequestAuthorityHeaderOrQueryOverride(request) : hasRequestAuthorityOverride(request)) {
      fail(
        request,
        reply,
        403,
        "browser.forbidden",
        "request authority is server-owned"
      );
      return void 0;
    }
    const context = options.principal.resolve(request, {
      action: "mutate",
      allowBrowser: false,
      allowBearer: true
    });
    if (!context) {
      fail(
        request,
        reply,
        401,
        "browser.auth.required",
        "bearer principal is required"
      );
      return void 0;
    }
    if (context.source !== source) {
      fail(
        request,
        reply,
        403,
        "browser.forbidden",
        "adapter credential is not accepted"
      );
      return void 0;
    }
    if (!options.principal.policy.allows(context, "mutate")) {
      fail(
        request,
        reply,
        403,
        "browser.forbidden",
        "the authenticated principal is not authorized"
      );
      return void 0;
    }
    return Object.freeze({
      projectId: context.defaultProjectId,
      actor: context.actorId,
      principal: context
    });
  };
  function gatewayRoute(input) {
    if (!gateway) return void 0;
    const idempotencyKey = typeof input.idempotencyKey === "string" && input.idempotencyKey ? input.idempotencyKey : `auto:${input.commandKind}:${crypto16.randomUUID()}`;
    const outcome2 = gateway.execute({
      commandId: `cmd_${crypto16.randomUUID()}`,
      idempotencyKey,
      commandKind: input.commandKind,
      actorId: input.caller.actor,
      projectId: input.caller.projectId,
      correlationId: `cor_${crypto16.randomUUID()}`,
      scope: input.scope,
      ...input.expectedRevision !== void 0 ? { expectedRevision: input.expectedRevision } : {},
      payload: input.payload,
      handler: input.handler
    });
    return outcome2;
  }
  function sendGatewayOutcome(reply, outcome2, created = false) {
    if (outcome2.status === "idempotency_mismatch") {
      reply.code(409);
      reply.send({
        schema_version: "golem.api-error/v1",
        code: "command.idempotency_mismatch",
        message: "idempotency key reused with a differing payload",
        correlation_id: outcome2.command_id
      });
      return;
    }
    reply.code(created && outcome2.status === "completed" ? 201 : 200);
    reply.send(outcome2);
  }
  function ticketDispatchHandler(source) {
    const commandGateway = gateway;
    const service = ticketDispatch;
    return async (request, reply) => {
      if (!commandGateway || !service)
        return fail(
          request,
          reply,
          503,
          "tracker.unavailable",
          "ticket dispatch service is unavailable"
        );
      const callerValue = dispatchCaller(request, reply, source);
      if (!callerValue) return;
      const ticketId = request.params.id;
      if (typeof ticketId !== "string" || !ticketInCallerScope(callerValue, ticketId))
        return ticketNotFound(request, reply);
      const ticket = options.core.tickets.get(ticketId)?.ticket;
      if (!ticket || ticket.projectId !== callerValue.projectId)
        return ticketNotFound(request, reply);
      const input = value(request);
      const allowed = new Set(
        source === "mcp" ? [
          "expected_revision",
          "idempotency_key",
          "session_id",
          "note",
          "workspace",
          "when_idle"
        ] : ["expected_revision", "idempotency_key"]
      );
      if (Object.keys(input).some((key) => !allowed.has(key)))
        return fail(
          request,
          reply,
          400,
          "api.request.invalid",
          "ticket dispatch input is not allowlisted"
        );
      if (source === "mcp") {
        for (const field2 of ["session_id", "note", "workspace"])
          if (input[field2] !== void 0 && (typeof input[field2] !== "string" || input[field2].length < 1 || input[field2].length > 4096))
            return fail(
              request,
              reply,
              400,
              "api.request.invalid",
              "legacy dispatch text is invalid"
            );
        if (input.when_idle !== void 0 && typeof input.when_idle !== "boolean")
          return fail(
            request,
            reply,
            400,
            "api.request.invalid",
            "legacy delivery mode is invalid"
          );
      }
      const strong = input.expected_revision !== void 0 || input.idempotency_key !== void 0;
      if (!strong && source !== "mcp" || strong && (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1 || typeof input.idempotency_key !== "string" || input.idempotency_key.length < 1))
        return fail(
          request,
          reply,
          400,
          "tracker.revision.required",
          "expected_revision and idempotency_key are required together"
        );
      const expected = strong ? input.expected_revision : ticket.revision;
      const idempotencyKey = strong ? input.idempotency_key : `legacy:mcp-ticket-dispatch:${crypto16.randomUUID()}`;
      const commandId = `cmd_${crypto16.randomUUID()}`;
      const legacy = source === "mcp" ? {
        ...typeof input.note === "string" ? { note: input.note } : {},
        ...typeof input.workspace === "string" ? { workspace: input.workspace } : {},
        ...typeof input.when_idle === "boolean" ? { whenIdle: input.when_idle } : {}
      } : void 0;
      const outcome2 = commandGateway.execute({
        commandId,
        idempotencyKey,
        commandKind: "dispatch",
        actorId: callerValue.actor,
        projectId: callerValue.projectId,
        correlationId: `cor_${crypto16.randomUUID()}`,
        scope: { resourceType: "ticket", resourceId: ticket.id },
        expectedRevision: expected,
        payload: Object.freeze({
          kind: "dispatch",
          ticket_id: ticket.id,
          expected_revision: expected,
          idempotency_key: idempotencyKey,
          ...source === "mcp" && typeof input.session_id === "string" ? { session_id: input.session_id } : {},
          ...legacy === void 0 ? {} : { legacy }
        }),
        handler: () => service.dispatch({
          projectId: callerValue.projectId,
          ticketId: ticket.id,
          expectedRevision: expected,
          idempotencyKey,
          actorId: callerValue.actor,
          operationId: commandId,
          ...source === "mcp" && typeof input.session_id === "string" ? { assigneeHint: input.session_id } : {},
          ...legacy === void 0 ? {} : { legacy }
        })
      });
      return sendGatewayOutcome(reply, outcome2, true);
    };
  }
  if (ticketDispatch && gateway) {
    options.app.post(
      "/api/v1/tracker/tickets/:id/dispatch",
      ticketDispatchHandler("bearer")
    );
    options.app.post(
      "/api/v1/tracker/mcp/tickets/:id/dispatch",
      ticketDispatchHandler("mcp")
    );
  }
  options.app.get("/api/v1/tracker/tickets", async (request, reply) => {
    const callerValue = guard(request, reply);
    if (!callerValue) return;
    try {
      const query = normalizeQuery(request);
      const items = options.core.compatibility.listTickets({
        projectId: callerValue.projectId,
        ...typeof query.kind === "string" ? { kind: query.kind } : {},
        ...typeof query.phase === "string" ? { phase: query.phase } : {},
        ...typeof query.assignee === "string" ? { assignee: query.assignee } : {}
      });
      return reply.send(page2(items));
    } catch (error2) {
      return publicError(request, reply, error2);
    }
  });
  options.app.get("/api/v1/tracker/tickets/search", async (request, reply) => {
    const callerValue = guard(request, reply);
    if (!callerValue) return;
    try {
      const query = normalizeQuery(request);
      return reply.send(
        page2(
          options.core.compatibility.searchTickets(
            typeof query.q === "string" ? query.q : "",
            callerValue.projectId
          )
        )
      );
    } catch (error2) {
      return publicError(request, reply, error2);
    }
  });
  options.app.get("/api/v1/tracker/tickets/:id", async (request, reply) => {
    const callerValue = guard(request, reply);
    if (!callerValue) return;
    try {
      const id2 = request.params.id;
      const ticket = options.core.compatibility.getTicket(id2);
      if (!ticket || ticket.project_id !== callerValue.projectId)
        return fail(
          request,
          reply,
          404,
          "tracker.not_found",
          "ticket was not found"
        );
      return reply.send(ticket);
    } catch (error2) {
      return publicError(request, reply, error2);
    }
  });
  options.app.post("/api/v1/tracker/tickets", async (request, reply) => {
    const callerValue = guard(request, reply);
    if (!callerValue) return;
    const input = withIdentity(request, reply, callerValue);
    if (!input) return;
    try {
      if (gateway) {
        const idempotencyKey = typeof input.idempotency_key === "string" ? input.idempotency_key : `auto:ticket.create:${crypto16.randomUUID()}`;
        const outcome2 = gateway.execute({
          commandId: `cmd_${crypto16.randomUUID()}`,
          idempotencyKey,
          commandKind: "ticket.create",
          actorId: callerValue.actor,
          projectId: callerValue.projectId,
          correlationId: `correlation_${crypto16.randomUUID()}`,
          scope: { resourceType: "ticket", resourceId: "new" },
          payload: input,
          handler: () => options.core.compatibility.createTicket({
            projectId: callerValue.projectId,
            kind: input.kind,
            title: input.title,
            ...typeof input.body === "string" ? { body: input.body } : {},
            ...typeof input.priority === "string" ? { priority: input.priority } : {},
            ...Array.isArray(input.labels) ? { labels: input.labels } : {},
            ...typeof input.stream_id === "string" ? { streamId: input.stream_id } : {},
            ...typeof input.parent_id === "string" ? { parentId: input.parent_id } : {},
            ...typeof input.assignee === "string" ? { assignee: input.assignee } : {},
            ...typeof input.rank === "number" ? { rank: input.rank } : {},
            ...typeof input.wave === "number" ? { wave: input.wave } : {},
            actor: callerValue.actor
          })
        });
        if (outcome2) return sendGatewayOutcome(reply, outcome2, true);
      }
      const result2 = command(
        options.core.compatibility.createTicket({
          projectId: callerValue.projectId,
          kind: input.kind,
          title: input.title,
          ...typeof input.body === "string" ? { body: input.body } : {},
          ...typeof input.priority === "string" ? { priority: input.priority } : {},
          ...Array.isArray(input.labels) ? { labels: input.labels } : {},
          ...typeof input.stream_id === "string" ? { streamId: input.stream_id } : {},
          ...typeof input.parent_id === "string" ? { parentId: input.parent_id } : {},
          ...typeof input.assignee === "string" ? { assignee: input.assignee } : {},
          ...typeof input.rank === "number" ? { rank: input.rank } : {},
          ...typeof input.wave === "number" ? { wave: input.wave } : {},
          actor: callerValue.actor
        })
      );
      return reply.code(201).send(result2);
    } catch (error2) {
      return publicError(request, reply, error2);
    }
  });
  options.app.patch("/api/v1/tracker/tickets/:id", async (request, reply) => {
    const callerValue = guard(request, reply);
    if (!callerValue) return;
    const input = withIdentity(request, reply, callerValue);
    if (!input) return;
    try {
      const id2 = request.params.id;
      const current = options.core.compatibility.getTicket(id2);
      if (!current || current.project_id !== callerValue.projectId)
        return fail(
          request,
          reply,
          404,
          "tracker.not_found",
          "ticket was not found"
        );
      const revision = expectedRevision(input, request, reply);
      if (revision === void 0) return;
      if (gateway) {
        const outcome2 = gatewayRoute({
          request,
          reply,
          caller: callerValue,
          commandKind: "ticket.update",
          scope: { resourceType: "ticket", resourceId: id2 },
          payload: input,
          idempotencyKey: typeof input.idempotency_key === "string" ? input.idempotency_key : void 0,
          expectedRevision: revision,
          handler: () => options.core.compatibility.updateTicket({
            id: id2,
            expectedRevision: revision,
            patch: {
              ...typeof input.title === "string" ? { title: input.title } : {},
              ...typeof input.body === "string" ? { body: input.body } : {},
              ...typeof input.priority === "string" ? { priority: input.priority } : {},
              ...Array.isArray(input.labels) ? { labels: input.labels } : {},
              ...typeof input.assignee === "string" ? { assignee: input.assignee } : {},
              ...typeof input.rank === "number" ? { rank: input.rank } : {},
              ...typeof input.wave === "number" ? { wave: input.wave } : {}
            },
            ...typeof input.reason === "string" ? { reason: input.reason } : {},
            actor: callerValue.actor
          })
        });
        if (outcome2) return sendGatewayOutcome(reply, outcome2);
      }
      const result2 = command(
        options.core.compatibility.updateTicket({
          id: id2,
          expectedRevision: revision,
          patch: {
            ...typeof input.title === "string" ? { title: input.title } : {},
            ...typeof input.body === "string" ? { body: input.body } : {},
            ...typeof input.priority === "string" ? { priority: input.priority } : {},
            ...Array.isArray(input.labels) ? { labels: input.labels } : {},
            ...typeof input.assignee === "string" ? { assignee: input.assignee } : {},
            ...typeof input.rank === "number" ? { rank: input.rank } : {},
            ...typeof input.wave === "number" ? { wave: input.wave } : {}
          },
          ...typeof input.reason === "string" ? { reason: input.reason } : {},
          actor: callerValue.actor
        })
      );
      return reply.send(result2);
    } catch (error2) {
      return publicError(request, reply, error2);
    }
  });
  options.app.post(
    "/api/v1/tracker/tickets/:id/transition",
    async (request, reply) => {
      const callerValue = guard(request, reply);
      if (!callerValue) return;
      const input = withIdentity(request, reply, callerValue);
      if (!input) return;
      try {
        const id2 = request.params.id;
        const current = options.core.compatibility.getTicket(id2);
        if (!current || current.project_id !== callerValue.projectId)
          return fail(
            request,
            reply,
            404,
            "tracker.not_found",
            "ticket was not found"
          );
        const revision = expectedRevision(input, request, reply);
        if (revision === void 0) return;
        if (gateway) {
          const outcome2 = gatewayRoute({
            request,
            reply,
            caller: callerValue,
            commandKind: "ticket.transition",
            scope: { resourceType: "ticket", resourceId: id2 },
            payload: input,
            idempotencyKey: typeof input.idempotency_key === "string" ? input.idempotency_key : void 0,
            expectedRevision: revision,
            handler: () => options.core.compatibility.transitionTicket({
              id: id2,
              expectedRevision: revision,
              phase: input.phase,
              ...typeof input.reason === "string" ? { reason: input.reason } : {},
              actor: callerValue.actor
            })
          });
          if (outcome2) return sendGatewayOutcome(reply, outcome2);
        }
        return reply.send(
          command(
            options.core.compatibility.transitionTicket({
              id: id2,
              expectedRevision: revision,
              phase: input.phase,
              ...typeof input.reason === "string" ? { reason: input.reason } : {},
              actor: callerValue.actor
            })
          )
        );
      } catch (error2) {
        return publicError(request, reply, error2);
      }
    }
  );
  options.app.post(
    "/api/v1/tracker/tickets/:id/close",
    async (request, reply) => {
      const callerValue = guard(request, reply);
      if (!callerValue) return;
      const input = withIdentity(request, reply, callerValue);
      if (!input) return;
      const keys = Object.keys(input);
      if (keys.some((key) => !["expected_revision", "reason"].includes(key)))
        return fail(
          request,
          reply,
          403,
          "tracker.close.authority",
          "exceptional close authority is server-owned"
        );
      return fail(
        request,
        reply,
        403,
        "tracker.close.authority",
        "exceptional close requires a verified authority composition"
      );
    }
  );
  options.app.post(
    "/api/v1/tracker/tickets/:id/comments",
    async (request, reply) => {
      const callerValue = guard(request, reply);
      if (!callerValue) return;
      const input = withIdentity(request, reply, callerValue);
      if (!input) return;
      try {
        const id2 = request.params.id;
        if (!ticketInCallerScope(callerValue, id2))
          return ticketNotFound(request, reply);
        const suppliedAnchor = record(input.anchor);
        const anchor2 = Object.keys(suppliedAnchor).length > 0 ? suppliedAnchor : Object.fromEntries(
          [
            ["quote", input.quote],
            ["prefix", input.prefix],
            ["suffix", input.suffix],
            ["section", input.section],
            ["sectionId", input.section_id]
          ].filter(([, candidate]) => typeof candidate === "string")
        );
        const commentPayload = {
          ticket_id: id2,
          body: input.body,
          ...Object.keys(anchor2).length > 0 ? { anchor: anchor2 } : {},
          ...typeof input.tag === "string" ? { tag: input.tag } : {},
          ...typeof input.status === "string" ? { status: input.status } : {}
        };
        if (gateway) {
          const outcome2 = gatewayRoute({
            request,
            reply,
            caller: callerValue,
            commandKind: "ticket.comment.create",
            scope: { resourceType: "comment", resourceId: id2 },
            payload: commentPayload,
            idempotencyKey: typeof input.idempotency_key === "string" ? input.idempotency_key : void 0,
            handler: () => options.core.compatibility.addComment({
              ticketId: id2,
              author: callerValue.actor,
              body: input.body,
              ...Object.keys(anchor2).length > 0 ? { anchor: anchor2 } : {},
              ...typeof input.tag === "string" ? { tag: input.tag } : {},
              ...typeof input.status === "string" ? { status: input.status } : {}
            })
          });
          if (outcome2) return sendGatewayOutcome(reply, outcome2, true);
        }
        return reply.code(201).send(
          command(
            options.core.compatibility.addComment({
              ticketId: id2,
              author: callerValue.actor,
              body: input.body,
              ...Object.keys(anchor2).length > 0 ? { anchor: anchor2 } : {},
              ...typeof input.tag === "string" ? { tag: input.tag } : {},
              ...typeof input.status === "string" ? { status: input.status } : {}
            })
          )
        );
      } catch (error2) {
        return publicError(request, reply, error2);
      }
    }
  );
  options.app.post(
    "/api/v1/tracker/tickets/:id/comments/:commentId/reply",
    async (request, reply) => {
      const callerValue = guard(request, reply);
      if (!callerValue) return;
      const input = withIdentity(request, reply, callerValue);
      if (!input) return;
      try {
        const params = request.params;
        if (!ticketInCallerScope(callerValue, params.id))
          return ticketNotFound(request, reply);
        const replyPayload = {
          ticket_id: params.id,
          parent_id: params.commentId,
          body: input.body
        };
        if (gateway) {
          const outcome2 = gatewayRoute({
            request,
            reply,
            caller: callerValue,
            commandKind: "ticket.comment.reply",
            scope: {
              resourceType: "comment",
              resourceId: params.commentId
            },
            payload: replyPayload,
            idempotencyKey: typeof input.idempotency_key === "string" ? input.idempotency_key : void 0,
            handler: () => options.core.compatibility.replyComment({
              ticketId: params.id,
              parentId: params.commentId,
              author: callerValue.actor,
              body: input.body
            })
          });
          if (outcome2) return sendGatewayOutcome(reply, outcome2, true);
        }
        return reply.code(201).send(
          command(
            options.core.compatibility.replyComment({
              ticketId: params.id,
              parentId: params.commentId,
              author: callerValue.actor,
              body: input.body
            })
          )
        );
      } catch (error2) {
        return publicError(request, reply, error2);
      }
    }
  );
  options.app.patch(
    "/api/v1/tracker/tickets/:id/comments/:commentId",
    async (request, reply) => {
      const callerValue = guard(request, reply);
      if (!callerValue) return;
      const input = withIdentity(request, reply, callerValue);
      if (!input) return;
      try {
        const params = request.params;
        if (!ticketInCallerScope(callerValue, params.id))
          return ticketNotFound(request, reply);
        const updatePayload = {
          ticket_id: params.id,
          comment_id: params.commentId,
          ...typeof input.body === "string" ? { body: input.body } : {},
          ...typeof input.tag === "string" ? { tag: input.tag } : {},
          ...typeof input.status === "string" ? { status: input.status } : {}
        };
        if (gateway) {
          const outcome2 = gatewayRoute({
            request,
            reply,
            caller: callerValue,
            commandKind: "ticket.comment.update",
            scope: {
              resourceType: "comment",
              resourceId: params.commentId
            },
            payload: updatePayload,
            idempotencyKey: typeof input.idempotency_key === "string" ? input.idempotency_key : void 0,
            handler: () => options.core.compatibility.updateComment({
              ticketId: params.id,
              commentId: params.commentId,
              patch: {
                ...typeof input.body === "string" ? { body: input.body } : {},
                ...typeof input.tag === "string" ? { tag: input.tag } : {},
                ...typeof input.status === "string" ? { status: input.status } : {}
              },
              actor: callerValue.actor
            })
          });
          if (outcome2) return sendGatewayOutcome(reply, outcome2);
        }
        return reply.send(
          command(
            options.core.compatibility.updateComment({
              ticketId: params.id,
              commentId: params.commentId,
              patch: {
                ...typeof input.body === "string" ? { body: input.body } : {},
                ...typeof input.tag === "string" ? { tag: input.tag } : {},
                ...typeof input.status === "string" ? { status: input.status } : {}
              },
              actor: callerValue.actor
            })
          )
        );
      } catch (error2) {
        return publicError(request, reply, error2);
      }
    }
  );
  options.app.post("/api/v1/tracker/streams", async (request, reply) => {
    const callerValue = guard(request, reply);
    if (!callerValue) return;
    const input = withIdentity(request, reply, callerValue);
    if (!input) return;
    try {
      const streamId = typeof input.id === "string" ? input.id : `stream_${crypto16.randomUUID()}`;
      const streamPayload = {
        id: streamId,
        name: input.name,
        ...input.mode === "sequential" || input.mode === "parallel" ? { mode: input.mode } : {},
        ...typeof input.description === "string" ? { description: input.description } : {},
        ...typeof input.expected_revision === "number" ? { expected_revision: input.expected_revision } : {}
      };
      if (gateway) {
        const outcome2 = gatewayRoute({
          request,
          reply,
          caller: callerValue,
          commandKind: "stream.upsert",
          scope: { resourceType: "stream", resourceId: streamId },
          payload: streamPayload,
          idempotencyKey: typeof input.idempotency_key === "string" ? input.idempotency_key : void 0,
          ...typeof input.expected_revision === "number" ? { expectedRevision: input.expected_revision } : {},
          handler: () => options.core.compatibility.upsertStream({
            ...typeof input.id === "string" ? { id: input.id } : {},
            projectId: callerValue.projectId,
            name: input.name,
            ...input.mode === "sequential" || input.mode === "parallel" ? { mode: input.mode } : {},
            ...typeof input.description === "string" ? { description: input.description } : {},
            ...typeof input.expected_revision === "number" ? { expectedRevision: input.expected_revision } : {},
            actor: callerValue.actor
          })
        });
        if (outcome2) return sendGatewayOutcome(reply, outcome2, true);
      }
      return reply.code(201).send(
        command(
          options.core.compatibility.upsertStream({
            ...typeof input.id === "string" ? { id: input.id } : {},
            projectId: callerValue.projectId,
            name: input.name,
            ...input.mode === "sequential" || input.mode === "parallel" ? { mode: input.mode } : {},
            ...typeof input.description === "string" ? { description: input.description } : {},
            ...typeof input.expected_revision === "number" ? { expectedRevision: input.expected_revision } : {},
            actor: callerValue.actor
          })
        )
      );
    } catch (error2) {
      return publicError(request, reply, error2);
    }
  });
  options.app.get("/api/v1/tracker/streams", async (request, reply) => {
    const callerValue = guard(request, reply);
    if (!callerValue) return;
    return reply.send(
      page2(options.core.compatibility.listStreams(callerValue.projectId))
    );
  });
  options.app.post("/api/v1/delivery/envelopes", async (request, reply) => {
    const callerValue = guard(request, reply);
    if (!callerValue) return;
    const input = withIdentity(request, reply, callerValue);
    if (!input) return;
    try {
      if (typeof input.sender_id === "string" && input.sender_id !== callerValue.actor)
        return fail(
          request,
          reply,
          403,
          "caller.identity.spoofed",
          "sender identity is process-composed"
        );
      const envelope = options.services.delivery.enqueue({
        id: input.id,
        projectId: callerValue.projectId,
        idempotencyKey: input.idempotency_key,
        senderId: callerValue.actor,
        recipientId: input.recipient_id,
        kind: input.kind,
        payload: record(input.payload),
        ...typeof input.deadline_at === "string" ? { deadlineAt: input.deadline_at } : {},
        ...typeof input.max_attempts === "number" ? { maxAttempts: input.max_attempts } : {}
      });
      return reply.code(201).send(command(envelope));
    } catch (error2) {
      return publicError(request, reply, error2);
    }
  });
  options.app.post("/api/v1/delivery/claims", async (request, reply) => {
    const callerValue = guard(request, reply);
    if (!callerValue) return;
    const input = withIdentity(request, reply, callerValue);
    if (!input) return;
    try {
      if (typeof input.worker_id === "string" && input.worker_id !== callerValue.actor)
        return fail(
          request,
          reply,
          403,
          "caller.identity.spoofed",
          "worker identity is process-composed"
        );
      const result2 = options.services.delivery.claim(
        callerValue.actor,
        typeof input.limit === "number" ? input.limit : 10,
        typeof input.lease_ms === "number" ? input.lease_ms : void 0
      );
      const items = result2.map((claim) => {
        claims.set(claim.envelope.claimToken, claim);
        return claim.envelope;
      });
      return reply.send(page2(items));
    } catch (error2) {
      return publicError(request, reply, error2);
    }
  });
  options.app.post(
    "/api/v1/delivery/claims/:token/prepare",
    async (request, reply) => {
      const callerValue = guard(request, reply);
      if (!callerValue) return;
      const token2 = request.params.token;
      const claim = claims.get(token2);
      if (!claim)
        return fail(
          request,
          reply,
          404,
          "delivery.claim.not_found",
          "delivery claim is not available"
        );
      const prepared = claim.prepare();
      if (prepared.kind === "stale")
        return reply.code(409).send(command(prepared, "conflict"));
      return reply.send(command(prepared));
    }
  );
  options.app.post(
    "/api/v1/delivery/claims/:token/ack",
    async (request, reply) => {
      const callerValue = guard(request, reply);
      if (!callerValue) return;
      const token2 = request.params.token;
      const claim = claims.get(token2);
      if (!claim)
        return fail(
          request,
          reply,
          404,
          "delivery.claim.not_found",
          "delivery claim is not available"
        );
      try {
        const input = value(request);
        return reply.send(
          command({
            accepted: claim.acknowledge(
              input.acknowledgement_id,
              record(input.payload)
            )
          })
        );
      } catch (error2) {
        return publicError(request, reply, error2);
      }
    }
  );
  for (const action of ["delivered", "fail"]) {
    options.app.post(
      `/api/v1/delivery/claims/:token/${action}`,
      async (request, reply) => {
        const callerValue = guard(request, reply);
        if (!callerValue) return;
        const token2 = request.params.token;
        const claim = claims.get(token2);
        if (!claim)
          return fail(
            request,
            reply,
            404,
            "delivery.claim.not_found",
            "delivery claim is not available"
          );
        try {
          const result2 = action === "delivered" ? claim.delivered() : claim.fail(
            typeof value(request).error === "string" ? value(request).error : "delivery failed"
          );
          claims.delete(token2);
          return reply.send(command(result2));
        } catch (error2) {
          return publicError(request, reply, error2);
        }
      }
    );
  }
  options.app.post("/api/v1/bus/events", async (request, reply) => {
    const callerValue = guard(request, reply);
    if (!callerValue) return;
    const input = withIdentity(request, reply, callerValue);
    if (!input) return;
    try {
      const event = options.services.bus.append({
        id: input.id,
        projectId: callerValue.projectId,
        deduplicationKey: input.deduplication_key,
        topic: input.topic,
        class: input.class,
        payload: record(input.payload)
      });
      busEvents.push(event);
      return reply.code(201).send(command(event));
    } catch (error2) {
      return publicError(request, reply, error2);
    }
  });
  options.app.get("/api/v1/bus/events", async (request, reply) => {
    const callerValue = guard(request, reply);
    if (!callerValue) return;
    return reply.send(page2(busEvents));
  });
  options.app.post("/api/v1/subscriptions", async (request, reply) => {
    const callerValue = guard(request, reply);
    if (!callerValue) return;
    const input = withIdentity(request, reply, callerValue);
    if (!input) return;
    try {
      const subscription = options.services.subscriptions.subscribe({
        ...typeof input.id === "string" ? { id: input.id } : {},
        name: input.name || `mcp:${callerValue.actor}:${input.topic}`,
        recipientId: callerValue.actor,
        topic: input.topic,
        ...Array.isArray(input.classes) ? { classes: input.classes } : {},
        ...typeof input.cursor === "number" ? { cursor: input.cursor } : {}
      });
      subscriptions.set(subscription.id, subscription);
      return reply.code(201).send(command(subscription));
    } catch (error2) {
      return publicError(request, reply, error2);
    }
  });
  options.app.get("/api/v1/subscriptions", async (request, reply) => {
    const callerValue = guard(request, reply);
    if (!callerValue) return;
    const recipientId = callerValue.actor;
    return reply.send(
      page2(
        [...subscriptions.values()].filter(
          (subscription) => subscription.recipientId === recipientId
        )
      )
    );
  });
  options.app.post(
    "/api/v1/subscriptions/unsubscribe",
    async (request, reply) => {
      const callerValue = guard(request, reply);
      if (!callerValue) return;
      const input = withIdentity(request, reply, callerValue);
      if (!input) return;
      const recipientId = callerValue.actor;
      const subscription = [...subscriptions.values()].find(
        (candidate) => candidate.recipientId === recipientId && candidate.topic === input.topic
      );
      if (!subscription) return reply.send(command({ removed: 0 }));
      const suspended = options.services.subscriptions.subscribe({
        id: subscription.id,
        name: subscription.name,
        recipientId: subscription.recipientId,
        topic: subscription.topic,
        classes: subscription.classes,
        cursor: subscription.cursor,
        manual: subscription.manual,
        status: "suspended"
      });
      subscriptions.set(suspended.id, suspended);
      return reply.send(command({ removed: 1 }));
    }
  );
  options.app.get(
    "/api/v1/subscriptions/:id/pending",
    async (request, reply) => {
      const callerValue = guard(request, reply);
      if (!callerValue) return;
      try {
        const pending = options.services.subscriptions.pending(
          request.params.id
        );
        if (!pending)
          return fail(
            request,
            reply,
            404,
            "subscription.not_found",
            "subscription was not found"
          );
        return reply.send(pending);
      } catch (error2) {
        return publicError(request, reply, error2);
      }
    }
  );
  options.app.post(
    "/api/v1/subscriptions/:id/commit",
    async (request, reply) => {
      const callerValue = guard(request, reply);
      if (!callerValue) return;
      const input = withIdentity(request, reply, callerValue);
      if (!input) return;
      try {
        return reply.send(
          command({
            committed: options.services.subscriptions.commit(
              request.params.id,
              Number(input.from_sequence),
              Number(input.to_sequence)
            )
          })
        );
      } catch (error2) {
        return publicError(request, reply, error2);
      }
    }
  );
}

// apps/control-plane/src/browser-settings-routes.ts
import { z as z20 } from "zod";
function jsonSchema(value2) {
  return z20.toJSONSchema(value2, {
    target: "draft-7",
    unrepresentable: "any",
    reused: "inline"
  });
}
function browserFail(request, reply, status, code) {
  return reply.code(status).send(
    BrowserSettingsErrorSchema.parse({
      schema_version: "golem.browser-settings-error/v1",
      code,
      correlation_id: request.id
    })
  );
}
function browserContext(request, reply, principal, action) {
  if (hasRequestAuthorityOverride(request)) {
    browserFail(request, reply, 403, "browser.forbidden");
    return void 0;
  }
  const context = principal.resolve(request, {
    action,
    allowBrowser: true,
    allowBearer: false
  });
  if (!context) {
    browserFail(request, reply, 401, "browser.auth.required");
    return void 0;
  }
  if (!principal.policy.allows(context, action)) {
    browserFail(request, reply, 403, "browser.forbidden");
    return void 0;
  }
  return context;
}
function settingsFailure(request, reply, error2) {
  if (error2 instanceof BrowserSettingsServiceError)
    return browserFail(request, reply, error2.httpStatus, error2.code);
  return browserFail(request, reply, 503, "browser.settings.unavailable");
}
function registerBrowserSettingsRoutes(options) {
  const errorResponses2 = {
    400: jsonSchema(BrowserSettingsErrorSchema),
    401: jsonSchema(BrowserSettingsErrorSchema),
    403: jsonSchema(BrowserSettingsErrorSchema),
    409: jsonSchema(BrowserSettingsErrorSchema),
    503: jsonSchema(BrowserSettingsErrorSchema)
  };
  options.app.get(
    "/api/v1/browser/settings",
    {
      schema: {
        response: {
          200: jsonSchema(BrowserSettingsSnapshotSchema),
          ...errorResponses2
        }
      }
    },
    async (request, reply) => {
      if (!browserContext(request, reply, options.principal, "read")) return;
      try {
        return reply.send(await options.settings.snapshot());
      } catch (error2) {
        return settingsFailure(request, reply, error2);
      }
    }
  );
  options.app.post(
    "/api/v1/browser/settings/commands",
    {
      schema: {
        response: {
          200: jsonSchema(BrowserSettingsCommandResponseSchema),
          ...errorResponses2
        }
      }
    },
    async (request, reply) => {
      if (!browserContext(request, reply, options.principal, "mutate")) return;
      const parsed = BrowserSettingsCommandRequestSchema.safeParse(
        request.body
      );
      if (!parsed.success)
        return browserFail(request, reply, 400, "browser.settings.invalid");
      try {
        return reply.send(await options.settings.command(parsed.data));
      } catch (error2) {
        return settingsFailure(request, reply, error2);
      }
    }
  );
}

// apps/control-plane/src/browser-work-routes.ts
import crypto19 from "node:crypto";

// packages/tracker/dist/types.js
var EnvelopeConflictError = class extends Error {
  reason;
  constructor(reason) {
    super(`delivery envelope conflicts with an existing ${reason}`);
    this.reason = reason;
    this.name = "EnvelopeConflictError";
  }
};
var BusEventConflictError = class extends Error {
  reason;
  constructor(reason) {
    super(`bus event conflicts with an existing ${reason}`);
    this.reason = reason;
    this.name = "BusEventConflictError";
  }
};

// packages/tracker/dist/validation.js
var isoTimestamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u;
var trackerValidationLimits = Object.freeze({
  maxIdentifierLength: 256,
  maxAttempts: 20,
  maxRetryDelayMs: 6e4,
  maxLeaseMs: 3e5,
  maxClaimLimit: 100,
  maxSubscriptionPendingLimit: 1e3,
  maxCursor: 1e9,
  maxDeadlineHorizonMs: 366 * 24 * 60 * 60 * 1e3,
  maxJsonDepth: 16,
  maxJsonBytes: 64 * 1024,
  maxDiagnosticCharacters: 1024
});
var TrackerValidationError = class extends Error {
  code;
  constructor(code, detail) {
    super(`tracker input invalid: ${detail}`);
    this.code = code;
    this.name = "TrackerValidationError";
  }
};
function invalid(code, detail) {
  throw new TrackerValidationError(code, detail);
}
function timestamp2(value2, label) {
  if (typeof value2 !== "string" || !isoTimestamp.test(value2))
    invalid("invalid_deadline", `${label} must be an ISO-8601 UTC timestamp`);
  const milliseconds = Date.parse(value2);
  if (!Number.isFinite(milliseconds))
    invalid("invalid_deadline", `${label} must be finite`);
  return milliseconds;
}
function positiveInteger(value2, maximum, code, label) {
  if (!Number.isInteger(value2) || value2 < 1 || value2 > maximum)
    invalid(code, `${label} must be an integer from 1 to ${maximum}`);
  return value2;
}
function requireIdentifier(value2, label) {
  if (typeof value2 !== "string" || value2.trim().length === 0 || value2.length > trackerValidationLimits.maxIdentifierLength)
    invalid("invalid_identifier", `${label} must be nonblank and at most ${trackerValidationLimits.maxIdentifierLength} characters`);
  return value2;
}
function requireDeadline(value2, clock) {
  const deadline = timestamp2(value2, "deadline");
  const now2 = timestamp2(clock.now(), "clock now");
  if (deadline <= now2 || deadline - now2 > trackerValidationLimits.maxDeadlineHorizonMs)
    invalid("invalid_deadline", "deadline must be future and within the supported horizon");
  return value2;
}
function requireMaxAttempts(value2) {
  return positiveInteger(value2, trackerValidationLimits.maxAttempts, "invalid_max_attempts", "max attempts");
}
function requireRetryDelay(value2) {
  return positiveInteger(value2, trackerValidationLimits.maxRetryDelayMs, "invalid_retry_delay", "retry delay");
}
function requireClaimLimit(value2) {
  return positiveInteger(value2, trackerValidationLimits.maxClaimLimit, "invalid_claim_limit", "claim limit");
}
function requireSubscriptionPendingLimit(value2) {
  return positiveInteger(value2, trackerValidationLimits.maxSubscriptionPendingLimit, "invalid_claim_limit", "subscription pending limit");
}
function requireLease(value2) {
  return positiveInteger(value2, trackerValidationLimits.maxLeaseMs, "invalid_lease", "lease");
}
function requireCursor(value2, label = "cursor") {
  if (!Number.isInteger(value2) || value2 < 0 || value2 > trackerValidationLimits.maxCursor)
    invalid("invalid_cursor", `${label} must be an integer from 0 to ${trackerValidationLimits.maxCursor}`);
  return value2;
}
function requireCursorRange(from, to) {
  const fromSequence = requireCursor(from, "from sequence");
  const toSequence = requireCursor(to, "to sequence");
  if (toSequence < fromSequence)
    invalid("invalid_range", "to sequence cannot precede from sequence");
}
function requireSubscriptionClasses(value2) {
  if (!Array.isArray(value2) || value2.length === 0)
    invalid("invalid_subscription_class", "subscription requires event classes");
  const classes = value2;
  const allowed = /* @__PURE__ */ new Set([
    "tracker",
    "lifecycle",
    "custom"
  ]);
  if (classes.some((entry2) => typeof entry2 !== "string" || !allowed.has(entry2)) || new Set(classes).size !== classes.length)
    invalid("invalid_subscription_class", "subscription classes must be unique tracker, lifecycle, or custom values");
  return Object.freeze([...classes]);
}
function requireSubscriptionStatus(value2) {
  if (value2 !== "active" && value2 !== "offline" && value2 !== "suspended")
    invalid("invalid_subscription_status", "subscription status is unsupported");
}
function inspectJson(value2, depth, ancestors) {
  if (depth > trackerValidationLimits.maxJsonDepth)
    invalid("invalid_json", "JSON depth exceeds the supported limit");
  if (value2 === null || typeof value2 === "string" || typeof value2 === "boolean")
    return;
  if (typeof value2 === "number") {
    if (!Number.isFinite(value2))
      invalid("invalid_json", "JSON numbers must be finite");
    return;
  }
  if (typeof value2 !== "object")
    invalid("invalid_json", "JSON contains a non-serializable value");
  if (ancestors.has(value2))
    invalid("invalid_json", "JSON cannot contain cycles");
  if (Array.isArray(value2)) {
    ancestors.add(value2);
    for (const entry2 of value2)
      inspectJson(entry2, depth + 1, ancestors);
    ancestors.delete(value2);
    return;
  }
  const prototype = Object.getPrototypeOf(value2);
  if (prototype !== Object.prototype && prototype !== null)
    invalid("invalid_json", "JSON objects must be plain records");
  ancestors.add(value2);
  for (const entry2 of Object.values(value2))
    inspectJson(entry2, depth + 1, ancestors);
  ancestors.delete(value2);
}
function utf8ByteLength(value2) {
  let length = 0;
  for (const character of value2) {
    const codePoint = character.codePointAt(0) ?? 0;
    length += codePoint <= 127 ? 1 : codePoint <= 2047 ? 2 : codePoint <= 65535 ? 3 : 4;
  }
  return length;
}
function requireJsonObject(value2, label) {
  if (value2 === null || typeof value2 !== "object" || Array.isArray(value2))
    invalid("invalid_json", `${label} must be a JSON object`);
  inspectJson(value2, 0, /* @__PURE__ */ new Set());
  let serialized;
  try {
    serialized = JSON.stringify(value2);
  } catch {
    invalid("invalid_json", `${label} cannot be serialized`);
  }
  if (utf8ByteLength(serialized) > trackerValidationLimits.maxJsonBytes)
    invalid("invalid_json", `${label} exceeds the serialized byte limit`);
}
function requireBusClass(value2) {
  if (value2 !== "tracker" && value2 !== "lifecycle" && value2 !== "custom")
    invalid("invalid_subscription_class", "bus event class is unsupported");
}
function requireTimestamp(value2, label) {
  timestamp2(value2, label);
  return value2;
}
function sanitizeDiagnostic(value2) {
  if (typeof value2 !== "string" || value2.trim().length === 0)
    invalid("invalid_diagnostic", "delivery diagnostic must be nonblank text");
  return value2.replace(/\bBearer\s+[A-Za-z0-9._-]+/giu, "Bearer [REDACTED]").replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY))=\S+/gu, "$1=[REDACTED]").replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED]@").replace(/(?:^|\s)(?:~\/|\/)[^\s]+/gu, " [REDACTED_PATH]").slice(0, trackerValidationLimits.maxDiagnosticCharacters);
}

// packages/tracker/dist/bus.js
function fingerprint(value2) {
  if (value2 === null || typeof value2 !== "object")
    return JSON.stringify(value2);
  if (Array.isArray(value2))
    return `[${value2.map(fingerprint).join(",")}]`;
  const object2 = value2;
  return `{${Object.keys(object2).sort().map((key) => `${JSON.stringify(key)}:${fingerprint(object2[key])}`).join(",")}}`;
}
function createDurableBusService(options) {
  const service = {
    append(input) {
      requireIdentifier(input.id, "bus event id");
      requireIdentifier(input.deduplicationKey, "bus deduplication key");
      requireIdentifier(input.topic, "bus topic");
      requireBusClass(input.class);
      requireJsonObject(input.payload, "bus payload");
      const event = Object.freeze({
        id: input.id,
        projectId: input.projectId ?? "system",
        deduplicationKey: input.deduplicationKey,
        topic: input.topic,
        class: input.class,
        payload: Object.freeze({ ...input.payload }),
        createdAt: options.clock.now()
      });
      const result2 = options.storage.appendBusEvent({
        event,
        fingerprint: fingerprint({
          deduplicationKey: input.deduplicationKey,
          topic: input.topic,
          class: input.class,
          payload: input.payload
        })
      });
      if (result2.kind === "conflict")
        throw new BusEventConflictError(result2.reason);
      return result2.event;
    }
  };
  return Object.freeze(service);
}

// packages/tracker/dist/phases/machine.js
var workItemMachine = Object.freeze({
  initial: "queued",
  phases: [
    "queued",
    "building",
    "blocked",
    "built",
    "verifying",
    "verified",
    "rejected",
    "done"
  ],
  transitions: {
    queued: ["building", "blocked"],
    building: ["built", "blocked"],
    blocked: ["building"],
    built: ["verifying", "done"],
    verifying: ["verified", "rejected"],
    verified: ["done"],
    rejected: ["building"],
    done: []
  },
  canonical: {
    queued: "todo",
    building: "in_progress",
    blocked: "blocked",
    built: "review",
    verifying: "review",
    verified: "review",
    rejected: "in_progress",
    done: "done"
  },
  requirements: {
    blocked: ["reason"],
    built: ["closingBrief"],
    verifying: ["managerDispatch"],
    verified: ["verificationReport"],
    rejected: ["verificationReport"],
    done: ["verifiedOrSkipReason"]
  }
});
var specMachine = Object.freeze({
  initial: "drafting",
  phases: [
    "drafting",
    "grounding",
    "grounded",
    "designing",
    "designed",
    "planning",
    "planned",
    "building",
    "done",
    "parked"
  ],
  transitions: {
    drafting: ["grounding", "parked"],
    grounding: ["grounded", "parked"],
    grounded: ["designing", "parked"],
    designing: ["designed", "grounding", "parked"],
    designed: ["planning", "parked"],
    planning: ["planned", "designing", "parked"],
    planned: ["building", "parked"],
    building: ["done", "parked"],
    parked: ["drafting", "grounding", "designing", "planning", "building"],
    done: []
  },
  canonical: {
    drafting: "todo",
    grounding: "in_progress",
    grounded: "in_progress",
    designing: "in_progress",
    designed: "review",
    planning: "in_progress",
    planned: "in_progress",
    building: "in_progress",
    done: "done",
    parked: "blocked"
  },
  requirements: {
    grounded: ["groundingSummary"],
    designed: ["design", "concerns"],
    planning: ["humanFinalise"],
    planned: ["children", "waves"],
    building: ["childStarted"],
    done: ["childrenTerminal"],
    parked: ["reason"]
  }
});
var questionMachine = Object.freeze({
  initial: "open",
  phases: ["open", "answered", "closed"],
  transitions: { open: ["answered"], answered: ["closed"], closed: [] },
  canonical: { open: "todo", answered: "review", closed: "done" },
  requirements: { answered: ["answerComment"] }
});
var decisionMachine = Object.freeze({
  initial: "open",
  phases: ["open", "decided", "closed"],
  transitions: { open: ["decided"], decided: ["closed"], closed: [] },
  canonical: { open: "todo", decided: "review", closed: "done" },
  requirements: { decided: ["decisionComment"] }
});
function machineFor(kind) {
  if (kind === "spec")
    return specMachine;
  if (kind === "question")
    return questionMachine;
  if (kind === "decision")
    return decisionMachine;
  return workItemMachine;
}
function provided(value2) {
  if (typeof value2 === "string")
    return value2.trim().length > 0;
  if (Array.isArray(value2))
    return value2.length > 0;
  return value2 === true || typeof value2 === "object" && value2 !== null;
}
var TrackerPhaseError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "TrackerPhaseError";
  }
};
function initialTrackerPhase(kind) {
  return machineFor(kind).initial;
}
function candidateTrackerPhaseTransitions(kind, phase) {
  return Object.freeze([...machineFor(kind).transitions[phase] ?? []]);
}
function canonicalTrackerState(kind, phase) {
  const state = machineFor(kind).canonical[phase];
  if (!state)
    throw new TrackerPhaseError("phase_unknown", `phase ${phase} is not defined for ${kind}`);
  return state;
}
function validateTrackerPhaseTransition(input) {
  const machine = machineFor(input.kind);
  if (!machine.phases.includes(input.to))
    throw new TrackerPhaseError("phase_unknown", `phase ${input.to} is not defined for ${input.kind}`);
  if (!machine.transitions[input.from]?.includes(input.to))
    throw new TrackerPhaseError("phase_illegal", `cannot transition ${input.kind} from ${input.from} to ${input.to}`);
  for (const requirement of machine.requirements[input.to] ?? []) {
    if (!provided(input.artifacts[requirement]))
      throw new TrackerPhaseError("phase_artifact_missing", `phase ${input.to} requires ${requirement}`);
  }
  return canonicalTrackerState(input.kind, input.to);
}

// packages/tracker/dist/tickets/service.js
var workItemKinds = /* @__PURE__ */ new Set([
  "spec",
  "work-item",
  "question",
  "decision",
  "fix"
]);
var priorities = /* @__PURE__ */ new Set(["P0", "P1", "P2", "P3", null]);
var TrackerCoreError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "TrackerCoreError";
  }
};
function invalid2(message) {
  throw new TrackerCoreError("tracker.input.invalid", message);
}
function requireTrackerText(value2, field2) {
  if (typeof value2 !== "string" || value2.trim().length === 0 || value2.length > 4096)
    invalid2(`${field2} must be nonblank text up to 4096 characters`);
  return value2.trim();
}
function requireTrackerActor(value2) {
  return requireTrackerText(value2, "actor");
}
function requireRevision(value2) {
  if (!Number.isSafeInteger(value2) || value2 < 1)
    invalid2("expected revision must be a positive safe integer");
  return value2;
}
function requireRank(value2) {
  if (typeof value2 !== "number" || !Number.isFinite(value2))
    invalid2("rank must be finite");
  return value2;
}
function requireWave(value2) {
  if (value2 === void 0)
    return void 0;
  if (!Number.isSafeInteger(value2) || value2 < 0)
    invalid2("wave must be a nonnegative safe integer");
  return value2;
}
function requireLabels(value2) {
  if (value2 === void 0)
    return [];
  if (!Array.isArray(value2))
    invalid2("labels must be an array");
  const labels = value2.map((label) => requireTrackerText(label, "label"));
  if (new Set(labels).size !== labels.length)
    invalid2("labels must be unique");
  return Object.freeze(labels);
}
function requireKind(value2) {
  if (typeof value2 !== "string" || !workItemKinds.has(value2))
    invalid2("ticket kind is unsupported");
  return value2;
}
function requirePriority(value2) {
  if (value2 === void 0 || value2 === null)
    return null;
  if (typeof value2 !== "string" || !priorities.has(value2))
    invalid2("ticket priority is unsupported");
  return value2;
}
function phaseForLegacyState(kind, state, currentPhase) {
  if (state === "archived")
    return kind === "spec" ? "done" : kind === "question" || kind === "decision" ? "closed" : "done";
  const preferred = {
    spec: {
      todo: "drafting",
      in_progress: "designing",
      blocked: "parked",
      review: "designed",
      done: "done"
    },
    "work-item": {
      todo: "queued",
      in_progress: "building",
      blocked: "blocked",
      review: "built",
      done: "done"
    },
    fix: {
      todo: "queued",
      in_progress: "building",
      blocked: "blocked",
      review: "built",
      done: "done"
    },
    question: {
      todo: "open",
      in_progress: "open",
      blocked: "open",
      review: "answered",
      done: "closed"
    },
    decision: {
      todo: "open",
      in_progress: "open",
      blocked: "open",
      review: "decided",
      done: "closed"
    }
  };
  return preferred[kind][state] ?? currentPhase;
}
function runtimeReference(value2) {
  if (value2 === void 0)
    return void 0;
  if (!value2 || typeof value2 !== "object" || Array.isArray(value2))
    throw new TrackerCoreError("tracker.runtime_reference.invalid", "runtime reference must be a typed opaque reference");
  const candidate = value2;
  if (!ProjectIdSchema.safeParse(candidate.projectId).success)
    throw new TrackerCoreError("tracker.runtime_reference.invalid", "runtime project reference must be an opaque prj_ id");
  if (candidate.sessionId !== void 0 && !SessionIdSchema.safeParse(candidate.sessionId).success)
    throw new TrackerCoreError("tracker.runtime_reference.invalid", "runtime session reference must be an opaque ses_ id");
  if (candidate.generationId !== void 0 && !GenerationIdSchema.safeParse(candidate.generationId).success)
    throw new TrackerCoreError("tracker.runtime_reference.invalid", "runtime generation reference must be an opaque gen_ id");
  return Object.freeze({
    projectId: candidate.projectId,
    ...candidate.sessionId === void 0 ? {} : { sessionId: candidate.sessionId },
    ...candidate.generationId === void 0 ? {} : { generationId: candidate.generationId }
  });
}
function requireTrustedAuthority(value2) {
  if (!value2 || typeof value2 !== "object" || Array.isArray(value2))
    throw new TrackerCoreError("tracker.phase.invalid", "exceptional close requires an authenticated manager or human authority");
  const context = value2;
  if (context.authenticated !== true || context.role !== "manager" && context.role !== "human" || context.source !== "dashboard" && context.source !== "mcp" && context.source !== "journey" || typeof context.actor !== "string" || context.actor.trim().length === 0)
    throw new TrackerCoreError("tracker.phase.invalid", "exceptional close requires an authenticated manager or human authority");
  return Object.freeze({
    actor: context.actor.trim(),
    role: context.role,
    authenticated: true,
    source: context.source
  });
}
function requireExceptionalClose(value2) {
  if (!value2 || typeof value2 !== "object" || Array.isArray(value2))
    throw new TrackerCoreError("tracker.phase.invalid", "exceptional close requires an authenticated manager or human authority");
  const candidate = value2;
  const reason = requireTrackerText(candidate.reason, "exceptional close reason");
  return Object.freeze({
    reason,
    actorContext: requireTrustedAuthority(candidate.actorContext)
  });
}
function createTrackerMutation(clock, actor3) {
  return Object.freeze({
    actor: actor3,
    eventId: `evt_${globalThis.crypto.randomUUID()}`,
    outboxId: `out_${globalThis.crypto.randomUUID()}`,
    auditId: `aud_${globalThis.crypto.randomUUID()}`,
    now: clock.now()
  });
}
function createTrackerTicketService(options) {
  function requireTicket(id2) {
    const ticket = options.storage.getWorkItem(requireTrackerText(id2, "ticket id"));
    if (!ticket)
      throw new TrackerCoreError("tracker.not_found", `ticket ${id2} does not exist`);
    return ticket;
  }
  const service = {
    create(input) {
      const kind = requireKind(input.kind ?? "work-item");
      const actor3 = requireTrackerActor(input.actor);
      const projectId2 = requireTrackerText(input.projectId, "project id");
      const parentId = input.parentId === void 0 ? void 0 : requireTrackerText(input.parentId, "parent id");
      if (parentId && !options.storage.getWorkItem(parentId))
        throw new TrackerCoreError("tracker.not_found", `parent ticket ${parentId} does not exist`);
      const now2 = options.clock.now();
      const wave = input.wave === void 0 ? void 0 : requireWave(input.wave);
      if (input.runtimeReference !== void 0)
        runtimeReference(input.runtimeReference);
      const item = Object.freeze({
        // The persistence repository atomically allocates the live TKT id and
        // per-project display id; services never maintain a second sequence.
        id: "pending",
        displayId: "pending",
        projectId: projectId2,
        kind,
        title: requireTrackerText(input.title, "title"),
        body: input.body ?? "",
        priority: requirePriority(input.priority),
        labels: requireLabels(input.labels),
        ...input.streamId === void 0 ? {} : { streamId: requireTrackerText(input.streamId, "stream id") },
        ...parentId ? { parentId } : {},
        ...input.assignee === void 0 ? {} : { assignee: requireTrackerText(input.assignee, "assignee") },
        state: canonicalTrackerState(kind, initialTrackerPhase(kind)),
        phase: initialTrackerPhase(kind),
        rank: input.rank === void 0 ? 0 : requireRank(input.rank),
        ...wave === void 0 ? {} : { wave },
        revision: 1,
        createdBy: actor3,
        createdAt: now2,
        updatedAt: now2
      });
      return options.storage.createWorkItem({
        workItem: item,
        mutation: createTrackerMutation(options.clock, actor3)
      });
    },
    get(id2) {
      const ticket = options.storage.getWorkItem(requireTrackerText(id2, "ticket id"));
      if (!ticket)
        return void 0;
      return Object.freeze({
        ticket,
        comments: options.storage.listComments(ticket.id),
        links: options.storage.listLinks(ticket.id)
      });
    },
    list(input = {}) {
      return options.storage.listWorkItems(input);
    },
    legalTransitions(id2) {
      const ticket = requireTicket(id2);
      const evidence = options.storage.phaseEvidence(ticket.id);
      const artifacts = Object.freeze({
        ...evidence,
        // A browser can supply a reason with a blocked/parked request. All
        // other evidence remains durable and server-owned.
        reason: true,
        verifiedOrSkipReason: ticket.phase === "verified" || evidence.managerSkip
      });
      return Object.freeze(candidateTrackerPhaseTransitions(ticket.kind, ticket.phase).filter((phase) => {
        try {
          validateTrackerPhaseTransition({
            kind: ticket.kind,
            from: ticket.phase,
            to: phase,
            artifacts
          });
          return true;
        } catch (error2) {
          if (error2 instanceof TrackerPhaseError)
            return false;
          throw error2;
        }
      }));
    },
    search(query, projectId2) {
      return options.storage.searchWorkItems(requireTrackerText(query, "search query"), projectId2);
    },
    update(input) {
      const exceptionalClose = input.exceptionalClose ? requireExceptionalClose(input.exceptionalClose) : void 0;
      const actor3 = exceptionalClose ? exceptionalClose.actorContext.actor : requireTrackerActor(input.actor);
      const expectedRevision3 = requireRevision(input.expectedRevision);
      const current = requireTicket(input.id);
      const patch = {};
      if (input.patch.kind !== void 0)
        patch.kind = requireKind(input.patch.kind);
      if (input.patch.state !== void 0) {
        if (![
          "todo",
          "in_progress",
          "blocked",
          "review",
          "done",
          "archived"
        ].includes(input.patch.state))
          invalid2("ticket state is unsupported");
        patch.state = input.patch.state;
      }
      if (input.patch.phase !== void 0)
        patch.phase = requireTrackerText(input.patch.phase, "phase");
      if (input.patch.title !== void 0)
        patch.title = requireTrackerText(input.patch.title, "title");
      if (input.patch.body !== void 0)
        patch.body = input.patch.body;
      if (input.patch.priority !== void 0)
        patch.priority = requirePriority(input.patch.priority);
      if (input.patch.labels !== void 0)
        patch.labels = requireLabels(input.patch.labels);
      if (input.patch.streamId !== void 0)
        patch.streamId = requireTrackerText(input.patch.streamId, "stream id");
      if (input.patch.parentId !== void 0)
        patch.parentId = requireTrackerText(input.patch.parentId, "parent id");
      if (input.patch.assignee !== void 0)
        patch.assignee = requireTrackerText(input.patch.assignee, "assignee");
      if (input.patch.rank !== void 0)
        patch.rank = requireRank(input.patch.rank);
      if (input.patch.wave !== void 0) {
        const wave = requireWave(input.patch.wave);
        if (wave !== void 0)
          patch.wave = wave;
      }
      if (input.patch.runtimeReference !== void 0)
        runtimeReference(input.patch.runtimeReference);
      const patchKind = patch.kind ?? current.kind;
      if (patch.state !== void 0 && patch.phase === void 0)
        patch.phase = phaseForLegacyState(patchKind, patch.state, current.phase);
      const nextKind = patch.kind ?? current.kind;
      const nextPhase = patch.phase ?? current.phase;
      const lifecycleChanged = nextKind !== current.kind || nextPhase !== current.phase || patch.state !== void 0;
      if (exceptionalClose && nextPhase !== "done")
        throw new TrackerCoreError("tracker.phase.invalid", "exceptional close must target the done phase");
      if (lifecycleChanged) {
        const durableEvidence = options.storage.phaseEvidence(current.id);
        const artifacts = Object.freeze({
          ...durableEvidence,
          // Caller text is never completion evidence; only this typed intent or
          // an already persisted authorization event can satisfy done.
          verifiedOrSkipReason: current.phase === "verified" || durableEvidence.managerSkip || Boolean(exceptionalClose),
          reason: durableEvidence.reason || nextPhase === "blocked" && typeof input.reason === "string" && input.reason.trim().length > 0
        });
        try {
          const canonicalState = patch.state === "archived" ? "archived" : canonicalTrackerState(nextKind, nextPhase);
          if (patch.state !== "archived" && nextKind === current.kind && nextPhase !== current.phase) {
            validateTrackerPhaseTransition({
              kind: nextKind,
              from: current.phase,
              to: nextPhase,
              artifacts
            });
          }
          patch.state = canonicalState;
        } catch (error2) {
          if (error2 instanceof TrackerPhaseError)
            throw new TrackerCoreError("tracker.phase.invalid", error2.message);
          throw error2;
        }
      }
      const updated = options.storage.updateWorkItem({
        id: requireTrackerText(input.id, "ticket id"),
        expectedRevision: expectedRevision3,
        patch,
        mutation: createTrackerMutation(options.clock, actor3),
        ...exceptionalClose ? { exceptionalClose } : {}
      });
      if (!updated)
        throw new TrackerCoreError("tracker.conflict", "ticket revision is stale or ticket does not exist");
      return updated;
    },
    recordDispatch(input) {
      const updated = options.storage.recordWorkItemDispatch({
        id: requireTrackerText(input.id, "ticket id"),
        expectedRevision: requireRevision(input.expectedRevision),
        dispatchedTo: requireTrackerText(input.dispatchedTo, "dispatch recipient"),
        ...input.assignee === void 0 ? {} : { assignee: requireTrackerText(input.assignee, "assignee") },
        mutation: createTrackerMutation(options.clock, requireTrackerActor(input.actor))
      });
      if (!updated)
        throw new TrackerCoreError("tracker.conflict", "ticket revision is stale or ticket does not exist");
      return updated;
    },
    transition(input) {
      return service.update({
        id: input.id,
        expectedRevision: input.expectedRevision,
        patch: { phase: input.phase },
        ...input.reason === void 0 ? {} : { reason: input.reason },
        actor: input.actor
      });
    },
    exceptionalClose(input) {
      const actorContext2 = requireTrustedAuthority(input.actorContext);
      return service.update({
        id: input.id,
        expectedRevision: input.expectedRevision,
        patch: { phase: "done", state: "done" },
        reason: input.reason,
        exceptionalClose: {
          reason: input.reason,
          actorContext: actorContext2
        },
        actor: actorContext2.actor
      });
    }
  };
  return Object.freeze(service);
}

// packages/tracker/dist/comments/service.js
function anchor(value2) {
  if (value2 === void 0)
    return void 0;
  if (!value2 || typeof value2 !== "object" || Array.isArray(value2))
    throw new TrackerCoreError("tracker.input.invalid", "comment anchor must be an object");
  return Object.freeze({ ...value2 });
}
function createTrackerCommentService(options) {
  function add(input) {
    const ticketId = requireTrackerText(input.ticketId, "ticket id");
    if (!options.storage.getWorkItem(ticketId))
      throw new TrackerCoreError("tracker.not_found", `ticket ${ticketId} does not exist`);
    const parentId = input.parentId === void 0 ? void 0 : requireTrackerText(input.parentId, "parent comment id");
    if (parentId) {
      const parent = options.storage.getComment(parentId);
      if (!parent || parent.ticketId !== ticketId)
        throw new TrackerCoreError("tracker.not_found", "comment parent does not belong to this ticket");
    }
    const now2 = options.clock.now();
    const author = requireTrackerActor(input.author);
    const commentAnchor = input.anchor === void 0 ? void 0 : anchor(input.anchor);
    const comment = Object.freeze({
      id: `cmt_${globalThis.crypto.randomUUID()}`,
      ticketId,
      ...parentId ? { parentId } : {},
      author,
      body: requireTrackerText(input.body, "comment body"),
      ...commentAnchor === void 0 ? {} : { anchor: commentAnchor },
      tag: input.tag === void 0 ? "note" : requireTrackerText(input.tag, "comment tag"),
      status: input.status === void 0 ? "open" : requireTrackerText(input.status, "comment status"),
      dispatchState: input.dispatchState === void 0 ? "undispatched" : requireTrackerText(input.dispatchState, "comment dispatch state"),
      revision: 1,
      createdAt: now2,
      updatedAt: now2
    });
    return options.storage.createComment({
      comment,
      mutation: createTrackerMutation(options.clock, author)
    });
  }
  const service = {
    add,
    update(input) {
      const actor3 = requireTrackerActor(input.actor);
      const patch = {
        ...input.patch.body === void 0 ? {} : { body: requireTrackerText(input.patch.body, "comment body") },
        ...input.patch.tag === void 0 ? {} : { tag: requireTrackerText(input.patch.tag, "comment tag") },
        ...input.patch.status === void 0 ? {} : {
          status: requireTrackerText(input.patch.status, "comment status")
        },
        ...input.patch.dispatchState === void 0 ? {} : {
          dispatchState: requireTrackerText(input.patch.dispatchState, "comment dispatch state")
        }
      };
      const updated = options.storage.updateComment({
        ticketId: requireTrackerText(input.ticketId, "ticket id"),
        commentId: requireTrackerText(input.commentId, "comment id"),
        patch,
        mutation: createTrackerMutation(options.clock, actor3)
      });
      if (!updated)
        throw new TrackerCoreError("tracker.not_found", "comment does not exist");
      return updated;
    },
    reply(input) {
      return add(input);
    }
  };
  return Object.freeze(service);
}

// packages/tracker/dist/compat.js
function legacyTicket(ticket) {
  return Object.freeze({
    id: ticket.id,
    display_id: ticket.displayId,
    project_id: ticket.projectId,
    kind: ticket.kind,
    title: ticket.title,
    body: ticket.body,
    priority: ticket.priority,
    labels: ticket.labels,
    stream_id: ticket.streamId ?? null,
    parent_id: ticket.parentId ?? null,
    assignee: ticket.assignee ?? null,
    dispatched_to: ticket.dispatchedTo ?? null,
    dispatched_at: ticket.dispatchedAt ?? null,
    state: ticket.state,
    phase: ticket.phase,
    rank: ticket.rank,
    wave: ticket.wave ?? null,
    revision: ticket.revision,
    created_by: ticket.createdBy,
    created_at: ticket.createdAt,
    updated_at: ticket.updatedAt
  });
}
function legacyComment(comment) {
  const anchor2 = comment.anchor ?? {};
  return Object.freeze({
    id: comment.id,
    ticket_id: comment.ticketId,
    parent_id: comment.parentId ?? null,
    author: comment.author,
    body: comment.body,
    quote: anchor2.quote ?? null,
    prefix: anchor2.prefix ?? null,
    suffix: anchor2.suffix ?? null,
    section: anchor2.section ?? null,
    section_id: anchor2.sectionId ?? null,
    tag: comment.tag,
    status: comment.status,
    dispatch_state: comment.dispatchState,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt
  });
}
function legacyLink(link) {
  return Object.freeze({
    from_ticket: link.ticketId,
    to_ticket: link.targetTicketId,
    type: link.relation
  });
}
function legacyStream(stream) {
  return Object.freeze({
    id: stream.id,
    project_id: stream.projectId,
    name: stream.name,
    mode: stream.mode,
    description: stream.description,
    revision: stream.revision,
    created_at: stream.createdAt,
    updated_at: stream.updatedAt
  });
}
function createTrackerCompatibilityFacade(services, options = {}) {
  const facade = {
    createTicket: (input) => legacyTicket(services.tickets.create(input)),
    getTicket(id2) {
      const detail = services.tickets.get(id2);
      if (!detail)
        return void 0;
      return Object.freeze({
        ...legacyTicket(detail.ticket),
        comments: Object.freeze(detail.comments.map(legacyComment)),
        links: Object.freeze(detail.links.map(legacyLink))
      });
    },
    listTickets: (input) => Object.freeze(services.tickets.list(input).map(legacyTicket)),
    searchTickets: (query, projectId2) => Object.freeze(services.tickets.search(query, projectId2).map(legacyTicket)),
    updateTicket: (input) => legacyTicket(services.tickets.update(input)),
    transitionTicket: (input) => legacyTicket(services.tickets.transition(input)),
    exceptionalCloseTicket: (input) => {
      const context = options.trustedExceptionalCloseContext;
      if (!context)
        throw new TrackerCoreError("tracker.phase.invalid", "exceptional close requires a verified authenticated authority");
      const keys = Object.keys(input);
      if (keys.some((key) => !["id", "expectedRevision", "reason"].includes(key)))
        throw new TrackerCoreError("tracker.phase.invalid", "exceptional close authority is server-owned");
      if (typeof input.id !== "string" || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || typeof input.reason !== "string" || input.reason.trim().length === 0)
        throw new TrackerCoreError("tracker.phase.invalid", "exceptional close requires id, expected revision, and reason");
      return legacyTicket(services.tickets.exceptionalClose({
        id: input.id,
        expectedRevision: input.expectedRevision,
        reason: input.reason,
        actorContext: context
      }));
    },
    addComment: (input) => legacyComment(services.comments.add(input)),
    updateComment: (input) => legacyComment(services.comments.update(input)),
    replyComment: (input) => legacyComment(services.comments.reply(input)),
    linkTicket: (input) => legacyLink(services.links.create(input)),
    deleteLink: (input) => Object.freeze({ removed: services.links.delete(input) ? 1 : 0 }),
    upsertStream: (input) => legacyStream(services.streams.upsert(input)),
    listStreams: (projectId2) => Object.freeze(services.streams.list(projectId2).map(legacyStream))
  };
  return Object.freeze(facade);
}

// packages/tracker/dist/links/service.js
var relations = /* @__PURE__ */ new Set([
  "blocks",
  "relates",
  "duplicates"
]);
function createTrackerLinkService(options) {
  const service = {
    create(input) {
      const ticketId = requireTrackerText(input.ticketId, "ticket id");
      const targetTicketId = requireTrackerText(input.targetTicketId, "linked ticket id");
      if (ticketId === targetTicketId)
        throw new TrackerCoreError("tracker.input.invalid", "a ticket cannot link to itself");
      if (!options.storage.getWorkItem(ticketId) || !options.storage.getWorkItem(targetTicketId))
        throw new TrackerCoreError("tracker.not_found", "linked ticket does not exist");
      if (!relations.has(input.relation))
        throw new TrackerCoreError("tracker.input.invalid", "link relation is unsupported");
      const actor3 = requireTrackerActor(input.actor);
      const link = Object.freeze({
        id: `lnk_${globalThis.crypto.randomUUID()}`,
        ticketId,
        targetTicketId,
        relation: input.relation,
        actor: actor3,
        createdAt: options.clock.now()
      });
      return options.storage.createLink({
        link,
        mutation: createTrackerMutation(options.clock, actor3)
      });
    },
    delete(input) {
      const ticketId = requireTrackerText(input.ticketId, "ticket id");
      const targetTicketId = requireTrackerText(input.targetTicketId, "linked ticket id");
      if (!relations.has(input.relation))
        throw new TrackerCoreError("tracker.input.invalid", "link relation is unsupported");
      const actor3 = requireTrackerActor(input.actor);
      return options.storage.deleteLink({
        ticketId,
        targetTicketId,
        relation: input.relation,
        mutation: createTrackerMutation(options.clock, actor3)
      });
    }
  };
  return Object.freeze(service);
}

// packages/tracker/dist/streams/service.js
function createTrackerStreamService(options) {
  const service = {
    upsert(input) {
      if (input.mode !== void 0 && input.mode !== "sequential" && input.mode !== "parallel")
        throw new TrackerCoreError("tracker.input.invalid", "stream mode is unsupported");
      if (input.expectedRevision !== void 0 && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1))
        throw new TrackerCoreError("tracker.input.invalid", "stream revision must be a positive safe integer");
      const now2 = options.clock.now();
      const actor3 = requireTrackerActor(input.actor);
      const stream = Object.freeze({
        id: input.id === void 0 ? `str_${globalThis.crypto.randomUUID()}` : requireTrackerText(input.id, "stream id"),
        projectId: requireTrackerText(input.projectId, "project id"),
        name: requireTrackerText(input.name, "stream name"),
        mode: input.mode ?? "parallel",
        description: input.description ?? "",
        revision: 1,
        createdAt: now2,
        updatedAt: now2
      });
      const persisted = options.storage.upsertStream({
        stream,
        ...input.expectedRevision === void 0 ? {} : { expectedRevision: input.expectedRevision },
        mutation: createTrackerMutation(options.clock, actor3)
      });
      if (!persisted)
        throw new TrackerCoreError("tracker.conflict", "stream revision is stale");
      return persisted;
    },
    list(projectId2) {
      return options.storage.listStreams(projectId2);
    }
  };
  return Object.freeze(service);
}

// packages/tracker/dist/core.js
function createTrackerCoreServices(options) {
  const tickets = createTrackerTicketService(options);
  const services = Object.freeze({
    tickets,
    comments: createTrackerCommentService(options),
    links: createTrackerLinkService(options),
    streams: createTrackerStreamService(options)
  });
  return Object.freeze({
    ...services,
    compatibility: createTrackerCompatibilityFacade(services, options.trustedExceptionalCloseContext === void 0 ? {} : {
      trustedExceptionalCloseContext: options.trustedExceptionalCloseContext
    })
  });
}

// packages/tracker/dist/delivery.js
var defaultLeaseMs = 3e4;
var defaultMaxAttempts2 = 5;
function canonicalJson2(value2) {
  if (value2 === null || typeof value2 !== "object")
    return JSON.stringify(value2);
  if (Array.isArray(value2))
    return `[${value2.map(canonicalJson2).join(",")}]`;
  const object2 = value2;
  return `{${Object.keys(object2).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson2(object2[key])}`).join(",")}}`;
}
function cloneEndpoint(endpoint3) {
  return Object.freeze({
    ...endpoint3,
    capabilities: Object.freeze(endpoint3.capabilities.map((capability3) => ({ ...capability3 })))
  });
}
function queueable(endpoint3) {
  if (endpoint3?.readiness !== "ready" && endpoint3?.readiness !== "pull_only" && endpoint3?.readiness !== "next_turn")
    return false;
  return endpoint3.capabilities.some((capability3) => capability3.capability === "delivery" && (capability3.qualification === "supported" || capability3.qualification === "experimental"));
}
function endpointMatches(stored, current) {
  return Boolean(current && current.endpointId === stored.endpointId && current.generationId === stored.generationId && current.ownerFence === stored.ownerFence && current.readiness === stored.readiness && current.mode === stored.mode && queueable(current));
}
function retryAfter(attempts) {
  return Math.min(6e4, 1e3 * 2 ** Math.max(0, attempts - 1));
}
function createDurableDeliveryService(options) {
  function enqueue(input) {
    requireIdentifier(input.id, "delivery id");
    requireIdentifier(input.idempotencyKey, "delivery idempotency key");
    requireIdentifier(input.senderId, "delivery sender");
    requireIdentifier(input.recipientId, "delivery recipient");
    requireIdentifier(input.kind, "delivery kind");
    if (input.replyToRecipientId !== void 0)
      requireIdentifier(input.replyToRecipientId, "delivery reply recipient");
    requireJsonObject(input.payload, "delivery payload");
    const endpoint3 = options.eligibility.resolve(input.eligibilityRecipientId ?? input.recipientId);
    if (!queueable(endpoint3))
      throw new Error("delivery endpoint is not eligible for a new envelope");
    const maxAttempts = input.maxAttempts ?? defaultMaxAttempts2;
    requireMaxAttempts(maxAttempts);
    if (input.deadlineAt !== void 0)
      requireDeadline(input.deadlineAt, options.clock);
    const now2 = options.clock.now();
    const envelope = Object.freeze({
      id: input.id,
      projectId: input.projectId ?? "system",
      rootId: input.id,
      idempotencyKey: input.idempotencyKey,
      senderId: input.senderId,
      recipientId: input.recipientId,
      ...input.replyToRecipientId ? { replyToRecipientId: input.replyToRecipientId } : {},
      kind: input.kind,
      payload: Object.freeze({ ...input.payload }),
      endpoint: cloneEndpoint(endpoint3),
      status: "pending",
      attempts: 0,
      maxAttempts,
      ...input.deadlineAt !== void 0 ? { deadlineAt: input.deadlineAt } : {},
      createdAt: now2
    });
    const result2 = options.storage.createEnvelope({
      envelope,
      fingerprint: canonicalJson2({
        idempotencyKey: input.idempotencyKey,
        senderId: input.senderId,
        recipientId: input.recipientId,
        kind: input.kind,
        payload: input.payload,
        deadlineAt: input.deadlineAt ?? null,
        maxAttempts,
        replyToRecipientId: input.replyToRecipientId ?? null
      })
    });
    if (result2.kind === "conflict")
      throw new EnvelopeConflictError(result2.reason);
    return result2.envelope;
  }
  function wrapClaim(envelope) {
    let prepared = false;
    const requirePrepared = () => {
      if (!prepared)
        throw new Error("delivery claim requires successful current prepare");
    };
    const settle = (status, error2, nextAttemptAt) => {
      const settled = options.storage.settleEnvelope({
        id: envelope.id,
        claimToken: envelope.claimToken,
        now: options.clock.now(),
        status,
        ...error2 ? { error: error2 } : {},
        ...nextAttemptAt ? { nextAttemptAt } : {}
      });
      if (!settled)
        throw new Error("delivery claim is no longer current");
      return settled;
    };
    return Object.freeze({
      envelope,
      prepare() {
        const current = options.eligibility.resolve(envelope.endpoint.generationId);
        if (endpointMatches(envelope.endpoint, current)) {
          prepared = true;
          return Object.freeze({ kind: "deliver", envelope });
        }
        prepared = false;
        settle("retrying", "endpoint eligibility changed", options.clock.after(1e3));
        return Object.freeze({
          kind: "stale",
          reason: current ? "endpoint_changed" : "ineligible"
        });
      },
      acknowledge(acknowledgementId, payload2 = {}) {
        requirePrepared();
        requireIdentifier(acknowledgementId, "acknowledgement id");
        requireJsonObject(payload2, "acknowledgement payload");
        return options.storage.acknowledgeEnvelope({
          id: envelope.id,
          claimToken: envelope.claimToken,
          acknowledgementId,
          recipientId: envelope.recipientId,
          payload: payload2,
          now: options.clock.now()
        });
      },
      reply(input) {
        requirePrepared();
        requireIdentifier(input.id, "reply id");
        requireIdentifier(input.idempotencyKey, "reply idempotency key");
        requireJsonObject(input.payload, "reply payload");
        if (!envelope.replyToRecipientId)
          throw new Error("delivery envelope has no reply route");
        const endpoint3 = options.eligibility.resolve(envelope.replyToRecipientId);
        if (!queueable(endpoint3))
          throw new Error("reply endpoint is not eligible");
        const child = Object.freeze({
          id: input.id,
          projectId: envelope.projectId,
          rootId: envelope.rootId,
          parentId: envelope.id,
          idempotencyKey: input.idempotencyKey,
          senderId: envelope.recipientId,
          recipientId: envelope.replyToRecipientId,
          replyToRecipientId: envelope.recipientId,
          kind: "reply",
          payload: Object.freeze({ ...input.payload }),
          endpoint: cloneEndpoint(endpoint3),
          status: "pending",
          attempts: 0,
          maxAttempts: envelope.maxAttempts,
          createdAt: options.clock.now()
        });
        const result2 = options.storage.createReplyEnvelope({
          parentId: envelope.id,
          claimToken: envelope.claimToken,
          envelope: child,
          fingerprint: canonicalJson2({
            parentId: envelope.id,
            idempotencyKey: input.idempotencyKey,
            payload: input.payload
          })
        });
        if (result2.kind === "conflict")
          throw new EnvelopeConflictError(result2.reason);
        return result2.envelope;
      },
      fail(error2, retryAfterMs = retryAfter(envelope.attempts)) {
        requirePrepared();
        requireRetryDelay(retryAfterMs);
        const diagnostic = sanitizeDiagnostic(error2);
        const exhausted = envelope.attempts >= envelope.maxAttempts;
        return settle(exhausted ? "dead_letter" : "retrying", diagnostic, exhausted ? void 0 : options.clock.after(retryAfterMs));
      },
      delivered() {
        requirePrepared();
        return settle("delivered");
      }
    });
  }
  const service = {
    enqueue,
    claim(workerId, limit = 1, leaseMs = defaultLeaseMs) {
      requireIdentifier(workerId, "delivery worker");
      requireLease(leaseMs);
      const now2 = options.clock.now();
      const rows = options.storage.claimEnvelopes({
        workerId,
        now: now2,
        claimUntil: options.clock.after(leaseMs),
        limit: requireClaimLimit(limit)
      });
      return Object.freeze(rows.map(wrapClaim));
    },
    recover() {
      return options.storage.recoverEnvelopes(options.clock.now());
    }
  };
  return Object.freeze(service);
}

// packages/tracker/dist/gateway.js
import crypto18 from "node:crypto";

// packages/tracker/dist/management.js
import crypto17 from "node:crypto";
import fs13 from "node:fs";
import path14 from "node:path";
var roleScopes = /* @__PURE__ */ new Set([
  "project",
  "session",
  "generation"
]);
var gateKinds = /* @__PURE__ */ new Set(["approval", "input"]);
var gateStatuses = /* @__PURE__ */ new Set([
  "approved",
  "denied",
  "cancelled"
]);
var operationKinds = /* @__PURE__ */ new Set([
  "chat",
  "brief",
  "interrupt",
  "halt",
  "control"
]);
var assetMimes = /* @__PURE__ */ new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp"
]);
var sensitiveKey = /(?:^|[_-])(?:token|credential|password|secret|api[_-]?key|authorization)(?:$|[_-])/iu;
var TrackerManagementError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "TrackerManagementError";
    this.code = code;
  }
};
function invalid3(message) {
  throw new TrackerManagementError("management.invalid", message);
}
function id(value2, label) {
  try {
    return requireIdentifier(value2, label);
  } catch (error2) {
    if (error2 instanceof TrackerValidationError)
      throw new TrackerManagementError("management.invalid", error2.message);
    throw error2;
  }
}
function text(value2, label, max = 4096) {
  if (typeof value2 !== "string" || value2.trim().length === 0 || value2.length > max)
    invalid3(`${label} must be nonblank text up to ${max} characters`);
  return value2.trim();
}
function payload(value2, label) {
  try {
    requireJsonObject(value2, label);
  } catch (error2) {
    if (error2 instanceof TrackerValidationError)
      throw new TrackerManagementError("management.invalid", error2.message);
    throw error2;
  }
  return sanitizePayload(value2);
}
function sanitizePayload(value2) {
  const visit = (entry2, key) => {
    if (key && sensitiveKey.test(key))
      return "[REDACTED]";
    if (typeof entry2 === "string") {
      try {
        return sanitizeDiagnostic(entry2);
      } catch {
        return "[REDACTED]";
      }
    }
    if (Array.isArray(entry2))
      return entry2.map((child) => visit(child, key));
    if (entry2 && typeof entry2 === "object")
      return Object.fromEntries(Object.entries(entry2).map(([childKey, child]) => [childKey, visit(child, childKey)]));
    return entry2;
  };
  return visit(value2);
}
function sameJson(left, right) {
  const canonical2 = (value2) => {
    if (Array.isArray(value2))
      return value2.map(canonical2);
    if (value2 && typeof value2 === "object")
      return Object.fromEntries(Object.entries(value2).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey)).map(([key, child]) => [key, canonical2(child)]));
    return value2;
  };
  return JSON.stringify(canonical2(left)) === JSON.stringify(canonical2(right));
}
function actor2(value2) {
  const candidate = text(value2, "actor", 256);
  return candidate.replace(/(token|credential|password|secret|owner[_-]?token|access[_-]?token|api[_-]?key)\s*[:=]\s*\S+/giu, "$1=[REDACTED]").slice(0, 256);
}
function now(clock) {
  return clock.now();
}
function ensureProject(value2) {
  return id(value2, "project id");
}
function ensureRoleScope(value2) {
  if (typeof value2 !== "string" || !roleScopes.has(value2))
    invalid3("role scope is unsupported");
  return value2;
}
function ensureGateKind(value2) {
  if (typeof value2 !== "string" || !gateKinds.has(value2))
    invalid3("gate kind is unsupported");
  return value2;
}
function ensureOperationKind(value2) {
  if (typeof value2 !== "string" || !operationKinds.has(value2))
    invalid3("communication kind is unsupported");
  return value2;
}
function ensureAssetPath(value2) {
  const relative = text(value2, "asset path", 512).replaceAll("\\", "/");
  if (path14.posix.isAbsolute(relative) || relative.split("/").some((part) => part === ".." || part.length === 0) || relative.includes("\0"))
    throw new TrackerManagementError("management.asset_invalid", "asset path must be a relative ticket-bound path");
  return relative;
}
function ensureSafeParent(root, target) {
  const relativeParent = path14.relative(root, path14.dirname(target));
  let current = root;
  for (const segment of relativeParent.split(path14.sep).filter(Boolean)) {
    current = path14.join(current, segment);
    if (fs13.existsSync(current) && fs13.lstatSync(current).isSymbolicLink())
      throw new TrackerManagementError("management.asset_invalid", "asset parent cannot be a symbolic link");
    fs13.mkdirSync(current, { recursive: true, mode: 448 });
  }
}
function assertWithin(root, target) {
  const relative = path14.relative(root, target);
  if (relative.startsWith(`..${path14.sep}`) || path14.isAbsolute(relative))
    throw new TrackerManagementError("management.asset_invalid", "asset path escapes the configured store");
}
function assertTrustedReadPath(root, target) {
  assertWithin(root, target);
  const rootReal = fs13.realpathSync(root);
  let current = root;
  const relative = path14.relative(root, target);
  for (const segment of relative.split(path14.sep).filter(Boolean)) {
    current = path14.join(current, segment);
    if (fs13.lstatSync(current).isSymbolicLink())
      throw new TrackerManagementError("management.not_found", "asset path contains a symbolic link");
    if (current !== target && !fs13.statSync(current).isDirectory())
      throw new TrackerManagementError("management.not_found", "asset parent is not a directory");
  }
  const resolved = fs13.realpathSync(target);
  const resolvedRelative = path14.relative(rootReal, resolved);
  if (resolvedRelative.startsWith(`..${path14.sep}`) || path14.isAbsolute(resolvedRelative))
    throw new TrackerManagementError("management.not_found", "asset path escapes the configured store");
}
function canonicalTarget(identity, projectId2, sessionId, generationId) {
  if (sessionId === void 0 && generationId === void 0)
    return {};
  if (!identity)
    throw new TrackerManagementError("management.invalid", "canonical runtime identity is not composed");
  const session2 = sessionId ? identity.getSession(projectId2, sessionId) : void 0;
  if (sessionId !== void 0 && !session2)
    throw new TrackerManagementError("management.not_found", "session does not belong to project");
  const generation2 = generationId ? identity.findGeneration(projectId2, generationId) : void 0;
  if (generationId !== void 0 && !generation2)
    throw new TrackerManagementError("management.not_found", "generation does not belong to project");
  if (generation2 && sessionId !== void 0 && generation2.sessionId !== sessionId)
    throw new TrackerManagementError("management.not_found", "generation does not belong to session");
  return {
    ...sessionId === void 0 ? {} : { sessionId },
    ...generationId === void 0 ? {} : { generationId }
  };
}
function createTrackerManagementServices(options) {
  const service = {
    roles: {
      create(input) {
        const projectId2 = ensureProject(input.projectId);
        const name = text(input.name, "role name", 128);
        const definition = payload(input.definition ?? {}, "role definition");
        const scope = ensureRoleScope(input.scope ?? "project");
        const mutationActor = actor2(input.actor);
        const existing = options.storage.listRoles(projectId2).find((role) => role.name === name);
        if (existing && existing.scope === scope && sameJson(existing.definition, definition))
          return existing;
        return options.storage.createRole({
          id: existing?.id ?? `role_${crypto17.randomUUID()}`,
          projectId: projectId2,
          name,
          scope,
          definition,
          actor: mutationActor,
          now: now(options.clock)
        });
      },
      list(projectId2) {
        return options.storage.listRoles(ensureProject(projectId2));
      },
      assign(input) {
        const projectId2 = ensureProject(input.projectId);
        const roleId = id(input.roleId, "role id");
        const sessionId = input.sessionId === void 0 ? void 0 : id(input.sessionId, "session id");
        const generationId = input.generationId === void 0 ? void 0 : id(input.generationId, "generation id");
        const target = canonicalTarget(options.identity, projectId2, sessionId, generationId);
        if (!options.storage.listRoles(projectId2).some((role) => role.id === roleId))
          throw new TrackerManagementError("management.not_found", "role does not belong to project");
        const assignment2 = options.storage.assignRole({
          id: `rasg_${crypto17.randomUUID()}`,
          projectId: projectId2,
          roleId,
          ...target,
          actor: actor2(input.actor),
          idempotencyKey: id(input.idempotencyKey, "idempotency key"),
          now: now(options.clock)
        });
        options.storage.createOperation({
          id: `op_${crypto17.randomUUID()}`,
          projectId: projectId2,
          kind: "control",
          command: "role.assign",
          payload: {
            role_id: roleId,
            assignment_id: assignment2.id,
            ...sessionId === void 0 ? {} : { session_id: sessionId },
            ...generationId === void 0 ? {} : { generation_id: generationId }
          },
          actor: actor2(input.actor),
          idempotencyKey: `role-assign:${id(input.idempotencyKey, "idempotency key")}`,
          now: now(options.clock)
        });
        return assignment2;
      }
    },
    gates: {
      create(input) {
        return options.storage.createGate({
          id: `gate_${crypto17.randomUUID()}`,
          projectId: ensureProject(input.projectId),
          kind: ensureGateKind(input.kind),
          question: text(input.question, "gate question"),
          assignee: actor2(input.assignee),
          idempotencyKey: id(input.idempotencyKey, "idempotency key"),
          actor: actor2(input.actor),
          now: now(options.clock)
        });
      },
      answer(input) {
        if (!gateStatuses.has(input.status))
          invalid3("gate verdict is unsupported");
        const projectId2 = ensureProject(input.projectId);
        const gateId = id(input.gateId, "gate id");
        const verdictActor = actor2(input.actor);
        const gate = options.storage.listGates(projectId2).find((candidate) => candidate.id === gateId);
        if (!gate)
          throw new TrackerManagementError("management.not_found", "gate does not belong to project");
        const sharedHuman = gate.assignee === "human" && (verdictActor === "human" || verdictActor.startsWith("human:"));
        if (gate.assignee !== verdictActor && !sharedHuman)
          throw new TrackerManagementError("management.forbidden", "only the gate assignee may answer this gate");
        const result2 = options.storage.answerGate({
          id: gateId,
          projectId: projectId2,
          status: input.status,
          verdict: payload(input.verdict, "gate verdict"),
          actor: verdictActor,
          now: now(options.clock)
        });
        if (!result2)
          throw new TrackerManagementError("management.not_found", "gate does not belong to project");
        return result2;
      },
      list(projectId2) {
        return options.storage.listGates(ensureProject(projectId2));
      }
    },
    ideas: {
      create(input) {
        return options.storage.createIdea({
          id: `idea_${crypto17.randomUUID()}`,
          projectId: ensureProject(input.projectId),
          body: text(input.body, "idea body", 16384),
          idempotencyKey: id(input.idempotencyKey, "idempotency key"),
          actor: actor2(input.actor),
          now: now(options.clock)
        });
      },
      pop(input) {
        const result2 = options.storage.popIdea({
          id: id(input.ideaId, "idea id"),
          projectId: ensureProject(input.projectId),
          actor: actor2(input.actor),
          now: now(options.clock)
        });
        if (!result2)
          throw new TrackerManagementError("management.not_found", "idea does not belong to project");
        return result2;
      },
      promote(input) {
        const projectId2 = ensureProject(input.projectId);
        const ideaId = id(input.ideaId, "idea id");
        const current = options.storage.listIdeas(projectId2).find((idea) => idea.id === ideaId);
        if (!current)
          throw new TrackerManagementError("management.not_found", "idea does not belong to project");
        if (current.promotedTicketId)
          return current;
        if (!options.tickets)
          throw new TrackerManagementError("management.invalid", "ticket promotion is not composed");
        const ticket = options.tickets.create({
          projectId: projectId2,
          kind: "work-item",
          title: text(input.title ?? current.body.slice(0, 120), "idea title", 256),
          body: current.body,
          labels: ["idea"],
          actor: actor2(input.actor)
        });
        const promoted = options.storage.promoteIdea({
          id: ideaId,
          projectId: projectId2,
          ticketId: ticket.id,
          actor: actor2(input.actor),
          now: now(options.clock)
        });
        if (!promoted)
          throw new TrackerManagementError("management.conflict", "idea promotion could not be recorded");
        return promoted;
      },
      list(projectId2) {
        return options.storage.listIdeas(ensureProject(projectId2));
      }
    },
    assets: {
      put(input) {
        const projectId2 = ensureProject(input.projectId);
        const ticketId = id(input.ticketId, "ticket id");
        if (options.tickets && options.tickets.get(ticketId)?.ticket.projectId !== projectId2)
          throw new TrackerManagementError("management.forbidden", "ticket is not in the requested project");
        const relativePath = ensureAssetPath(input.relativePath);
        if (!assetMimes.has(input.mimeType))
          throw new TrackerManagementError("management.asset_invalid", "asset MIME type is not allowed");
        if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0 || input.bytes.byteLength > 10 * 1024 * 1024)
          throw new TrackerManagementError("management.asset_invalid", "asset bytes exceed the bounded limit");
        const root = path14.resolve(options.assetRoot, projectId2, ticketId);
        fs13.mkdirSync(root, { recursive: true, mode: 448 });
        const target = path14.resolve(root, relativePath);
        assertWithin(root, target);
        ensureSafeParent(root, target);
        if (fs13.existsSync(target) && fs13.lstatSync(target).isSymbolicLink())
          throw new TrackerManagementError("management.asset_invalid", "asset target cannot be a symbolic link");
        const temporary = `${target}.tmp-${crypto17.randomUUID()}`;
        fs13.writeFileSync(temporary, input.bytes, { mode: 384 });
        fs13.renameSync(temporary, target);
        const asset = options.storage.putAsset({
          id: `asset_${crypto17.randomUUID()}`,
          projectId: projectId2,
          ticketId,
          relativePath,
          mimeType: input.mimeType,
          byteSize: input.bytes.byteLength,
          sha256: crypto17.createHash("sha256").update(input.bytes).digest("hex"),
          storagePath: target,
          actor: actor2(input.actor),
          now: now(options.clock)
        });
        return asset;
      },
      read(input) {
        const asset = options.storage.getAsset({
          id: id(input.assetId, "asset id"),
          projectId: ensureProject(input.projectId),
          ticketId: id(input.ticketId, "ticket id")
        });
        if (!asset)
          throw new TrackerManagementError("management.not_found", "asset is not authorized for this ticket");
        const root = path14.resolve(options.assetRoot, asset.projectId, asset.ticketId);
        const target = path14.resolve(root, asset.relativePath);
        if (!fs13.existsSync(target))
          throw new TrackerManagementError("management.not_found", "asset is unavailable");
        assertTrustedReadPath(root, target);
        if (fs13.lstatSync(target).isSymbolicLink())
          throw new TrackerManagementError("management.not_found", "asset is unavailable");
        const bytes = fs13.readFileSync(target);
        if (bytes.byteLength !== asset.byteSize || crypto17.createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
          throw new TrackerManagementError("management.not_found", "asset integrity check failed");
        return { asset, bytes: new Uint8Array(bytes) };
      },
      list(input) {
        const projectId2 = ensureProject(input.projectId);
        const ticketId = id(input.ticketId, "ticket id");
        if (options.tickets && options.tickets.get(ticketId)?.ticket.projectId !== projectId2)
          throw new TrackerManagementError("management.forbidden", "ticket is not in the requested project");
        return options.storage.listAssets({ projectId: projectId2, ticketId });
      }
    },
    communications: {
      create(input) {
        const projectId2 = ensureProject(input.projectId);
        const sessionId = input.sessionId === void 0 ? void 0 : id(input.sessionId, "session id");
        const generationId = input.generationId === void 0 ? void 0 : id(input.generationId, "generation id");
        const target = canonicalTarget(options.identity, projectId2, sessionId, generationId);
        return options.storage.createOperation({
          id: `op_${crypto17.randomUUID()}`,
          projectId: projectId2,
          ...target,
          kind: ensureOperationKind(input.kind),
          command: text(input.command, "command", 128),
          payload: payload(input.payload ?? {}, "communication payload"),
          actor: actor2(input.actor),
          idempotencyKey: id(input.idempotencyKey, "idempotency key"),
          now: now(options.clock)
        });
      }
    },
    controls: {
      request(input) {
        return service.communications.create({ ...input, kind: "control" });
      },
      get(input) {
        const value2 = options.storage.getOperation(id(input.id, "operation id"), ensureProject(input.projectId));
        if (!value2)
          throw new TrackerManagementError("management.not_found", "control request does not belong to project");
        return value2;
      },
      list(projectId2) {
        return options.storage.listOperations(ensureProject(projectId2));
      }
    },
    audit(projectId2) {
      return options.storage.auditManagement(ensureProject(projectId2));
    }
  };
  return Object.freeze(service);
}

// packages/tracker/dist/gateway.js
var CommandGatewayError = class extends Error {
  status;
  httpStatus;
  constructor(code, message, httpStatus) {
    super(message);
    this.name = "CommandGatewayError";
    this.status = code;
    this.httpStatus = httpStatus;
  }
};
function canonicalize(value2) {
  if (Array.isArray(value2))
    return value2.map(canonicalize);
  if (value2 && typeof value2 === "object") {
    return Object.fromEntries(Object.entries(value2).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonicalize(child)]));
  }
  return value2;
}
function fingerprint2(input) {
  const canonical2 = canonicalize({
    command_kind: input.commandKind,
    project_id: input.projectId,
    resource_type: input.scope.resourceType,
    resource_id: input.scope.resourceId,
    payload: input.payload
  });
  const text3 = JSON.stringify(canonical2);
  const hash = crypto18.createHash("sha256").update(text3).digest("hex");
  return `sha256:${hash}`;
}
function outcomeFromReceipt(receipt) {
  return Object.freeze({
    schema_version: "golem.api-command-outcome/v1",
    command_id: receipt.command_id,
    status: receipt.outcome_status,
    ...receipt.reason_code ? { reason_code: receipt.reason_code } : {},
    ...receipt.operation_id ? { operation_id: receipt.operation_id } : {},
    result: receipt.result
  });
}
function createCommandGateway(options) {
  const storage = options.storage;
  const clock = options.clock;
  void options.core;
  function requireRevision2(input) {
    const candidate = input.expectedRevision;
    if (candidate === void 0)
      return;
    if (!Number.isSafeInteger(candidate) || candidate < 1) {
      throw new CommandGatewayError("tracker.revision.required", "expected_revision must be a positive safe integer", 400);
    }
  }
  function recordTerminal(input, outcome2) {
    const committedAt = clock.now();
    const fp = fingerprint2({
      commandKind: input.commandKind,
      projectId: input.projectId,
      scope: input.scope,
      payload: input.payload
    });
    storage.receipts.record({
      command_id: input.commandId,
      idempotency_key: input.idempotencyKey,
      command_kind: input.commandKind,
      actor_id: input.actorId,
      project_id: input.projectId,
      resource_type: input.scope.resourceType,
      resource_id: input.scope.resourceId,
      correlation_id: input.correlationId,
      fingerprint: fp,
      outcome_status: outcome2.status,
      ...outcome2.reason_code ? { reason_code: outcome2.reason_code } : {},
      ...outcome2.operation_id ? { operation_id: outcome2.operation_id } : {},
      result: outcome2.result ?? {},
      committed_at: committedAt
    });
    return Object.freeze({
      schema_version: "golem.api-command-outcome/v1",
      command_id: outcome2.command_id,
      status: outcome2.status,
      ...outcome2.reason_code ? { reason_code: outcome2.reason_code } : {},
      ...outcome2.operation_id ? { operation_id: outcome2.operation_id } : {},
      ...outcome2.result !== void 0 ? { result: outcome2.result } : {}
    });
  }
  function mismatch(input, existing) {
    return Object.freeze({
      schema_version: "golem.api-command-outcome/v1",
      command_id: input.commandId,
      status: "idempotency_mismatch",
      reason_code: "command.idempotency_mismatch",
      result: {
        original_command_id: existing.command_id,
        original_status: existing.outcome_status
      }
    });
  }
  function replayOrMismatch(input, existing) {
    const currentFingerprint = fingerprint2({
      commandKind: input.commandKind,
      projectId: input.projectId,
      scope: input.scope,
      payload: input.payload
    });
    if (existing.fingerprint !== currentFingerprint) {
      return mismatch(input, existing);
    }
    return outcomeFromReceipt(existing);
  }
  return Object.freeze({
    execute(input) {
      requireRevision2(input);
      const existing = storage.receipts.find(input.projectId, input.idempotencyKey);
      if (existing) {
        return replayOrMismatch(input, existing);
      }
      return storage.transaction(() => {
        const raced = storage.receipts.find(input.projectId, input.idempotencyKey);
        if (raced) {
          return replayOrMismatch(input, raced);
        }
        try {
          const result2 = input.handler();
          return recordTerminal(input, {
            command_id: input.commandId,
            status: "completed",
            result: result2
          });
        } catch (error2) {
          if (error2 instanceof TrackerCoreError) {
            const httpStatus = error2.code === "tracker.not_found" ? 404 : error2.code === "tracker.conflict" || error2.code === "tracker.phase.invalid" ? 409 : 400;
            recordTerminal(input, {
              command_id: input.commandId,
              status: error2.code === "tracker.conflict" ? "conflict" : "rejected",
              reason_code: error2.code,
              result: {}
            });
            throw new CommandGatewayError(error2.code, error2.message, httpStatus);
          }
          if (error2 instanceof TrackerManagementError) {
            const httpStatus = error2.code === "management.not_found" ? 404 : error2.code === "management.forbidden" ? 403 : error2.code === "management.conflict" ? 409 : 400;
            recordTerminal(input, {
              command_id: input.commandId,
              status: error2.code === "management.conflict" ? "conflict" : "rejected",
              reason_code: error2.code,
              result: {}
            });
            throw new CommandGatewayError(error2.code, error2.message, httpStatus);
          }
          throw error2;
        }
      });
    }
  });
}

// packages/tracker/dist/passive.js
function createPassiveSlotService(options) {
  const service = {
    append(input) {
      requireIdentifier(input.recipientId, "passive recipient");
      requireIdentifier(input.ticketId, "passive ticket");
      requireIdentifier(input.category, "passive category");
      requireIdentifier(input.eventId, "passive event id");
      requireJsonObject(input.baseline, "passive baseline");
      requireJsonObject(input.value, "passive value");
      options.storage.upsertPassiveDelta({
        ...input,
        now: options.clock.now()
      });
    },
    claim(recipientId, leaseMs = 3e4) {
      requireIdentifier(recipientId, "passive recipient");
      requireLease(leaseMs);
      return options.storage.claimPassiveBatch({
        recipientId,
        leaseId: globalThis.crypto.randomUUID(),
        leaseUntil: options.clock.after(leaseMs),
        now: options.clock.now()
      });
    },
    commit(recipientId, leaseId) {
      requireIdentifier(recipientId, "passive recipient");
      requireIdentifier(leaseId, "passive lease id");
      return options.storage.commitPassiveBatch({
        recipientId,
        leaseId,
        now: options.clock.now()
      });
    },
    release(recipientId, leaseId) {
      requireIdentifier(recipientId, "passive recipient");
      requireIdentifier(leaseId, "passive lease id");
      return options.storage.releasePassiveBatch({
        recipientId,
        leaseId,
        now: options.clock.now()
      });
    }
  };
  return Object.freeze(service);
}

// packages/tracker/dist/subscriptions.js
function createDurableSubscriptionService(options) {
  const service = {
    subscribe(input) {
      if (input.id !== void 0)
        requireIdentifier(input.id, "subscription id");
      requireIdentifier(input.name, "subscription name");
      requireIdentifier(input.recipientId, "subscription recipient");
      requireIdentifier(input.topic, "subscription topic");
      const classes = requireSubscriptionClasses(input.classes ?? ["tracker", "lifecycle", "custom"]);
      const cursor = requireCursor(input.cursor ?? 0);
      requireSubscriptionStatus(input.status ?? "active");
      return options.storage.upsertSubscription({
        id: input.id ?? globalThis.crypto.randomUUID(),
        name: input.name,
        recipientId: input.recipientId,
        topic: input.topic,
        classes: Object.freeze([...classes]),
        cursor,
        manual: input.manual ?? true,
        status: input.status ?? "active",
        createdAt: options.clock.now()
      });
    },
    pending(id2, limit = 100) {
      requireIdentifier(id2, "subscription id");
      return options.storage.pendingSubscriptionEvents({
        id: id2,
        limit: requireSubscriptionPendingLimit(limit)
      });
    },
    commit(id2, fromSequence, toSequence) {
      requireIdentifier(id2, "subscription id");
      requireCursorRange(fromSequence, toSequence);
      return options.storage.advanceSubscriptionCursor({
        id: id2,
        fromSequence,
        toSequence
      });
    }
  };
  return Object.freeze(service);
}

// packages/tracker/dist/services.js
function createTrackerServices(options) {
  const services = {
    delivery: createDurableDeliveryService(options),
    bus: createDurableBusService(options),
    subscriptions: createDurableSubscriptionService(options),
    passive: createPassiveSlotService(options),
    prune(before) {
      requireTimestamp(before, "prune before");
      return options.storage.prune({ now: options.clock.now(), before });
    },
    audit() {
      return options.storage.audit();
    }
  };
  return Object.freeze(services);
}

// packages/tracker/dist/ticket-dispatch.js
function queueDisposition(endpoint3) {
  if (!endpoint3)
    return "ineligible";
  if (endpoint3.readiness === "ready")
    return "queued";
  if (endpoint3.readiness === "pull_only")
    return "pull_only";
  if (endpoint3.readiness === "next_turn")
    return "next_turn";
  return "ineligible";
}
function terminal4(ticket) {
  return ticket.state === "done" || ticket.state === "archived" || ticket.phase === "done" || ticket.phase === "closed";
}
function outcome(operationId, disposition) {
  return Object.freeze({
    kind: "dispatch",
    disposition,
    operation_id: operationId,
    ...disposition === "queued" || disposition === "pull_only" || disposition === "next_turn" ? { capability: "delivery" } : {},
    ...disposition === "pull_only" ? { remediation: "await_delivery" } : disposition === "next_turn" ? { remediation: "await_next_turn" } : disposition === "stale" ? { remediation: "refresh_ticket" } : {}
  });
}
function object(value2) {
  return value2 && typeof value2 === "object" && !Array.isArray(value2) ? value2 : void 0;
}
function exactKeys(value2, keys) {
  const actual = Object.keys(value2).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function parsedOutcome(record2) {
  const direct = object(record2.result);
  if (!direct)
    return void 0;
  const candidate = direct.kind === "dispatch" ? direct : exactKeys(direct, ["resource_revision", "result"]) && Number.isSafeInteger(direct.resource_revision) && Number(direct.resource_revision) >= 0 ? object(direct.result) : void 0;
  if (candidate?.kind !== "dispatch")
    return void 0;
  if (candidate.disposition !== "queued" && candidate.disposition !== "pull_only" && candidate.disposition !== "next_turn" && candidate.disposition !== "ineligible" && candidate.disposition !== "stale")
    return void 0;
  if (candidate.operation_id !== record2.commandId)
    return void 0;
  const expected = outcome(record2.commandId, candidate.disposition);
  const expectedRecord = expected;
  if (!exactKeys(candidate, Object.keys(expectedRecord)))
    return void 0;
  for (const [key, value2] of Object.entries(expectedRecord))
    if (candidate[key] !== value2)
      return void 0;
  return expected;
}
function settlement(status) {
  if (status === "pending" || status === "claimed")
    return "pending";
  if (status === "delivered")
    return "delivered";
  if (status === "acknowledged")
    return "settled";
  if (status === "retrying")
    return "retrying";
  if (status === "dead_letter")
    return "failed";
  return status;
}
function operation(projectId2, record2) {
  if (record2.projectId !== projectId2)
    return void 0;
  const parsed = parsedOutcome(record2);
  if (!parsed)
    return void 0;
  const queueable2 = parsed.disposition === "queued" || parsed.disposition === "pull_only" || parsed.disposition === "next_turn";
  if (queueable2 && record2.envelopeStatus === void 0 || !queueable2 && record2.envelopeStatus !== void 0)
    return void 0;
  return Object.freeze({
    id: record2.commandId,
    ticketId: record2.ticketId,
    disposition: parsed.disposition,
    ...parsed.capability ? { capability: parsed.capability } : {},
    ...parsed.remediation ? { remediation: parsed.remediation } : {},
    ...record2.envelopeStatus ? { settlement: settlement(record2.envelopeStatus) } : {},
    createdAt: record2.committedAt
  });
}
function createTicketDispatchService(options) {
  return Object.freeze({
    operations(projectId2) {
      return Object.freeze(options.operations.list(projectId2).map((record2) => operation(projectId2, record2)).filter((value2) => value2 !== void 0));
    },
    dispatch(input) {
      const ticket = options.tickets.get(input.projectId, input.ticketId);
      if (!ticket || ticket.projectId !== input.projectId || terminal4(ticket))
        return outcome(input.operationId, "ineligible");
      const hinted = input.assigneeHint ? options.sessions.resolve(input.projectId, input.assigneeHint) : void 0;
      if (input.assigneeHint && !hinted)
        return outcome(input.operationId, "ineligible");
      const selected = ticket.assignee ? options.sessions.resolve(input.projectId, ticket.assignee) : hinted;
      if (!selected)
        return outcome(input.operationId, "ineligible");
      if (ticket.assignee && hinted && hinted.sessionId !== selected.sessionId)
        return outcome(input.operationId, "ineligible");
      const endpoint3 = options.eligibility.resolve(selected.generationId);
      const disposition = queueDisposition(endpoint3);
      if (disposition === "ineligible")
        return outcome(input.operationId, disposition);
      const committed = options.tickets.record({
        id: ticket.id,
        expectedRevision: input.expectedRevision,
        dispatchedTo: selected.sessionId,
        actor: input.actorId,
        ...ticket.assignee === void 0 ? { assignee: selected.sessionId } : {}
      });
      if (!committed)
        return outcome(input.operationId, "stale");
      const envelopeId = `env_${globalThis.crypto.randomUUID()}`;
      const envelope = options.delivery.enqueue({
        id: envelopeId,
        projectId: input.projectId,
        idempotencyKey: input.idempotencyKey,
        senderId: input.actorId,
        recipientId: selected.sessionId,
        eligibilityRecipientId: selected.generationId,
        kind: "ticket_dispatch",
        payload: Object.freeze({
          ticket_id: ticket.id,
          ...input.legacy?.note === void 0 ? {} : { note: input.legacy.note },
          ...input.legacy?.workspace === void 0 ? {} : { workspace: input.legacy.workspace },
          ...input.legacy?.whenIdle === void 0 ? {} : { when_idle: input.legacy.whenIdle }
        })
      });
      return outcome(input.operationId, queueDisposition(envelope.endpoint));
    }
  });
}

// apps/control-plane/src/browser-work-routes.ts
import { z as z21 } from "zod";
var TicketParamsSchema = z21.object({ opaque_id: BrowserOpaqueIdSchema }).strict();
var AssetParamsSchema = z21.object({ opaque_id: BrowserOpaqueIdSchema, asset_id: BrowserOpaqueIdSchema }).strict();
function jsonSchema2(value2) {
  return z21.toJSONSchema(value2, {
    target: "draft-7",
    unrepresentable: "any",
    reused: "inline"
  });
}
function browserFail2(request, reply, status, code) {
  return reply.code(status).send(
    BrowserWorkErrorSchema.parse({
      schema_version: "golem.browser-work-error/v1",
      code,
      correlation_id: request.id
    })
  );
}
function browserContext2(request, reply, principal, action) {
  if (hasRequestAuthorityOverride(request)) {
    browserFail2(request, reply, 403, "browser.forbidden");
    return void 0;
  }
  const context = principal.resolve(request, {
    action,
    allowBrowser: true,
    allowBearer: false
  });
  if (!context) {
    browserFail2(request, reply, 401, "browser.auth.required");
    return void 0;
  }
  if (!principal.policy.allows(context, action)) {
    browserFail2(request, reply, 403, "browser.forbidden");
    return void 0;
  }
  return context;
}
function commandFailure(request, reply, error2) {
  if (error2 instanceof CommandGatewayError)
    return browserFail2(request, reply, error2.httpStatus, error2.status);
  if (error2 instanceof TrackerCoreError) {
    const status = error2.code === "tracker.not_found" ? 404 : error2.code === "tracker.conflict" || error2.code === "tracker.phase.invalid" ? 409 : 400;
    return browserFail2(request, reply, status, error2.code);
  }
  if (error2 instanceof TrackerManagementError) {
    const status = error2.code === "management.not_found" ? 404 : error2.code === "management.forbidden" ? 403 : error2.code === "management.conflict" ? 409 : 400;
    return browserFail2(request, reply, status, error2.code);
  }
  return browserFail2(request, reply, 400, "browser.work.invalid");
}
function outcomeResponse(request, reply, outcome2) {
  if (outcome2.status === "idempotency_mismatch")
    return browserFail2(request, reply, 409, "command.idempotency_mismatch");
  const stored = z21.object({
    resource_revision: z21.number().int().nonnegative(),
    result: BrowserWorkCommandResultSchema
  }).strict().safeParse(outcome2.result);
  if (!stored.success)
    return browserFail2(request, reply, 400, "browser.work.invalid");
  const response2 = BrowserWorkCommandResponseSchema.safeParse({
    schema_version: "golem.browser-work-command/v1",
    command_id: outcome2.command_id,
    status: outcome2.status,
    resource_revision: stored.data.resource_revision,
    result: stored.data.result
  });
  return response2.success ? reply.send(response2.data) : browserFail2(request, reply, 400, "browser.work.invalid");
}
function durableBrowserOutcome(browserWork, projectId2, result2) {
  return z21.object({
    resource_revision: z21.number().int().nonnegative(),
    result: BrowserWorkCommandResultSchema
  }).strict().parse({
    resource_revision: browserWork.projection("tracker.board", projectId2).resource_revision,
    result: result2
  });
}
function registerBrowserWorkRoutes(options) {
  const errorResponses2 = {
    400: jsonSchema2(BrowserWorkErrorSchema),
    401: jsonSchema2(BrowserWorkErrorSchema),
    403: jsonSchema2(BrowserWorkErrorSchema),
    404: jsonSchema2(BrowserWorkErrorSchema),
    409: jsonSchema2(BrowserWorkErrorSchema)
  };
  options.app.get(
    "/api/v1/browser/work/items/:opaque_id",
    {
      schema: {
        params: jsonSchema2(TicketParamsSchema),
        response: {
          200: jsonSchema2(BrowserWorkDetailResponseSchema),
          ...errorResponses2
        }
      }
    },
    async (request, reply) => {
      const context = browserContext2(request, reply, options.principal, "read");
      if (!context) return;
      const params = TicketParamsSchema.safeParse(request.params);
      if (!params.success)
        return browserFail2(request, reply, 400, "browser.work.invalid");
      const detail = options.browserWork.detail(
        context.defaultProjectId,
        params.data.opaque_id
      );
      return detail ? reply.send(detail) : browserFail2(request, reply, 404, "browser.work.not_found");
    }
  );
  options.app.get(
    "/api/v1/browser/work/items/:opaque_id/assets/:asset_id",
    {
      schema: {
        params: jsonSchema2(AssetParamsSchema),
        response: {
          200: jsonSchema2(BrowserWorkAssetResponseSchema),
          ...errorResponses2
        }
      }
    },
    async (request, reply) => {
      const context = browserContext2(request, reply, options.principal, "read");
      if (!context) return;
      const params = AssetParamsSchema.safeParse(request.params);
      if (!params.success)
        return browserFail2(request, reply, 400, "browser.work.invalid");
      try {
        const asset = options.browserWork.asset(
          context.defaultProjectId,
          params.data.opaque_id,
          params.data.asset_id
        );
        return asset ? reply.send(asset) : browserFail2(request, reply, 404, "browser.work.not_found");
      } catch (error2) {
        return commandFailure(request, reply, error2);
      }
    }
  );
  options.app.post(
    "/api/v1/browser/work/commands",
    {
      schema: {
        response: {
          200: jsonSchema2(BrowserWorkCommandResponseSchema),
          ...errorResponses2,
          409: jsonSchema2(
            z21.union([BrowserWorkCommandResponseSchema, BrowserWorkErrorSchema])
          )
        }
      }
    },
    async (request, reply) => {
      const context = browserContext2(
        request,
        reply,
        options.principal,
        "mutate"
      );
      if (!context) return;
      const parsed = BrowserWorkCommandRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return browserFail2(request, reply, 400, "browser.work.invalid");
      }
      const input = parsed.data;
      try {
        if (input.kind === "dispatch") {
          if (!options.browserWork.ticket(
            context.defaultProjectId,
            input.opaque_id
          ))
            return browserFail2(request, reply, 404, "browser.work.not_found");
          const commandId = `cmd_${crypto19.randomUUID()}`;
          const result3 = options.gateway.execute({
            commandId,
            idempotencyKey: input.idempotency_key,
            commandKind: input.kind,
            actorId: context.actorId,
            projectId: context.defaultProjectId,
            correlationId: `cor_${crypto19.randomUUID()}`,
            scope: { resourceType: "ticket", resourceId: input.opaque_id },
            expectedRevision: input.expected_revision,
            payload: input,
            handler: () => durableBrowserOutcome(
              options.browserWork,
              context.defaultProjectId,
              options.ticketDispatch.dispatch({
                projectId: context.defaultProjectId,
                ticketId: input.opaque_id,
                expectedRevision: input.expected_revision,
                idempotencyKey: input.idempotency_key,
                actorId: context.actorId,
                operationId: commandId
              })
            )
          });
          return outcomeResponse(request, reply, result3);
        }
        if (input.kind === "ticket.update" || input.kind === "ticket.transition" || input.kind === "comment.create" || input.kind === "link.create") {
          if (!options.browserWork.ticket(
            context.defaultProjectId,
            input.opaque_id
          ))
            return browserFail2(request, reply, 404, "browser.work.not_found");
        }
        if ((input.kind === "ticket.create" || input.kind === "ticket.update") && input.parent_opaque_id !== void 0 && !options.browserWork.ticket(
          context.defaultProjectId,
          input.parent_opaque_id
        ))
          return browserFail2(request, reply, 404, "browser.work.not_found");
        if ((input.kind === "ticket.create" || input.kind === "ticket.update") && input.stream_opaque_id !== void 0 && !options.core.streams.list(context.defaultProjectId).some((stream) => stream.id === input.stream_opaque_id))
          return browserFail2(request, reply, 404, "browser.work.not_found");
        if (input.kind === "link.create" && !options.browserWork.ticket(
          context.defaultProjectId,
          input.target_opaque_id
        ))
          return browserFail2(request, reply, 404, "browser.work.not_found");
        if ((input.kind === "management.idea.pop" || input.kind === "management.idea.promote") && !options.browserWork.idea(
          context.defaultProjectId,
          input.idea_opaque_id
        ))
          return browserFail2(request, reply, 404, "browser.work.not_found");
        if (input.kind === "ticket.update" && input.title === void 0 && input.body === void 0 && input.priority === void 0 && input.labels === void 0 && input.parent_opaque_id === void 0 && input.stream_opaque_id === void 0 && input.wave === void 0)
          return browserFail2(request, reply, 400, "browser.work.invalid");
        const scope = input.kind === "ticket.create" ? { resourceType: "ticket", resourceId: "new" } : input.kind === "ticket.update" || input.kind === "ticket.transition" || input.kind === "comment.create" || input.kind === "link.create" ? { resourceType: "ticket", resourceId: input.opaque_id } : input.kind === "stream.create" ? { resourceType: "stream", resourceId: "new" } : input.kind === "management.gate.create" ? { resourceType: "gate", resourceId: "new" } : input.kind === "management.role.assign" ? {
          resourceType: "role",
          resourceId: input.role_opaque_id
        } : input.kind === "management.idea.create" ? { resourceType: "idea", resourceId: "new" } : {
          resourceType: "idea",
          resourceId: input.idea_opaque_id
        };
        const result2 = options.gateway.execute({
          commandId: `cmd_${crypto19.randomUUID()}`,
          idempotencyKey: input.idempotency_key,
          commandKind: input.kind,
          actorId: context.actorId,
          projectId: context.defaultProjectId,
          correlationId: `cor_${crypto19.randomUUID()}`,
          scope,
          ...input.kind === "ticket.update" || input.kind === "ticket.transition" ? { expectedRevision: input.expected_revision } : {},
          payload: input,
          handler: () => {
            if (input.kind === "ticket.create") {
              const ticket = options.core.tickets.create({
                projectId: context.defaultProjectId,
                kind: input.ticket_kind ?? "work-item",
                title: input.title,
                ...input.body === void 0 ? {} : { body: input.body },
                ...input.priority === void 0 ? {} : { priority: input.priority },
                ...input.labels === void 0 ? {} : { labels: input.labels },
                ...input.parent_opaque_id === void 0 ? {} : { parentId: input.parent_opaque_id },
                ...input.stream_opaque_id === void 0 ? {} : { streamId: input.stream_opaque_id },
                ...input.wave === void 0 ? {} : { wave: input.wave },
                actor: context.actorId
              });
              const safe = options.browserWork.ticket(
                context.defaultProjectId,
                ticket.id
              );
              if (!safe)
                throw new TrackerCoreError(
                  "tracker.not_found",
                  "created ticket is unavailable"
                );
              return durableBrowserOutcome(
                options.browserWork,
                context.defaultProjectId,
                { kind: "ticket", ticket: safe }
              );
            }
            if (input.kind === "ticket.update") {
              const ticket = options.core.tickets.update({
                id: input.opaque_id,
                expectedRevision: input.expected_revision,
                patch: {
                  ...input.title === void 0 ? {} : { title: input.title },
                  ...input.body === void 0 ? {} : { body: input.body },
                  ...input.priority === void 0 ? {} : { priority: input.priority },
                  ...input.labels === void 0 ? {} : { labels: input.labels },
                  ...input.parent_opaque_id === void 0 ? {} : { parentId: input.parent_opaque_id },
                  ...input.stream_opaque_id === void 0 ? {} : { streamId: input.stream_opaque_id },
                  ...input.wave === void 0 ? {} : { wave: input.wave }
                },
                actor: context.actorId
              });
              const safe = options.browserWork.ticket(
                context.defaultProjectId,
                ticket.id
              );
              if (!safe)
                throw new TrackerCoreError(
                  "tracker.not_found",
                  "updated ticket is unavailable"
                );
              return durableBrowserOutcome(
                options.browserWork,
                context.defaultProjectId,
                { kind: "ticket", ticket: safe }
              );
            }
            if (input.kind === "ticket.transition") {
              const ticket = options.core.tickets.transition({
                id: input.opaque_id,
                expectedRevision: input.expected_revision,
                phase: input.phase,
                ...input.reason === void 0 ? {} : { reason: input.reason },
                actor: context.actorId
              });
              const safe = options.browserWork.ticket(
                context.defaultProjectId,
                ticket.id
              );
              if (!safe)
                throw new TrackerCoreError(
                  "tracker.not_found",
                  "transitioned ticket is unavailable"
                );
              return durableBrowserOutcome(
                options.browserWork,
                context.defaultProjectId,
                { kind: "ticket", ticket: safe }
              );
            }
            if (input.kind === "comment.create") {
              const comment = input.parent_comment_opaque_id === void 0 ? options.core.comments.add({
                ticketId: input.opaque_id,
                author: context.actorId,
                body: input.body
              }) : options.core.comments.reply({
                ticketId: input.opaque_id,
                parentId: input.parent_comment_opaque_id,
                author: context.actorId,
                body: input.body
              });
              return durableBrowserOutcome(
                options.browserWork,
                context.defaultProjectId,
                { kind: "comment", comment: browserWorkCommentView(comment) }
              );
            }
            if (input.kind === "link.create") {
              const link = options.core.links.create({
                ticketId: input.opaque_id,
                targetTicketId: input.target_opaque_id,
                relation: input.relation,
                actor: context.actorId
              });
              return durableBrowserOutcome(
                options.browserWork,
                context.defaultProjectId,
                { kind: "link", link: browserWorkLinkView(link) }
              );
            }
            if (input.kind === "stream.create") {
              const stream = options.core.streams.upsert({
                projectId: context.defaultProjectId,
                name: input.name,
                mode: input.mode,
                ...input.description === void 0 ? {} : { description: input.description },
                actor: context.actorId
              });
              return durableBrowserOutcome(
                options.browserWork,
                context.defaultProjectId,
                { kind: "stream", stream: browserWorkStreamView(stream) }
              );
            }
            if (input.kind === "management.gate.create") {
              const gate = options.management.gates.create({
                projectId: context.defaultProjectId,
                kind: input.gate_kind,
                question: input.question,
                assignee: input.assignee,
                idempotencyKey: input.idempotency_key,
                actor: context.actorId
              });
              return durableBrowserOutcome(
                options.browserWork,
                context.defaultProjectId,
                {
                  kind: "gate",
                  opaque_id: gate.id,
                  status: gate.status,
                  updated_at: gate.updatedAt
                }
              );
            }
            if (input.kind === "management.role.assign") {
              const role = options.management.roles.list(context.defaultProjectId).find((candidate) => candidate.id === input.role_opaque_id);
              if (role?.scope !== "project")
                throw new TrackerManagementError(
                  "management.forbidden",
                  "browser role assignment is limited to project roles"
                );
              const assignment2 = options.management.roles.assign({
                projectId: context.defaultProjectId,
                roleId: role.id,
                actor: context.actorId,
                idempotencyKey: input.idempotency_key
              });
              return durableBrowserOutcome(
                options.browserWork,
                context.defaultProjectId,
                {
                  kind: "role_assignment",
                  role_opaque_id: role.id,
                  assigned_at: assignment2.createdAt
                }
              );
            }
            const idea = input.kind === "management.idea.create" ? options.management.ideas.create({
              projectId: context.defaultProjectId,
              body: input.body,
              idempotencyKey: input.idempotency_key,
              actor: context.actorId
            }) : input.kind === "management.idea.pop" ? options.management.ideas.pop({
              projectId: context.defaultProjectId,
              ideaId: input.idea_opaque_id,
              actor: context.actorId
            }) : options.management.ideas.promote({
              projectId: context.defaultProjectId,
              ideaId: input.idea_opaque_id,
              actor: context.actorId,
              ...input.title === void 0 ? {} : { title: input.title }
            });
            return durableBrowserOutcome(
              options.browserWork,
              context.defaultProjectId,
              { kind: "idea", idea: browserWorkIdeaView(idea) }
            );
          }
        });
        return outcomeResponse(request, reply, result2);
      } catch (error2) {
        return commandFailure(request, reply, error2);
      }
    }
  );
}

// apps/control-plane/src/committed-publication.ts
function streamFor(record2) {
  if (record2.category === "communication") return "communication.operations";
  if (record2.category === "management") return "management.controls";
  return record2.resourceType.startsWith("tracker.") ? "tracker.tree" : "tracker.board";
}
function browserStreamFor(record2) {
  const invalidation = browserInvalidationFor(record2);
  if (invalidation.category === "communication")
    return "communication.operations";
  if (invalidation.category === "management") return "management.controls";
  return record2.resourceType.startsWith("tracker.") ? "tracker.tree" : "tracker.board";
}
function browserInvalidationFor(record2) {
  return BrowserWorkInvalidationSchema.parse({
    kind: "invalidation",
    category: record2.category === "communication" || record2.category === "delivery" ? "communication" : record2.category === "management" || record2.category === "asset" ? "management" : "tracker"
  });
}
var CommittedPublicationDispatcher = class {
  #storage;
  #replay;
  #browserReplay;
  #workerId;
  #now;
  constructor(options) {
    this.#storage = options.storage;
    this.#replay = options.replay;
    this.#browserReplay = options.browserReplay;
    this.#workerId = options.workerId;
    this.#now = options.now;
  }
  drain(limit = 64) {
    const now2 = this.#now();
    this.#storage.recover(now2);
    const claimed = this.#storage.claim({
      workerId: this.#workerId,
      now: now2,
      claimUntil: new Date(Date.parse(now2) + 3e4).toISOString(),
      limit
    });
    let published = 0;
    for (const record2 of claimed) {
      const scope = {
        projectId: record2.projectId,
        policyVersion: record2.policyVersion
      };
      if (this.#browserReplay)
        this.#browserReplay.publishBrowserWork(
          browserStreamFor(record2),
          record2.projectRevision,
          browserInvalidationFor(record2),
          scope
        );
      else
        this.#replay.publish(
          streamFor(record2),
          record2.projectRevision,
          Object.freeze({ kind: "invalidation", category: record2.category }),
          scope
        );
      if (this.#storage.ack({
        id: record2.id,
        claimToken: record2.claimToken,
        publishedAt: this.#now()
      }))
        published += 1;
    }
    return published;
  }
};

// apps/control-plane/src/compatibility.ts
import path15 from "node:path";
import fastifyStatic from "@fastify/static";
var legacyColumns = [
  "triage",
  "open",
  "in-progress",
  "review",
  "blocked",
  "done"
];
function createLegacyCompatibilitySource(initialSnapshot = {}) {
  const listeners = /* @__PURE__ */ new Set();
  let snapshot = Object.freeze({
    projects: [],
    native_sessions: [],
    channels: [],
    recent_milestones: [],
    tickets: [],
    streams: [],
    chat: [],
    ...initialSnapshot
  });
  return Object.freeze({
    snapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish: (frame2) => {
      if (!frame2.type)
        throw new Error("legacy compatibility frames require type");
      if (frame2.type === "snapshot" && frame2.payload) {
        const payload2 = frame2.payload;
        if (typeof payload2 === "object" && payload2 !== null)
          snapshot = Object.freeze({ ...snapshot, ...payload2 });
      }
      if (frame2.type === "projects-list" && Array.isArray(frame2.projects))
        snapshot = Object.freeze({ ...snapshot, projects: frame2.projects });
      for (const listener of listeners) listener(Object.freeze({ ...frame2 }));
    }
  });
}
function registerLegacyWebSocket(options) {
  const sockets = /* @__PURE__ */ new Set();
  const now2 = options.now ?? Date.now;
  const broadcast = (frame2) => {
    for (const socket of sockets) {
      try {
        socket.send(JSON.stringify(frame2));
      } catch {
        sockets.delete(socket);
      }
    }
  };
  const unsubscribe = options.source.subscribe(broadcast);
  options.app.get("/ws", { websocket: true }, (socket) => {
    sockets.add(socket);
    try {
      socket.send(
        JSON.stringify({
          type: "snapshot",
          payload: options.source.snapshot(),
          ts: now2()
        })
      );
    } catch {
      sockets.delete(socket);
      return;
    }
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(String(raw));
        if (message.type === "ping")
          socket.send(JSON.stringify({ type: "pong", ts: now2() }));
      } catch {
      }
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
  });
  return () => {
    unsubscribe();
    for (const socket of sockets) socket.close(1001, "service shutting down");
    sockets.clear();
  };
}
async function registerStaticCompatibility(options) {
  await options.app.register(fastifyStatic, {
    root: path15.resolve(options.staticDirectory),
    prefix: "/",
    decorateReply: true
  });
  options.app.get("/api/health", async () => ({
    ok: true,
    projects_root: null,
    project_count: 0,
    server_time: (/* @__PURE__ */ new Date()).toISOString()
  }));
  options.app.get("/api/meta", async () => ({
    roles: {},
    columns: legacyColumns,
    config: {
      projectsRoot: null,
      ideasRoot: null,
      golemRoot: null,
      channelUrl: null,
      agentActiveWindowMs: null,
      agentIdleTimeoutMs: null,
      ceoLiveWindowMs: null
    }
  }));
  options.app.setNotFoundHandler((request, reply) => {
    if (request.method === "GET" && request.headers.accept?.includes("text/html"))
      return reply.sendFile("index.html");
    return fail(
      request,
      reply,
      404,
      "route.not_found",
      "typed control-plane route was not found"
    );
  });
}

// apps/control-plane/src/management-routes.ts
import crypto20 from "node:crypto";
import { z as z22 } from "zod";
var responseSchema = z22.object({
  schema_version: z22.literal("golem.management/v1"),
  result: z22.unknown()
}).passthrough();
var requestSchema = z22.record(z22.string(), z22.unknown());
var errorResponses = {
  400: { type: "object", additionalProperties: true },
  401: { type: "object", additionalProperties: true },
  403: { type: "object", additionalProperties: true },
  404: { type: "object", additionalProperties: true },
  409: { type: "object", additionalProperties: true },
  500: { type: "object", additionalProperties: true }
};
function jsonSchema3(value2) {
  return z22.toJSONSchema(value2, {
    target: "draft-7",
    unrepresentable: "any",
    reused: "inline"
  });
}
function authorized(request, reply, principal) {
  if (hasRequestAuthorityOverride(request)) {
    fail(
      request,
      reply,
      403,
      "browser.forbidden",
      "request authority is server-owned"
    );
    return void 0;
  }
  const action = request.method === "GET" ? "read" : "mutate";
  const context = principal.resolve(request, {
    action,
    allowBrowser: true,
    allowBearer: true
  });
  if (!context) {
    fail(
      request,
      reply,
      401,
      "browser.auth.required",
      "an authenticated principal binding is required"
    );
    return void 0;
  }
  if (!principal.policy.allows(context, action)) {
    fail(
      request,
      reply,
      403,
      "browser.forbidden",
      "the authenticated principal is not authorized"
    );
    return void 0;
  }
  return context;
}
function managementFailure(request, reply, error2) {
  if (error2 instanceof TrackerManagementError) {
    const status = error2.code === "management.not_found" ? 404 : error2.code === "management.forbidden" ? 403 : error2.code === "management.conflict" ? 409 : 400;
    fail(request, reply, status, error2.code, error2.message);
    return;
  }
  fail(request, reply, 500, "management.failed", "management operation failed");
}
function sendResult(request, reply, result2) {
  return sendValidated(request, reply, responseSchema, {
    schema_version: "golem.management/v1",
    result: result2
  });
}
function publicAsset(asset) {
  const { storagePath: _storagePath, ...safe } = asset;
  return safe;
}
function body(request) {
  const parsed = requestSchema.safeParse(request.body);
  if (!parsed.success)
    throw new TrackerManagementError(
      "management.invalid",
      "request body must be an object"
    );
  return parsed.data;
}
function text2(value2, name) {
  if (typeof value2 !== "string" || value2.trim().length === 0 || value2.length > 16384)
    throw new TrackerManagementError(
      "management.invalid",
      `${name} is invalid`
    );
  return value2.trim();
}
function field(input, name) {
  return text2(input[name], name);
}
function registerManagementRoutes(options) {
  const gateway = options.gateway;
  const GATEWAY_MISMATCH = /* @__PURE__ */ Symbol("gateway.mismatch");
  function gatewayRoute(input) {
    if (!gateway) return void 0;
    const key = typeof input.idempotencyKey === "string" && input.idempotencyKey ? input.idempotencyKey : `auto:management:${input.commandKind}:${crypto20.randomUUID()}`;
    const outcome2 = gateway.execute({
      commandId: `cmd_${crypto20.randomUUID()}`,
      idempotencyKey: key,
      commandKind: input.commandKind,
      actorId: input.context.actorId,
      projectId: input.context.defaultProjectId,
      correlationId: `cor_${crypto20.randomUUID()}`,
      scope: input.scope,
      payload: input.payload,
      handler: input.handler
    });
    if (outcome2.status === "idempotency_mismatch") {
      fail(
        input.request,
        input.reply,
        409,
        "command.idempotency_mismatch",
        "idempotency key reused with a differing payload"
      );
      return GATEWAY_MISMATCH;
    }
    return { handled: true, result: outcome2.result };
  }
  function managementRoute(input) {
    const routed = gatewayRoute(input);
    if (routed === GATEWAY_MISMATCH) return void 0;
    if (routed !== void 0) return routed.result;
    return input.handler();
  }
  const schema2 = {
    response: {
      200: jsonSchema3(responseSchema),
      201: jsonSchema3(responseSchema),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
      409: errorResponses[409],
      500: errorResponses[500]
    }
  };
  const register = (method, route, handler, withBody = false) => {
    const routeSchema = withBody ? { ...schema2, body: jsonSchema3(requestSchema) } : schema2;
    options.app[method](
      route,
      { schema: routeSchema },
      async (request, reply) => {
        const context = authorized(request, reply, options.principal);
        if (!context) return;
        try {
          return await handler(request, reply, context);
        } catch (error2) {
          managementFailure(request, reply, error2);
        }
      }
    );
  };
  register("get", "/api/v1/management/roles", (_request, reply, context) => {
    return sendResult(
      _request,
      reply,
      options.management.roles.list(context.defaultProjectId)
    );
  });
  register(
    "post",
    "/api/v1/management/roles",
    (request, reply, context) => {
      const input = body(request);
      return sendResult(
        request,
        reply.code(201),
        managementRoute({
          request,
          reply,
          context,
          commandKind: "management.role.create",
          scope: { resourceType: "role", resourceId: "*" },
          payload: input,
          handler: () => options.management.roles.create({
            projectId: context.defaultProjectId,
            name: field(input, "name"),
            scope: input.scope,
            definition: input.definition ?? {},
            actor: context.actorId
          })
        })
      );
    },
    true
  );
  register(
    "post",
    "/api/v1/management/roles/:role_id/assign",
    (request, reply, context) => {
      const input = body(request);
      const params = request.params;
      return sendResult(
        request,
        reply,
        managementRoute({
          request,
          reply,
          context,
          commandKind: "management.role.assign",
          scope: { resourceType: "role", resourceId: params.role_id },
          payload: input,
          idempotencyKey: field(input, "idempotency_key"),
          handler: () => options.management.roles.assign({
            projectId: context.defaultProjectId,
            roleId: params.role_id,
            ...input.session_id === void 0 ? {} : { sessionId: field(input, "session_id") },
            ...input.generation_id === void 0 ? {} : { generationId: field(input, "generation_id") },
            actor: context.actorId,
            idempotencyKey: field(input, "idempotency_key")
          })
        })
      );
    },
    true
  );
  register("get", "/api/v1/management/gates", (_request, reply, context) => {
    return sendResult(
      _request,
      reply,
      options.management.gates.list(context.defaultProjectId)
    );
  });
  register(
    "post",
    "/api/v1/management/gates",
    (request, reply, context) => {
      const input = body(request);
      return sendResult(
        request,
        reply.code(201),
        managementRoute({
          request,
          reply,
          context,
          commandKind: "management.gate.create",
          scope: { resourceType: "gate", resourceId: "*" },
          payload: input,
          idempotencyKey: field(input, "idempotency_key"),
          handler: () => options.management.gates.create({
            projectId: context.defaultProjectId,
            kind: input.kind,
            question: field(input, "question"),
            assignee: field(input, "assignee"),
            idempotencyKey: field(input, "idempotency_key"),
            actor: context.actorId
          })
        })
      );
    },
    true
  );
  register(
    "post",
    "/api/v1/management/gates/:gate_id/verdict",
    (request, reply, context) => {
      const input = body(request);
      const params = request.params;
      return sendResult(
        request,
        reply,
        managementRoute({
          request,
          reply,
          context,
          commandKind: "management.gate.answer",
          scope: { resourceType: "gate", resourceId: params.gate_id },
          payload: input,
          handler: () => options.management.gates.answer({
            projectId: context.defaultProjectId,
            gateId: params.gate_id,
            status: input.status,
            verdict: input.verdict ?? {},
            actor: context.actorId
          })
        })
      );
    },
    true
  );
  register("get", "/api/v1/management/ideas", (_request, reply, context) => {
    return sendResult(
      _request,
      reply,
      options.management.ideas.list(context.defaultProjectId)
    );
  });
  register(
    "post",
    "/api/v1/management/ideas",
    (request, reply, context) => {
      const input = body(request);
      return sendResult(
        request,
        reply.code(201),
        managementRoute({
          request,
          reply,
          context,
          commandKind: "management.idea.create",
          scope: { resourceType: "idea", resourceId: "*" },
          payload: input,
          idempotencyKey: field(input, "idempotency_key"),
          handler: () => options.management.ideas.create({
            projectId: context.defaultProjectId,
            body: field(input, "body"),
            idempotencyKey: field(input, "idempotency_key"),
            actor: context.actorId
          })
        })
      );
    },
    true
  );
  register(
    "post",
    "/api/v1/management/ideas/:idea_id/pop",
    (request, reply, context) => {
      const input = body(request);
      const params = request.params;
      return sendResult(
        request,
        reply,
        managementRoute({
          request,
          reply,
          context,
          commandKind: "management.idea.pop",
          scope: { resourceType: "idea", resourceId: params.idea_id },
          payload: input,
          handler: () => options.management.ideas.pop({
            projectId: context.defaultProjectId,
            ideaId: params.idea_id,
            actor: context.actorId
          })
        })
      );
    },
    true
  );
  register(
    "post",
    "/api/v1/management/ideas/:idea_id/promote",
    (request, reply, context) => {
      const input = body(request);
      const params = request.params;
      return sendResult(
        request,
        reply,
        managementRoute({
          request,
          reply,
          context,
          commandKind: "management.idea.promote",
          scope: { resourceType: "idea", resourceId: params.idea_id },
          payload: input,
          handler: () => options.management.ideas.promote({
            projectId: context.defaultProjectId,
            ideaId: params.idea_id,
            actor: context.actorId,
            ...input.title === void 0 ? {} : { title: field(input, "title") }
          })
        })
      );
    },
    true
  );
  register(
    "post",
    "/api/v1/management/communications",
    (request, reply, context) => {
      const input = body(request);
      return sendResult(
        request,
        reply.code(201),
        managementRoute({
          request,
          reply,
          context,
          commandKind: "management.communication.create",
          scope: { resourceType: "communication", resourceId: "*" },
          payload: input,
          idempotencyKey: field(input, "idempotency_key"),
          handler: () => options.management.communications.create({
            projectId: context.defaultProjectId,
            kind: input.kind,
            command: field(input, "command"),
            payload: input.payload ?? {},
            ...input.session_id === void 0 ? {} : { sessionId: field(input, "session_id") },
            ...input.generation_id === void 0 ? {} : { generationId: field(input, "generation_id") },
            actor: context.actorId,
            idempotencyKey: field(input, "idempotency_key")
          })
        })
      );
    },
    true
  );
  register(
    "post",
    "/api/v1/management/control",
    (request, reply, context) => {
      const input = body(request);
      return sendResult(
        request,
        reply.code(201),
        managementRoute({
          request,
          reply,
          context,
          commandKind: "management.control.request",
          scope: { resourceType: "control", resourceId: "*" },
          payload: input,
          idempotencyKey: field(input, "idempotency_key"),
          handler: () => options.management.controls.request({
            projectId: context.defaultProjectId,
            command: field(input, "command"),
            payload: input.payload ?? {},
            ...input.session_id === void 0 ? {} : { sessionId: field(input, "session_id") },
            ...input.generation_id === void 0 ? {} : { generationId: field(input, "generation_id") },
            actor: context.actorId,
            idempotencyKey: field(input, "idempotency_key")
          })
        })
      );
    },
    true
  );
  register(
    "get",
    "/api/v1/management/control/:operation_id",
    (_request, reply, context) => {
      const params = _request.params;
      return sendResult(
        _request,
        reply,
        options.management.controls.get({
          projectId: context.defaultProjectId,
          id: params.operation_id
        })
      );
    }
  );
  register("get", "/api/v1/management/control", (_request, reply, context) => {
    return sendResult(
      _request,
      reply,
      options.management.controls.list(context.defaultProjectId)
    );
  });
  register("get", "/api/v1/management/audit", (_request, reply, context) => {
    return sendResult(
      _request,
      reply,
      options.management.audit(context.defaultProjectId)
    );
  });
  register(
    "post",
    "/api/v1/management/assets",
    (request, reply, context) => {
      const input = body(request);
      const encoded = field(input, "content_base64");
      if (encoded.length > 14e6)
        throw new TrackerManagementError(
          "management.asset_invalid",
          "asset content is too large"
        );
      let bytes;
      try {
        bytes = new Uint8Array(Buffer.from(encoded, "base64"));
      } catch {
        throw new TrackerManagementError(
          "management.asset_invalid",
          "asset content is not valid base64"
        );
      }
      return sendResult(
        request,
        reply.code(201),
        publicAsset(
          managementRoute({
            request,
            reply,
            context,
            commandKind: "management.asset.put",
            scope: {
              resourceType: "asset",
              resourceId: field(input, "ticket_id")
            },
            payload: input,
            handler: () => options.management.assets.put({
              projectId: context.defaultProjectId,
              ticketId: field(input, "ticket_id"),
              relativePath: field(input, "relative_path"),
              mimeType: field(input, "mime_type"),
              bytes,
              actor: context.actorId
            })
          })
        )
      );
    },
    true
  );
  register(
    "get",
    "/api/v1/management/assets/:asset_id",
    (_request, reply, context) => {
      const params = _request.params;
      const value2 = options.management.assets.read({
        projectId: context.defaultProjectId,
        ticketId: field(_request.query, "ticket_id"),
        assetId: params.asset_id
      });
      return sendResult(_request, reply, {
        asset: publicAsset(value2.asset),
        content_base64: Buffer.from(value2.bytes).toString("base64")
      });
    }
  );
}

// apps/control-plane/src/routes.ts
import { z as z25 } from "zod";

// apps/control-plane/src/openapi.ts
import { z as z24 } from "zod";

// apps/control-plane/src/schemas.ts
import { z as z23 } from "zod";
var ApiErrorResponseJsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "code", "message", "correlation_id"],
  properties: {
    schema_version: { type: "string", const: "golem.api-error/v1" },
    code: { type: "string", minLength: 1, maxLength: 128 },
    message: { type: "string", minLength: 1, maxLength: 1024 },
    correlation_id: { type: "string", minLength: 1, maxLength: 128 },
    details: {
      type: "object",
      propertyNames: { type: "string" },
      additionalProperties: true
    }
  }
});
var ControlPlaneStreams = [
  "runtime.live",
  "runtime.history",
  "runtime.diagnostics",
  "projects",
  "tracker.tree",
  "tracker.board",
  "management.controls",
  "communication.operations"
];
var HealthResponseSchema = z23.object({
  schema_version: z23.literal("golem.control-plane-health/v1"),
  status: z23.enum(["live", "ready"]),
  instance_id: z23.string().regex(/^cpi_[0-9a-f-]{36}$/iu),
  runtime: z23.object({
    inbox: z23.object({
      pending: z23.number().int().nonnegative(),
      processing: z23.number().int().nonnegative(),
      archived: z23.number().int().nonnegative(),
      quarantined: z23.number().int().nonnegative(),
      retrying: z23.number().int().nonnegative(),
      oldestPendingAgeMs: z23.number().nonnegative().optional(),
      oldestRetryAgeMs: z23.number().nonnegative().optional()
    }).strict(),
    outbox: z23.object({
      pending: z23.number().int().nonnegative(),
      claimed: z23.number().int().nonnegative(),
      published: z23.number().int().nonnegative(),
      permanentFailures: z23.number().int().nonnegative(),
      oldestRetryAgeMs: z23.number().nonnegative().optional(),
      lastSuccessAt: z23.string().datetime().optional()
    }).strict(),
    lastSuccessfulMaterializationAt: z23.string().datetime().optional(),
    lastTickError: z23.literal("runtime tick deferred").optional()
  }).strict().optional()
}).strict();
var MetaResponseSchema = z23.object({
  schema_version: z23.literal("golem.control-plane-meta/v1"),
  instance_id: z23.string().regex(/^cpi_[0-9a-f-]{36}$/iu),
  service: z23.literal("control-plane"),
  projections: z23.array(z23.string()).max(16)
}).strict();
var ProjectionParamsSchema = z23.object({
  stream: z23.enum(ControlPlaneStreams)
}).strict();
var ProjectionResponseSchema = z23.object({
  schema_version: z23.literal("golem.control-plane-projection/v1"),
  stream: ProjectionParamsSchema.shape.stream,
  resource_revision: z23.number().int().nonnegative(),
  payload: z23.record(z23.string(), z23.unknown())
}).strict();
var RuntimeProjectionQuerySchema = z23.object({
  project_id: z23.string().min(1).max(256).optional(),
  cursor: z23.coerce.number().int().nonnegative().max(1e6).optional(),
  limit: z23.coerce.number().int().min(1).max(100).optional(),
  state: z23.string().min(1).max(32).optional()
}).strict();
var RuntimeProjectionItemSchema = z23.record(z23.string(), z23.unknown());
var RuntimeProjectionResponseSchema = z23.object({
  schema_version: z23.literal("golem.runtime-projection/v1"),
  stream: z23.enum(["runtime.live", "runtime.history", "runtime.diagnostics"]),
  resource_revision: z23.number().int().nonnegative(),
  cursor: z23.number().int().nonnegative(),
  next_cursor: z23.number().int().nonnegative().optional(),
  generated_at: z23.iso.datetime({ offset: true }),
  items: z23.array(RuntimeProjectionItemSchema).max(100),
  explain: z23.record(z23.string(), z23.unknown()),
  observation: z23.record(z23.string(), z23.unknown()),
  drift: z23.record(z23.string(), z23.unknown())
}).strict();
var BrowserSessionResponseSchema = z23.object({
  schema_version: z23.literal("golem.control-plane-browser-session/v1"),
  csrf_token: z23.string().min(24).max(256)
}).strict();
var BrowserEchoBodySchema = z23.object({ value: z23.string().min(1).max(256) }).strict();
var BrowserEchoResponseSchema = z23.object({
  schema_version: z23.literal("golem.control-plane-browser-echo/v1"),
  value: z23.string().min(1).max(256)
}).strict();
var RuntimeIngestReceiptSchema = z23.object({
  schema_version: z23.literal("golem.runtime-ingest-receipt/v1"),
  event_id: z23.string().min(1).max(256),
  status: z23.enum(["spooled", "already_pending"])
}).strict();
var RuntimeIngestRequestSchema = z23.object({
  schema_version: z23.literal("golem.runtime-signal/v1"),
  event_id: z23.string().min(1).max(256),
  event_kind: z23.enum(RuntimeSignalKinds),
  producer: z23.string().min(1).max(128),
  producer_instance_id: z23.string().min(1).max(256),
  harness: z23.enum(["claude", "codex", "opencode", "pi"]),
  producer_sequence: z23.number().int().nonnegative().optional(),
  correlation_id: z23.string().min(1).max(128),
  causation_id: z23.string().min(1).max(256).optional(),
  deduplication_key: z23.string().min(1).max(256),
  owner_fence: z23.string().min(1).max(256).optional(),
  clocks: z23.object({
    source_observed_at: z23.iso.datetime({ offset: true }),
    source_event_at: z23.iso.datetime({ offset: true }).optional(),
    received_at: z23.iso.datetime({ offset: true }),
    materialized_at: z23.iso.datetime({ offset: true }).optional()
  }).strict(),
  provenance: z23.object({
    source: z23.enum([
      "adapter",
      "api",
      "launcher",
      "legacy_import",
      "migration"
    ]),
    evidence_id: z23.string().min(1).max(256).optional(),
    confidence: z23.enum(["verified", "observed", "inferred", "legacy"])
  }).strict(),
  clear_fields: z23.array(z23.string().min(1).max(160)).max(64),
  payload: z23.record(z23.string(), z23.unknown())
}).strict();
var OpenApiDocumentSchema = z23.object({
  openapi: z23.literal("3.1.1"),
  info: z23.object({ title: z23.string(), version: z23.string() }).strict(),
  paths: z23.record(z23.string(), z23.unknown())
}).passthrough();

// apps/control-plane/src/openapi.ts
function schema(value2) {
  return z24.toJSONSchema(value2, {
    target: "draft-2020-12",
    unrepresentable: "any",
    reused: "inline"
  });
}
function response(description, value2) {
  return {
    description,
    content: { "application/json": { schema: schema(value2) } }
  };
}
var legacyProjectionOpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "stream", "resource_revision", "payload"],
  properties: {
    schema_version: {
      type: "string",
      const: "golem.control-plane-projection/v1"
    },
    stream: {
      type: "string",
      enum: [
        "runtime.live",
        "runtime.history",
        "runtime.diagnostics",
        "projects"
      ]
    },
    resource_revision: { type: "integer", minimum: 0 },
    payload: {}
  }
};
function projectionResponse() {
  return {
    description: "legacy projection or bounded browser-work projection",
    content: {
      "application/json": {
        schema: {
          oneOf: [
            legacyProjectionOpenApiSchema,
            schema(BrowserWorkProjectionResponseSchema)
          ]
        }
      }
    }
  };
}
var error = ApiErrorResponseJsonSchema;
var managementResult = {
  type: "object",
  additionalProperties: true,
  properties: {
    schema_version: { type: "string", const: "golem.management/v1" },
    result: {}
  },
  required: ["schema_version", "result"]
};
function managementResponses() {
  return {
    "200": {
      description: "management result",
      content: { "application/json": { schema: managementResult } }
    },
    "201": {
      description: "management result",
      content: { "application/json": { schema: managementResult } }
    },
    "400": {
      description: "invalid management request",
      content: { "application/json": { schema: error } }
    },
    "401": {
      description: "unauthorized",
      content: { "application/json": { schema: error } }
    },
    "403": {
      description: "forbidden",
      content: { "application/json": { schema: error } }
    },
    "404": {
      description: "not found",
      content: { "application/json": { schema: error } }
    },
    "409": {
      description: "conflict",
      content: { "application/json": { schema: error } }
    }
  };
}
function typedApiResponses() {
  return {
    "200": {
      description: "typed result",
      content: {
        "application/json": {
          schema: { type: "object", additionalProperties: true }
        }
      }
    },
    "201": {
      description: "typed command accepted",
      content: {
        "application/json": {
          schema: { type: "object", additionalProperties: true }
        }
      }
    },
    "400": {
      description: "invalid request",
      content: { "application/json": { schema: error } }
    },
    "401": {
      description: "unauthorized",
      content: { "application/json": { schema: error } }
    },
    "403": {
      description: "caller rejected",
      content: { "application/json": { schema: error } }
    },
    "404": {
      description: "not found",
      content: { "application/json": { schema: error } }
    },
    "409": {
      description: "optimistic conflict",
      content: { "application/json": { schema: error } }
    }
  };
}
function typedApiPaths() {
  const body3 = (schemaValue = {
    type: "object",
    additionalProperties: true
  }) => ({
    required: true,
    content: { "application/json": { schema: schemaValue } }
  });
  const compareAndSwapBody = {
    type: "object",
    additionalProperties: true,
    required: ["expected_revision"],
    properties: {
      expected_revision: { type: "integer", minimum: 1 }
    }
  };
  const path19 = (operationId, method, requestBody = false) => ({
    [method]: {
      operationId,
      ...requestBody ? {
        requestBody: body3(requestBody === true ? void 0 : requestBody)
      } : {},
      responses: typedApiResponses()
    }
  });
  return {
    "/api/v1/tracker/tickets": {
      get: path19("trackerListTickets", "get").get,
      post: path19("trackerCreateTicket", "post", true).post
    },
    "/api/v1/tracker/tickets/search": {
      get: path19("trackerSearchTickets", "get").get
    },
    "/api/v1/tracker/tickets/{id}": {
      get: path19("trackerGetTicket", "get").get,
      patch: path19("trackerUpdateTicket", "patch", compareAndSwapBody).patch
    },
    "/api/v1/tracker/tickets/{id}/transition": {
      post: path19("trackerTransitionTicket", "post", compareAndSwapBody).post
    },
    "/api/v1/tracker/tickets/{id}/close": {
      post: path19("trackerExceptionalClose", "post", true).post
    },
    "/api/v1/tracker/tickets/{id}/comments": {
      post: path19("trackerAddComment", "post", true).post
    },
    "/api/v1/tracker/tickets/{id}/comments/{commentId}": {
      patch: path19("trackerUpdateComment", "patch", true).patch
    },
    "/api/v1/tracker/tickets/{id}/comments/{commentId}/reply": {
      post: path19("trackerReplyComment", "post", true).post
    },
    "/api/v1/tracker/streams": {
      get: path19("trackerListStreams", "get").get,
      post: path19("trackerUpsertStream", "post", true).post
    },
    "/api/v1/delivery/envelopes": {
      post: path19("deliveryEnqueue", "post", true).post
    },
    "/api/v1/delivery/claims": {
      post: path19("deliveryClaim", "post", true).post
    },
    "/api/v1/delivery/claims/{token}/prepare": {
      post: path19("deliveryPrepare", "post").post
    },
    "/api/v1/delivery/claims/{token}/ack": {
      post: path19("deliveryAcknowledge", "post", true).post
    },
    "/api/v1/delivery/claims/{token}/delivered": {
      post: path19("deliveryDelivered", "post").post
    },
    "/api/v1/delivery/claims/{token}/fail": {
      post: path19("deliveryFail", "post", true).post
    },
    "/api/v1/bus/events": {
      get: path19("busList", "get").get,
      post: path19("busAppend", "post", true).post
    },
    "/api/v1/subscriptions": {
      get: path19("subscriptionsList", "get").get,
      post: path19("subscriptionsCreate", "post", true).post
    },
    "/api/v1/subscriptions/unsubscribe": {
      post: path19("subscriptionsUnsubscribe", "post", true).post
    },
    "/api/v1/subscriptions/{id}/pending": {
      get: path19("subscriptionsPending", "get").get
    },
    "/api/v1/subscriptions/{id}/commit": {
      post: path19("subscriptionsCommit", "post", true).post
    }
  };
}
function controlPlaneOpenApiDocument() {
  return {
    openapi: "3.1.1",
    info: { title: "Golem control plane", version: "v1" },
    components: {
      securitySchemes: {
        BrowserSession: {
          type: "apiKey",
          in: "cookie",
          name: "golem_control_plane_session",
          description: "Same-origin HttpOnly browser session; never a bearer credential."
        },
        BrowserCsrf: {
          type: "apiKey",
          in: "header",
          name: "x-golem-csrf",
          description: "Same-origin mutation proof paired with BrowserSession."
        },
        BearerAuth: { type: "http", scheme: "bearer" }
      }
    },
    paths: {
      ...typedApiPaths(),
      "/api/v1/management/roles": {
        get: {
          operationId: "managementListRoles",
          parameters: [
            {
              name: "project_id",
              in: "query",
              required: true,
              schema: { type: "string" }
            }
          ],
          responses: managementResponses()
        },
        post: {
          operationId: "managementCreateRole",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true }
              }
            }
          },
          responses: managementResponses()
        }
      },
      "/api/v1/management/roles/{role_id}/assign": {
        post: {
          operationId: "managementAssignRole",
          parameters: [
            {
              name: "role_id",
              in: "path",
              required: true,
              schema: { type: "string" }
            }
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true }
              }
            }
          },
          responses: managementResponses()
        }
      },
      "/api/v1/management/gates": {
        get: {
          operationId: "managementListGates",
          parameters: [
            {
              name: "project_id",
              in: "query",
              required: true,
              schema: { type: "string" }
            }
          ],
          responses: managementResponses()
        },
        post: {
          operationId: "managementCreateGate",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true }
              }
            }
          },
          responses: managementResponses()
        }
      },
      "/api/v1/management/gates/{gate_id}/verdict": {
        post: {
          operationId: "managementAnswerGate",
          parameters: [
            {
              name: "gate_id",
              in: "path",
              required: true,
              schema: { type: "string" }
            }
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true }
              }
            }
          },
          responses: managementResponses()
        }
      },
      "/api/v1/management/ideas": {
        get: {
          operationId: "managementListIdeas",
          parameters: [
            {
              name: "project_id",
              in: "query",
              required: true,
              schema: { type: "string" }
            }
          ],
          responses: managementResponses()
        },
        post: {
          operationId: "managementCreateIdea",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true }
              }
            }
          },
          responses: managementResponses()
        }
      },
      "/api/v1/management/ideas/{idea_id}/pop": {
        post: {
          operationId: "managementPopIdea",
          parameters: [
            {
              name: "idea_id",
              in: "path",
              required: true,
              schema: { type: "string" }
            }
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true }
              }
            }
          },
          responses: managementResponses()
        }
      },
      "/api/v1/management/ideas/{idea_id}/promote": {
        post: {
          operationId: "managementPromoteIdea",
          parameters: [
            {
              name: "idea_id",
              in: "path",
              required: true,
              schema: { type: "string" }
            }
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true }
              }
            }
          },
          responses: managementResponses()
        }
      },
      "/api/v1/management/communications": {
        post: {
          operationId: "managementCreateCommunication",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true }
              }
            }
          },
          responses: managementResponses()
        }
      },
      "/api/v1/management/control": {
        get: {
          operationId: "managementListControls",
          parameters: [
            {
              name: "project_id",
              in: "query",
              required: true,
              schema: { type: "string" }
            }
          ],
          responses: managementResponses()
        },
        post: {
          operationId: "managementCreateControl",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true }
              }
            }
          },
          responses: managementResponses()
        }
      },
      "/api/v1/management/control/{operation_id}": {
        get: {
          operationId: "managementGetControl",
          parameters: [
            {
              name: "operation_id",
              in: "path",
              required: true,
              schema: { type: "string" }
            },
            {
              name: "project_id",
              in: "query",
              required: true,
              schema: { type: "string" }
            }
          ],
          responses: managementResponses()
        }
      },
      "/api/v1/management/assets": {
        post: {
          operationId: "managementPutAsset",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true }
              }
            }
          },
          responses: managementResponses()
        }
      },
      "/api/v1/management/assets/{asset_id}": {
        get: {
          operationId: "managementGetAsset",
          parameters: [
            {
              name: "asset_id",
              in: "path",
              required: true,
              schema: { type: "string" }
            },
            {
              name: "project_id",
              in: "query",
              required: true,
              schema: { type: "string" }
            },
            {
              name: "ticket_id",
              in: "query",
              required: true,
              schema: { type: "string" }
            }
          ],
          responses: managementResponses()
        }
      },
      "/api/v1/management/audit": {
        get: {
          operationId: "managementAudit",
          parameters: [
            {
              name: "project_id",
              in: "query",
              required: true,
              schema: { type: "string" }
            }
          ],
          responses: managementResponses()
        }
      },
      "/api/v1/runtime/events": {
        post: {
          operationId: "controlPlaneRuntimeIngest",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: schema(RuntimeIngestRequestSchema)
              }
            }
          },
          responses: {
            "202": response("durably spooled", RuntimeIngestReceiptSchema),
            "400": {
              description: "invalid runtime signal",
              content: { "application/json": { schema: error } }
            },
            "401": {
              description: "unauthorized",
              content: { "application/json": { schema: error } }
            },
            "503": {
              description: "runtime ingress unavailable",
              content: { "application/json": { schema: error } }
            }
          }
        }
      },
      "/api/v1/runtime/{stream}": {
        get: {
          operationId: "runtimeProjection",
          parameters: [
            {
              name: "stream",
              in: "path",
              required: true,
              schema: {
                type: "string",
                enum: ["live", "history", "diagnostics"]
              }
            },
            {
              name: "project_id",
              in: "query",
              required: false,
              schema: { type: "string", maxLength: 256 }
            },
            {
              name: "cursor",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 0, maximum: 1e6 }
            },
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 1, maximum: 100 }
            }
          ],
          responses: {
            "200": response(
              "runtime projection",
              RuntimeProjectionResponseSchema
            ),
            "401": {
              description: "unauthorized",
              content: { "application/json": { schema: error } }
            },
            "400": {
              description: "invalid projection query",
              content: { "application/json": { schema: error } }
            },
            "503": {
              description: "runtime projection unavailable",
              content: { "application/json": { schema: error } }
            }
          }
        }
      },
      "/api/v1/health/live": {
        get: {
          operationId: "controlPlaneLive",
          responses: { "200": response("live", HealthResponseSchema) }
        }
      },
      "/api/v1/health/ready": {
        get: {
          operationId: "controlPlaneReady",
          responses: {
            "200": response("ready", HealthResponseSchema),
            "401": {
              description: "unauthorized",
              content: { "application/json": { schema: error } }
            }
          }
        }
      },
      "/api/v1/meta": {
        get: {
          operationId: "controlPlaneMeta",
          responses: {
            "200": response("metadata", MetaResponseSchema),
            "401": {
              description: "unauthorized",
              content: { "application/json": { schema: error } }
            }
          }
        }
      },
      "/api/v1/projections/{stream}": {
        get: {
          operationId: "controlPlaneProjection",
          security: [{ BrowserSession: [] }],
          parameters: [
            {
              name: "stream",
              in: "path",
              required: true,
              schema: {
                type: "string",
                enum: [
                  "runtime.live",
                  "runtime.history",
                  "runtime.diagnostics",
                  "projects",
                  "tracker.board",
                  "tracker.tree",
                  "management.controls",
                  "communication.operations"
                ]
              }
            },
            {
              name: "cursor",
              in: "query",
              required: false,
              description: "Opaque browser-work page cursor; never a publication or project cursor.",
              schema: {
                type: "string",
                pattern: "^bwp_[0-9]{1,8}$",
                maxLength: 12
              }
            }
          ],
          responses: {
            "200": projectionResponse(),
            "401": {
              description: "unauthorized",
              content: { "application/json": { schema: error } }
            }
          }
        }
      },
      "/api/v1/browser/work/items/{opaque_id}": {
        get: {
          operationId: "browserWorkItem",
          security: [{ BrowserSession: [] }],
          parameters: [
            {
              name: "opaque_id",
              in: "path",
              required: true,
              schema: { type: "string", maxLength: 128 }
            }
          ],
          responses: {
            "200": response(
              "bounded browser work item",
              BrowserWorkDetailResponseSchema
            ),
            "400": response("invalid item identifier", BrowserWorkErrorSchema),
            "401": response("browser session required", BrowserWorkErrorSchema),
            "403": response(
              "browser authority rejected",
              BrowserWorkErrorSchema
            ),
            "404": response("item absent", BrowserWorkErrorSchema)
          }
        }
      },
      "/api/v1/browser/work/items/{opaque_id}/assets/{asset_id}": {
        get: {
          operationId: "browserWorkAsset",
          security: [{ BrowserSession: [] }],
          parameters: [
            {
              name: "opaque_id",
              in: "path",
              required: true,
              schema: { type: "string", maxLength: 128 }
            },
            {
              name: "asset_id",
              in: "path",
              required: true,
              schema: { type: "string", maxLength: 128 }
            }
          ],
          responses: {
            "200": response(
              "bounded ticket asset",
              BrowserWorkAssetResponseSchema
            ),
            "400": response("invalid asset identifier", BrowserWorkErrorSchema),
            "401": response("browser session required", BrowserWorkErrorSchema),
            "403": response(
              "browser authority rejected",
              BrowserWorkErrorSchema
            ),
            "404": response("asset absent", BrowserWorkErrorSchema)
          }
        }
      },
      "/api/v1/browser/work/commands": {
        post: {
          operationId: "browserWorkCommand",
          security: [{ BrowserSession: [], BrowserCsrf: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: schema(BrowserWorkCommandRequestSchema)
              }
            }
          },
          responses: {
            "200": response(
              "typed browser command outcome",
              BrowserWorkCommandResponseSchema
            ),
            "400": response("invalid command", BrowserWorkErrorSchema),
            "401": response(
              "browser session or CSRF required",
              BrowserWorkErrorSchema
            ),
            "403": response(
              "browser authority rejected",
              BrowserWorkErrorSchema
            ),
            "404": response("resource absent", BrowserWorkErrorSchema),
            "409": response(
              "canonical command conflict or typed unsupported outcome",
              z24.union([
                BrowserWorkCommandResponseSchema,
                BrowserWorkErrorSchema
              ])
            )
          }
        }
      },
      "/api/v1/browser/settings": {
        get: {
          operationId: "browserSettings",
          security: [{ BrowserSession: [] }],
          responses: {
            "200": response(
              "bounded settings and capability snapshot",
              BrowserSettingsSnapshotSchema
            ),
            "400": response(
              "invalid settings request",
              BrowserSettingsErrorSchema
            ),
            "401": response(
              "browser session required",
              BrowserSettingsErrorSchema
            ),
            "403": response(
              "browser authority rejected",
              BrowserSettingsErrorSchema
            ),
            "503": response(
              "settings authority unavailable",
              BrowserSettingsErrorSchema
            )
          }
        }
      },
      "/api/v1/browser/settings/commands": {
        post: {
          operationId: "browserSettingsCommand",
          security: [{ BrowserSession: [], BrowserCsrf: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: schema(BrowserSettingsCommandRequestSchema)
              }
            }
          },
          responses: {
            "200": response(
              "durable settings command outcome",
              BrowserSettingsCommandResponseSchema
            ),
            "400": response(
              "invalid settings command",
              BrowserSettingsErrorSchema
            ),
            "401": response(
              "browser session or CSRF required",
              BrowserSettingsErrorSchema
            ),
            "403": response(
              "browser authority rejected",
              BrowserSettingsErrorSchema
            ),
            "409": response(
              "settings command conflict",
              BrowserSettingsErrorSchema
            ),
            "503": response(
              "settings authority unavailable",
              BrowserSettingsErrorSchema
            )
          }
        }
      },
      "/api/v1/browser/session": {
        post: {
          operationId: "controlPlaneBrowserSession",
          responses: {
            "200": response("browser session", BrowserSessionResponseSchema),
            "401": {
              description: "unauthorized",
              content: { "application/json": { schema: error } }
            }
          }
        }
      },
      "/api/v1/browser/echo": {
        post: {
          operationId: "controlPlaneBrowserEcho",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: schema(BrowserEchoBodySchema) }
            }
          },
          responses: {
            "200": response("echo", BrowserEchoResponseSchema),
            "400": {
              description: "invalid request",
              content: { "application/json": { schema: error } }
            },
            "401": {
              description: "unauthorized",
              content: { "application/json": { schema: error } }
            },
            "403": {
              description: "csrf failed",
              content: { "application/json": { schema: error } }
            },
            "409": {
              description: "canonical revision regressed",
              content: { "application/json": { schema: error } }
            }
          }
        }
      }
    }
  };
}

// apps/control-plane/src/routes.ts
function jsonSchema4(value2) {
  return z25.toJSONSchema(value2, {
    // Fastify's built-in validator is draft-07; the generated OpenAPI document
    // keeps its independent 2020-12 representation in openapi.ts.
    target: "draft-7",
    unrepresentable: "any",
    reused: "inline"
  });
}
function resolvePrincipal(request, reply, principal, action, allowBrowser, authorityOverride = hasRequestAuthorityOverride(request)) {
  if (authorityOverride) {
    fail(
      request,
      reply,
      403,
      "browser.forbidden",
      "request authority is server-owned"
    );
    return void 0;
  }
  const context = principal.resolve(request, {
    action,
    allowBrowser,
    allowBearer: true
  });
  if (!context) {
    fail(
      request,
      reply,
      401,
      "browser.auth.required",
      "an authenticated principal binding is required"
    );
    return void 0;
  }
  if (!principal.policy.allows(context, action)) {
    fail(
      request,
      reply,
      403,
      "browser.forbidden",
      "the authenticated principal is not authorized"
    );
    return void 0;
  }
  return context;
}
function requirePrincipal(request, reply, principal, action, allowBrowser) {
  return resolvePrincipal(request, reply, principal, action, allowBrowser) !== void 0;
}
function requireRuntimeProjectionRead(request, reply, principal, projectId2) {
  const context = resolvePrincipal(
    request,
    reply,
    principal,
    "read",
    true,
    hasRequestAuthorityHeaderOrBodyOverride(request)
  );
  if (!context) return false;
  if (projectId2 && !principal.policy.allowsProject(context, projectId2)) {
    fail(
      request,
      reply,
      404,
      "runtime.not_found",
      "the requested runtime projection is unavailable"
    );
    return false;
  }
  return true;
}
function requireBearer(request, reply, principal) {
  if (requirePrincipal(request, reply, principal, "read", false)) return true;
  return false;
}
function requireBrowserRead(request, reply, principal) {
  return requirePrincipal(request, reply, principal, "read", true);
}
function registerValidatedRoutes(options) {
  const responseSchemas = {
    400: ApiErrorResponseJsonSchema,
    401: ApiErrorResponseJsonSchema,
    403: ApiErrorResponseJsonSchema,
    409: ApiErrorResponseJsonSchema,
    500: ApiErrorResponseJsonSchema,
    503: ApiErrorResponseJsonSchema
  };
  options.app.get(
    "/api/v1/runtime/:stream",
    {
      schema: {
        params: jsonSchema4(
          z25.object({
            stream: z25.enum(["live", "history", "diagnostics"])
          })
        ),
        querystring: jsonSchema4(RuntimeProjectionQuerySchema),
        response: {
          200: jsonSchema4(RuntimeProjectionResponseSchema),
          ...responseSchemas
        }
      }
    },
    async (request, reply) => {
      if (!options.runtimeProjection)
        return fail(
          request,
          reply,
          503,
          "runtime.projection_unavailable",
          "runtime projections are not composed"
        );
      const params = request.params;
      const runtimeStream = params.stream === "live" ? "runtime.live" : params.stream === "history" ? "runtime.history" : params.stream === "diagnostics" ? "runtime.diagnostics" : void 0;
      if (!runtimeStream)
        return fail(
          request,
          reply,
          400,
          "request.invalid",
          "runtime projection stream is invalid"
        );
      const queryResult = RuntimeProjectionQuerySchema.safeParse(request.query);
      if (!queryResult.success)
        return fail(
          request,
          reply,
          400,
          "request.invalid",
          "runtime projection query is invalid"
        );
      if (!requireRuntimeProjectionRead(
        request,
        reply,
        options.principal,
        queryResult.data.project_id
      ))
        return;
      try {
        const payload2 = options.runtimeProjection.query(runtimeStream, {
          ...queryResult.data.project_id ? { projectId: queryResult.data.project_id } : {},
          ...queryResult.data.cursor === void 0 ? {} : { cursor: queryResult.data.cursor },
          ...queryResult.data.limit === void 0 ? {} : { limit: queryResult.data.limit },
          ...queryResult.data.state ? { state: queryResult.data.state } : {}
        });
        return sendValidated(
          request,
          reply,
          RuntimeProjectionResponseSchema,
          payload2
        );
      } catch (error2) {
        return fail(
          request,
          reply,
          400,
          "request.invalid",
          error2 instanceof Error ? error2.message : "runtime projection query is invalid"
        );
      }
    }
  );
  options.app.get(
    "/api/v1/health/live",
    {
      schema: {
        response: { 200: jsonSchema4(HealthResponseSchema), ...responseSchemas }
      }
    },
    async (request, reply) => sendValidated(
      request,
      reply,
      HealthResponseSchema,
      options.invalidResponseForTest ? {
        schema_version: "golem.control-plane-health/v1",
        status: "invalid"
      } : {
        schema_version: "golem.control-plane-health/v1",
        status: "live",
        instance_id: options.instanceId,
        ...options.runtimeHealth ? { runtime: options.runtimeHealth.health() } : {}
      }
    )
  );
  options.app.get(
    "/api/v1/health/ready",
    {
      schema: {
        response: { 200: jsonSchema4(HealthResponseSchema), ...responseSchemas }
      }
    },
    async (request, reply) => {
      if (!requireBearer(request, reply, options.principal)) return;
      return sendValidated(request, reply, HealthResponseSchema, {
        schema_version: "golem.control-plane-health/v1",
        status: "ready",
        instance_id: options.instanceId,
        ...options.runtimeHealth ? { runtime: options.runtimeHealth.health() } : {}
      });
    }
  );
  options.app.get(
    "/api/v1/meta",
    {
      schema: {
        response: { 200: jsonSchema4(MetaResponseSchema), ...responseSchemas }
      }
    },
    async (request, reply) => {
      if (!requireBrowserRead(request, reply, options.principal)) return;
      return sendValidated(request, reply, MetaResponseSchema, {
        schema_version: "golem.control-plane-meta/v1",
        instance_id: options.instanceId,
        service: "control-plane",
        projections: ControlPlaneStreams
      });
    }
  );
  options.app.get(
    "/api/v1/openapi.json",
    {
      schema: {
        response: {
          200: jsonSchema4(OpenApiDocumentSchema),
          ...responseSchemas
        }
      }
    },
    async (request, reply) => {
      if (!requireBearer(request, reply, options.principal)) return;
      return sendValidated(
        request,
        reply,
        OpenApiDocumentSchema,
        controlPlaneOpenApiDocument()
      );
    }
  );
  options.app.get(
    "/api/v1/projections/:stream",
    {
      schema: {
        params: jsonSchema4(ProjectionParamsSchema),
        querystring: jsonSchema4(BrowserWorkProjectionQuerySchema),
        response: {
          200: jsonSchema4(
            z25.union([
              ProjectionResponseSchema,
              BrowserWorkProjectionResponseSchema
            ])
          ),
          ...responseSchemas
        }
      }
    },
    async (request, reply) => {
      const parsed = ProjectionParamsSchema.safeParse(request.params);
      if (!parsed.success)
        return fail(
          request,
          reply,
          400,
          "request.invalid",
          "projection stream is invalid"
        );
      const browserStream = BrowserWorkStreamSchema.safeParse(
        parsed.data.stream
      );
      if (browserStream.success && options.browserWork) {
        const query = BrowserWorkProjectionQuerySchema.safeParse(request.query);
        if (!query.success)
          return fail(
            request,
            reply,
            400,
            "request.invalid",
            "projection cursor is invalid"
          );
        if (hasRequestAuthorityOverride(request))
          return fail(
            request,
            reply,
            403,
            "browser.forbidden",
            "request authority is server-owned"
          );
        const context2 = options.principal.resolve(request, {
          action: "read",
          allowBrowser: true,
          allowBearer: false
        });
        if (!context2)
          return fail(
            request,
            reply,
            401,
            "browser.auth.required",
            "an authenticated browser session is required"
          );
        if (!options.principal.policy.allows(context2, "read"))
          return fail(
            request,
            reply,
            403,
            "browser.forbidden",
            "the authenticated principal is not authorized"
          );
        return reply.send(
          options.browserWork.projection(
            browserStream.data,
            context2.defaultProjectId,
            query.data.cursor
          )
        );
      }
      if (!requireBrowserRead(request, reply, options.principal)) return;
      const context = options.principal.resolve(request, {
        action: "read",
        allowBrowser: true,
        allowBearer: true
      });
      if (!context)
        return fail(
          request,
          reply,
          401,
          "browser.auth.required",
          "an authenticated principal binding is required"
        );
      const stream = parsed.data.stream;
      return sendValidated(request, reply, ProjectionResponseSchema, {
        schema_version: "golem.control-plane-projection/v1",
        stream,
        resource_revision: options.projection.revision(
          stream,
          context.defaultProjectId
        ),
        payload: options.projection.read(stream, context.defaultProjectId)
      });
    }
  );
  options.app.post(
    "/api/v1/runtime/events",
    {
      schema: {
        body: jsonSchema4(RuntimeIngestRequestSchema),
        response: {
          202: jsonSchema4(RuntimeIngestReceiptSchema),
          ...responseSchemas
        }
      }
    },
    async (request, reply) => {
      if (!requirePrincipal(request, reply, options.principal, "mutate", false))
        return;
      if (!options.runtimeIngress)
        return fail(
          request,
          reply,
          503,
          "runtime.unavailable",
          "durable runtime ingress is not composed"
        );
      const parsed = RuntimeSignalV1Schema.safeParse(request.body);
      if (!parsed.success)
        return fail(
          request,
          reply,
          400,
          "request.invalid",
          "runtime signal is invalid or uses an unsupported schema version"
        );
      const receipt = options.runtimeIngress.ingest(parsed.data);
      return sendValidated(
        request,
        reply.code(202),
        RuntimeIngestReceiptSchema,
        {
          schema_version: "golem.runtime-ingest-receipt/v1",
          event_id: receipt.eventId,
          status: receipt.status
        }
      );
    }
  );
  options.app.post(
    "/api/v1/browser/session",
    {
      schema: {
        response: {
          200: jsonSchema4(BrowserSessionResponseSchema),
          ...responseSchemas
        }
      }
    },
    async (request, reply) => {
      if (hasRequestAuthorityOverride(request))
        return fail(
          request,
          reply,
          403,
          "browser.forbidden",
          "request authority is server-owned"
        );
      if (!isExpectedOrigin(request.headers.origin, request))
        return fail(
          request,
          reply,
          401,
          "browser.auth.required",
          "an enabled local browser binding is required"
        );
      const session2 = options.principal.bootstrap(request);
      if (!session2.ok)
        return fail(
          request,
          reply,
          401,
          "browser.auth.required",
          "an enabled local browser binding is required"
        );
      reply.header("set-cookie", session2.setCookie);
      return sendValidated(request, reply, BrowserSessionResponseSchema, {
        schema_version: "golem.control-plane-browser-session/v1",
        csrf_token: session2.csrf
      });
    }
  );
  options.app.post(
    "/api/v1/browser/echo",
    {
      schema: {
        body: jsonSchema4(BrowserEchoBodySchema),
        response: {
          200: jsonSchema4(BrowserEchoResponseSchema),
          ...responseSchemas
        }
      }
    },
    async (request, reply) => {
      if (!requirePrincipal(request, reply, options.principal, "mutate", true))
        return;
      const context = options.principal.resolve(request, {
        action: "mutate",
        allowBrowser: true,
        allowBearer: true
      });
      const bearer2 = context?.source === "bearer";
      const parsed = BrowserEchoBodySchema.safeParse(request.body);
      if (!parsed.success)
        return fail(
          request,
          reply,
          400,
          "request.invalid",
          "browser echo body is invalid"
        );
      try {
        options.replay.publish(
          "runtime.live",
          options.projection.revision("runtime.live"),
          {
            kind: "browser_echoed",
            value: parsed.data.value,
            transport: bearer2 ? "bearer" : "browser"
          }
        );
      } catch (error2) {
        if (error2 instanceof Error && error2.message.includes("resource revision must not regress"))
          return fail(
            request,
            reply,
            409,
            "revision.regressed",
            "canonical resource revision regressed"
          );
        throw error2;
      }
      options.legacy.publish({
        type: "projects-list",
        projects: [
          {
            id: "control-plane-browser-echo",
            name: parsed.data.value,
            path: null,
            phase: "drafting"
          }
        ]
      });
      return sendValidated(request, reply, BrowserEchoResponseSchema, {
        schema_version: "golem.control-plane-browser-echo/v1",
        value: parsed.data.value
      });
    }
  );
}

// apps/control-plane/src/service-lock.ts
import crypto21 from "node:crypto";
import fs14 from "node:fs";
import path16 from "node:path";
function lockPathFor(stateDirectory2) {
  return path16.join(stateDirectory2, "control-plane.lock");
}
function recoveryPath(lockPath2) {
  return `${lockPath2}.recovery`;
}
function isCode4(error2, code) {
  return typeof error2 === "object" && error2 !== null && "code" in error2 && error2.code === code;
}
function processIsGone2(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error2) {
    return isCode4(error2, "ESRCH");
  }
}
function readRecord(lockPath2) {
  try {
    const parsed = JSON.parse(fs14.readFileSync(lockPath2, "utf8"));
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0 || typeof parsed.nonce !== "string" || !/^lock_[0-9a-f-]{36}$/iu.test(parsed.nonce) || typeof parsed.started_at !== "string")
      return void 0;
    return Object.freeze({
      pid: parsed.pid,
      nonce: parsed.nonce,
      started_at: parsed.started_at
    });
  } catch {
    return void 0;
  }
}
function serviceLockStatus(stateDirectory2) {
  const lockPath2 = lockPathFor(stateDirectory2);
  if (!fs14.existsSync(lockPath2))
    return Object.freeze({
      state: "absent",
      path: lockPath2,
      detail: "no owner lock exists"
    });
  const record2 = readRecord(lockPath2);
  if (!record2)
    return Object.freeze({
      state: "invalid",
      path: lockPath2,
      detail: "lock metadata is malformed; inspect or remove it manually"
    });
  if (processIsGone2(record2.pid))
    return Object.freeze({
      state: "stale",
      path: lockPath2,
      ownerPid: record2.pid,
      ownerNonce: record2.nonce,
      detail: `owner pid ${record2.pid} is gone and may be recovered`
    });
  return Object.freeze({
    state: "active",
    path: lockPath2,
    ownerPid: record2.pid,
    ownerNonce: record2.nonce,
    detail: `owner pid ${record2.pid} is still active`
  });
}
function reclaimStaleLock(lockPath2) {
  const guardPath2 = recoveryPath(lockPath2);
  let descriptor;
  let recovered = false;
  try {
    descriptor = fs14.openSync(guardPath2, "wx", 384);
    fs14.writeFileSync(descriptor, `${process.pid}
`, "utf8");
    fs14.closeSync(descriptor);
    descriptor = void 0;
    const status = serviceLockStatus(path16.dirname(lockPath2));
    if (status.state === "stale") {
      const quarantine = `${lockPath2}.stale-${status.ownerNonce}`;
      fs14.renameSync(lockPath2, quarantine);
      recovered = true;
    }
  } catch {
    if (descriptor !== void 0)
      try {
        fs14.closeSync(descriptor);
      } catch {
      }
  }
  try {
    fs14.unlinkSync(guardPath2);
  } catch (error2) {
    if (!isCode4(error2, "ENOENT")) return false;
  }
  return recovered;
}
function acquireServiceLock(stateDirectory2) {
  fs14.mkdirSync(stateDirectory2, { recursive: true, mode: 448 });
  const lockPath2 = lockPathFor(stateDirectory2);
  const record2 = Object.freeze({
    pid: process.pid,
    nonce: `lock_${crypto21.randomUUID()}`,
    started_at: (/* @__PURE__ */ new Date()).toISOString()
  });
  for (let attempts = 0; attempts < 3; attempts += 1) {
    try {
      const descriptor = fs14.openSync(lockPath2, "wx", 384);
      try {
        fs14.writeFileSync(descriptor, `${JSON.stringify(record2)}
`, "utf8");
      } finally {
        fs14.closeSync(descriptor);
      }
      let released = false;
      return Object.freeze({
        path: lockPath2,
        nonce: record2.nonce,
        release: () => {
          if (released) return;
          released = true;
          const current = readRecord(lockPath2);
          if (!current || current.pid !== record2.pid || current.nonce !== record2.nonce)
            return;
          try {
            fs14.unlinkSync(lockPath2);
          } catch (error2) {
            if (!isCode4(error2, "ENOENT")) throw error2;
          }
        }
      });
    } catch (error2) {
      if (!isCode4(error2, "EEXIST")) throw error2;
      const status = serviceLockStatus(stateDirectory2);
      if (status.state === "stale" && reclaimStaleLock(lockPath2)) continue;
      throw new Error(
        `control-plane service lock ${status.state}: ${status.detail} (${lockPath2})`
      );
    }
  }
  throw new Error(`control-plane could not acquire service lock: ${lockPath2}`);
}

// apps/control-plane/src/tracker-core-routes.ts
import crypto22 from "node:crypto";
function body2(value2) {
  return value2 && typeof value2 === "object" && !Array.isArray(value2) ? value2 : {};
}
function expectedRevision2(value2, fallback) {
  const candidate = value2.expected_revision ?? value2.revision;
  return typeof candidate === "number" ? candidate : fallback;
}
function contextFor(options, request, action) {
  const context = options.principal.resolve(request, {
    action,
    allowBrowser: true,
    allowBearer: true
  });
  if (!context)
    throw new TrackerCoreError(
      "tracker.not_found",
      "tracker resource was not found"
    );
  return context;
}
function scopedTicket(options, context, id2) {
  const ticket = options.tracker.getTicket(id2);
  return ticket && typeof ticket.project_id === "string" && options.principal.policy.allowsProject(context, ticket.project_id) ? ticket : void 0;
}
function notFound(reply) {
  return reply.code(404).send({ error: "ticket not found", code: "tracker.not_found" });
}
function legacyPhaseForState(kind, state) {
  if (state !== "todo" && state !== "in_progress" && state !== "blocked" && state !== "review" && state !== "done")
    return void 0;
  if (kind === "spec")
    return {
      todo: "drafting",
      in_progress: "designing",
      blocked: "parked",
      review: "designed",
      done: "done"
    }[state];
  if (kind === "question")
    return {
      todo: "open",
      in_progress: "open",
      blocked: "open",
      review: "answered",
      done: "closed"
    }[state];
  if (kind === "decision")
    return {
      todo: "open",
      in_progress: "open",
      blocked: "open",
      review: "decided",
      done: "closed"
    }[state];
  return {
    todo: "queued",
    in_progress: "building",
    blocked: "blocked",
    review: "built",
    done: "done"
  }[state];
}
function fail2(reply, error2) {
  if (error2 instanceof TrackerCoreError) {
    const status = error2.code === "tracker.not_found" ? 404 : error2.code === "tracker.conflict" ? 409 : 400;
    return reply.code(status).send({ error: error2.message, code: error2.code });
  }
  return reply.code(400).send({ error: error2 instanceof Error ? error2.message : String(error2) });
}
function registerTrackerCoreCompatibilityRoutes(options) {
  const gateway = options.gateway;
  function gatewayRoute(input) {
    if (!gateway) return void 0;
    const key = typeof input.idempotencyKey === "string" && input.idempotencyKey ? input.idempotencyKey : `auto:legacy:${input.commandKind}:${crypto22.randomUUID()}`;
    return gateway.execute({
      commandId: `cmd_${crypto22.randomUUID()}`,
      idempotencyKey: key,
      commandKind: input.commandKind,
      actorId: input.context.actorId,
      projectId: input.context.defaultProjectId,
      correlationId: `cor_${crypto22.randomUUID()}`,
      scope: input.scope,
      ...input.expectedRevision !== void 0 ? { expectedRevision: input.expectedRevision } : {},
      payload: input.payload,
      handler: input.handler
    });
  }
  options.app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/tickets") && !request.url.startsWith("/api/streams"))
      return;
    if (hasRequestAuthorityOverride(request)) {
      return fail(
        request,
        reply,
        403,
        "browser.forbidden",
        "request authority is server-owned"
      );
    }
    const action = request.method === "GET" ? "read" : "mutate";
    const context = options.principal.resolve(request, {
      action,
      allowBrowser: true,
      allowBearer: true
    });
    if (!context)
      return fail(
        request,
        reply,
        401,
        "browser.auth.required",
        "an authenticated principal binding is required"
      );
    if (!options.principal.policy.allows(context, action))
      return fail(
        request,
        reply,
        403,
        "browser.forbidden",
        "the authenticated principal is not authorized"
      );
  });
  options.app.get("/api/tickets", async (request) => {
    const context = contextFor(options, request, "read");
    const query = request.query;
    return options.tracker.listTickets({
      projectId: context.defaultProjectId,
      ...typeof query.kind === "string" ? { kind: query.kind } : {},
      ...typeof query.phase === "string" ? { phase: query.phase } : {},
      ...typeof query.assignee === "string" ? { assignee: query.assignee } : {}
    });
  });
  options.app.get("/api/tickets/search", async (request, reply) => {
    try {
      const context = contextFor(options, request, "read");
      const query = request.query;
      return options.tracker.searchTickets(
        typeof query.q === "string" ? query.q : typeof query.query === "string" ? query.query : "",
        context.defaultProjectId
      );
    } catch (error2) {
      return fail2(reply, error2);
    }
  });
  options.app.get("/api/tickets/:id", async (request, reply) => {
    const context = contextFor(options, request, "read");
    return scopedTicket(options, context, request.params.id) ?? notFound(reply);
  });
  options.app.post("/api/tickets", async (request, reply) => {
    try {
      const context = contextFor(options, request, "mutate");
      const input = body2(request.body);
      const handler = () => options.tracker.createTicket({
        projectId: context.defaultProjectId,
        kind: input.kind,
        title: input.title,
        ...typeof input.body === "string" ? { body: input.body } : {},
        ...typeof input.priority === "string" ? { priority: input.priority } : {},
        ...Array.isArray(input.labels) ? { labels: input.labels } : {},
        ...typeof input.stream_id === "string" ? { streamId: input.stream_id } : {},
        ...typeof input.parent_id === "string" ? { parentId: input.parent_id } : {},
        ...typeof input.assignee === "string" ? { assignee: input.assignee } : {},
        ...typeof input.rank === "number" ? { rank: input.rank } : {},
        ...typeof input.wave === "number" ? { wave: input.wave } : {},
        actor: context.actorId
      });
      const outcome2 = gatewayRoute({
        context,
        commandKind: "legacy.ticket.create",
        scope: { resourceType: "ticket", resourceId: "*" },
        payload: input,
        idempotencyKey: typeof input.idempotency_key === "string" ? input.idempotency_key : void 0,
        handler
      });
      return outcome2 ?? handler();
    } catch (error2) {
      return fail2(reply, error2);
    }
  });
  options.app.patch("/api/tickets/:id", async (request, reply) => {
    try {
      const context = contextFor(options, request, "mutate");
      const id2 = request.params.id;
      const input = body2(request.body);
      const current = scopedTicket(options, context, id2);
      if (!current) return notFound(reply);
      const revision = expectedRevision2(input, Number(current.revision));
      if (input.phase !== void 0 || input.state !== void 0) {
        const phase = typeof input.phase === "string" ? input.phase : legacyPhaseForState(String(current.kind), input.state);
        if (!phase)
          return reply.code(400).send({
            error: "legacy state has no canonical phase",
            code: "tracker.phase.invalid"
          });
        const handler2 = () => options.tracker.transitionTicket({
          id: id2,
          expectedRevision: revision,
          phase,
          ...typeof input.reason === "string" ? { reason: input.reason } : {},
          actor: context.actorId
        });
        const outcome3 = gatewayRoute({
          context,
          commandKind: "legacy.ticket.transition",
          scope: { resourceType: "ticket", resourceId: id2 },
          payload: input,
          idempotencyKey: typeof input.idempotency_key === "string" ? input.idempotency_key : void 0,
          expectedRevision: revision,
          handler: handler2
        });
        return outcome3 ?? handler2();
      }
      const handler = () => options.tracker.updateTicket({
        id: id2,
        expectedRevision: revision,
        patch: {
          ...typeof input.title === "string" ? { title: input.title } : {},
          ...typeof input.body === "string" ? { body: input.body } : {},
          ...typeof input.priority === "string" ? { priority: input.priority } : {},
          ...Array.isArray(input.labels) ? { labels: input.labels } : {},
          ...typeof input.assignee === "string" ? { assignee: input.assignee } : {},
          ...typeof input.rank === "number" ? { rank: input.rank } : {},
          ...typeof input.wave === "number" ? { wave: input.wave } : {}
        },
        actor: context.actorId
      });
      const outcome2 = gatewayRoute({
        context,
        commandKind: "legacy.ticket.update",
        scope: { resourceType: "ticket", resourceId: id2 },
        payload: input,
        idempotencyKey: typeof input.idempotency_key === "string" ? input.idempotency_key : void 0,
        expectedRevision: revision,
        handler
      });
      return outcome2 ?? handler();
    } catch (error2) {
      return fail2(reply, error2);
    }
  });
  options.app.post("/api/tickets/:id/transition", async (request, reply) => {
    try {
      const context = contextFor(options, request, "mutate");
      const input = body2(request.body);
      const id2 = request.params.id;
      const current = scopedTicket(options, context, id2);
      if (!current) return notFound(reply);
      const revision = expectedRevision2(input, Number(current.revision));
      const handler = () => options.tracker.transitionTicket({
        id: id2,
        expectedRevision: revision,
        phase: input.phase,
        ...typeof input.reason === "string" ? { reason: input.reason } : {},
        actor: context.actorId
      });
      const outcome2 = gatewayRoute({
        context,
        commandKind: "legacy.ticket.transition",
        scope: { resourceType: "ticket", resourceId: id2 },
        payload: input,
        idempotencyKey: typeof input.idempotency_key === "string" ? input.idempotency_key : void 0,
        expectedRevision: revision,
        handler
      });
      return outcome2 ?? handler();
    } catch (error2) {
      return fail2(reply, error2);
    }
  });
  options.app.post("/api/tickets/:id/comments", async (request, reply) => {
    try {
      const context = contextFor(options, request, "mutate");
      const input = body2(request.body);
      const ticketId = request.params.id;
      if (!scopedTicket(options, context, ticketId)) return notFound(reply);
      const anchor2 = input.anchor;
      const handler = () => options.tracker.addComment({
        ticketId,
        author: context.actorId,
        body: input.body,
        ...anchor2 && typeof anchor2 === "object" && !Array.isArray(anchor2) ? { anchor: anchor2 } : {},
        ...typeof input.tag === "string" ? { tag: input.tag } : {},
        ...typeof input.status === "string" ? { status: input.status } : {}
      });
      const outcome2 = gatewayRoute({
        context,
        commandKind: "legacy.comment.create",
        scope: { resourceType: "comment", resourceId: ticketId },
        payload: input,
        idempotencyKey: typeof input.idempotency_key === "string" ? input.idempotency_key : void 0,
        handler
      });
      return outcome2 ?? handler();
    } catch (error2) {
      return fail2(reply, error2);
    }
  });
  options.app.post(
    "/api/tickets/:id/comments/:commentId/reply",
    async (request, reply) => {
      try {
        const context = contextFor(options, request, "mutate");
        const input = body2(request.body);
        const ticketId = request.params.id;
        const commentId = request.params.commentId;
        if (!scopedTicket(options, context, ticketId)) return notFound(reply);
        const handler = () => options.tracker.replyComment({
          ticketId,
          parentId: commentId,
          author: context.actorId,
          body: input.body
        });
        const outcome2 = gatewayRoute({
          context,
          commandKind: "legacy.comment.reply",
          scope: { resourceType: "comment", resourceId: commentId },
          payload: input,
          idempotencyKey: typeof input.idempotency_key === "string" ? input.idempotency_key : void 0,
          handler
        });
        return outcome2 ?? handler();
      } catch (error2) {
        return fail2(reply, error2);
      }
    }
  );
  options.app.patch(
    "/api/tickets/:id/comments/:commentId",
    async (request, reply) => {
      try {
        const context = contextFor(options, request, "mutate");
        const input = body2(request.body);
        const ticketId = request.params.id;
        const commentId = request.params.commentId;
        if (!scopedTicket(options, context, ticketId)) return notFound(reply);
        const handler = () => options.tracker.updateComment({
          ticketId,
          commentId,
          patch: {
            ...typeof input.body === "string" ? { body: input.body } : {},
            ...typeof input.tag === "string" ? { tag: input.tag } : {},
            ...typeof input.status === "string" ? { status: input.status } : {}
          },
          actor: context.actorId
        });
        const outcome2 = gatewayRoute({
          context,
          commandKind: "legacy.comment.update",
          scope: { resourceType: "comment", resourceId: commentId },
          payload: input,
          idempotencyKey: typeof input.idempotency_key === "string" ? input.idempotency_key : void 0,
          handler
        });
        return outcome2 ?? handler();
      } catch (error2) {
        return fail2(reply, error2);
      }
    }
  );
  options.app.post("/api/tickets/:id/links", async (request, reply) => {
    try {
      const context = contextFor(options, request, "mutate");
      const input = body2(request.body);
      const ticketId = request.params.id;
      if (!scopedTicket(options, context, ticketId) || typeof input.target_ticket_id !== "string" || !scopedTicket(options, context, input.target_ticket_id))
        return notFound(reply);
      const handler = () => options.tracker.linkTicket({
        ticketId,
        targetTicketId: input.target_ticket_id,
        relation: input.relation,
        actor: context.actorId
      });
      const outcome2 = gatewayRoute({
        context,
        commandKind: "legacy.link.create",
        scope: { resourceType: "link", resourceId: ticketId },
        payload: input,
        idempotencyKey: typeof input.idempotency_key === "string" ? input.idempotency_key : void 0,
        handler
      });
      return outcome2 ?? handler();
    } catch (error2) {
      return fail2(reply, error2);
    }
  });
  options.app.delete("/api/tickets/:id/links", async (request, reply) => {
    try {
      const context = contextFor(options, request, "mutate");
      const input = body2(request.body);
      const ticketId = request.params.id;
      if (!scopedTicket(options, context, ticketId) || typeof input.target_ticket_id !== "string" || !scopedTicket(options, context, input.target_ticket_id))
        return notFound(reply);
      const handler = () => options.tracker.deleteLink({
        ticketId,
        targetTicketId: input.target_ticket_id,
        relation: input.relation,
        actor: context.actorId
      });
      const outcome2 = gatewayRoute({
        context,
        commandKind: "legacy.link.delete",
        scope: { resourceType: "link", resourceId: ticketId },
        payload: input,
        idempotencyKey: typeof input.idempotency_key === "string" ? input.idempotency_key : void 0,
        handler
      });
      return outcome2 ?? handler();
    } catch (error2) {
      return fail2(reply, error2);
    }
  });
  options.app.get("/api/streams", async (request) => {
    const context = contextFor(options, request, "read");
    return options.tracker.listStreams(context.defaultProjectId);
  });
  options.app.post("/api/streams", async (request, reply) => {
    try {
      const context = contextFor(options, request, "mutate");
      const input = body2(request.body);
      const handler = () => options.tracker.upsertStream({
        ...typeof input.id === "string" ? { id: input.id } : {},
        projectId: context.defaultProjectId,
        name: input.name,
        ...input.mode === "sequential" || input.mode === "parallel" ? { mode: input.mode } : {},
        ...typeof input.description === "string" ? { description: input.description } : {},
        ...typeof input.expected_revision === "number" ? { expectedRevision: input.expected_revision } : {},
        actor: context.actorId
      });
      const outcome2 = gatewayRoute({
        context,
        commandKind: "legacy.stream.upsert",
        scope: {
          resourceType: "stream",
          resourceId: typeof input.id === "string" ? input.id : "*"
        },
        payload: input,
        idempotencyKey: typeof input.idempotency_key === "string" ? input.idempotency_key : void 0,
        ...typeof input.expected_revision === "number" ? { expectedRevision: input.expected_revision } : {},
        handler
      });
      return outcome2 ?? handler();
    } catch (error2) {
      return fail2(reply, error2);
    }
  });
  options.app.patch("/api/streams/:id", async (request, reply) => {
    try {
      const context = contextFor(options, request, "mutate");
      const input = body2(request.body);
      const streamId = request.params.id;
      if (!options.tracker.listStreams(context.defaultProjectId).some((stream) => stream.id === streamId))
        return notFound(reply);
      const handler = () => options.tracker.upsertStream({
        id: streamId,
        projectId: context.defaultProjectId,
        name: input.name,
        mode: input.mode,
        ...typeof input.description === "string" ? { description: input.description } : {},
        ...typeof input.expected_revision === "number" ? { expectedRevision: input.expected_revision } : {},
        actor: context.actorId
      });
      const outcome2 = gatewayRoute({
        context,
        commandKind: "legacy.stream.upsert",
        scope: { resourceType: "stream", resourceId: streamId },
        payload: input,
        idempotencyKey: typeof input.idempotency_key === "string" ? input.idempotency_key : void 0,
        ...typeof input.expected_revision === "number" ? { expectedRevision: input.expected_revision } : {},
        handler
      });
      return outcome2 ?? handler();
    } catch (error2) {
      return fail2(reply, error2);
    }
  });
}

// apps/control-plane/src/ws-replay.ts
import crypto23 from "node:crypto";
var BoundedReplayWindow = class {
  #capacity;
  #entries = /* @__PURE__ */ new Map();
  #nextSequence = /* @__PURE__ */ new Map();
  #listeners = /* @__PURE__ */ new Set();
  #browserEntries = /* @__PURE__ */ new Map();
  #browserNextSequence = /* @__PURE__ */ new Map();
  #browserListeners = /* @__PURE__ */ new Set();
  constructor(capacity = 32) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 256)
      throw new Error(
        "replay window capacity must be an integer from 1 to 256"
      );
    this.#capacity = capacity;
  }
  snapshot(stream, scope = {}) {
    const entries = this.#entries.get(scopeKey(stream, scope)) ?? [];
    const latest = entries.at(-1);
    return Object.freeze({
      sequence: latest?.sequence ?? 0,
      resourceRevision: latest?.resourceRevision ?? 0
    });
  }
  replay(stream, cursor, scope = {}) {
    if (!Number.isInteger(cursor) || cursor < 0)
      return Object.freeze({ kind: "gap", reason: "cursor_gap" });
    const entries = this.#entries.get(scopeKey(stream, scope)) ?? [];
    const oldest = entries[0]?.sequence;
    const latest = entries.at(-1)?.sequence ?? 0;
    if (cursor > latest)
      return Object.freeze({ kind: "gap", reason: "cursor_gap" });
    if (oldest !== void 0 && cursor < oldest - 1)
      return Object.freeze({ kind: "gap", reason: "cursor_compacted" });
    return Object.freeze({
      kind: "resume",
      entries: entries.filter((entry2) => entry2.sequence > cursor)
    });
  }
  publish(stream, resourceRevision, delta, scope = {}) {
    if (!Number.isInteger(resourceRevision) || resourceRevision < 0)
      throw new Error(
        "replay resource revision must be a non-negative integer"
      );
    const key = scopeKey(stream, scope);
    const entries = this.#entries.get(key) ?? [];
    const prior = entries.at(-1);
    if (prior && resourceRevision < prior.resourceRevision)
      throw new Error(
        "replay resource revision must not regress below the canonical prior revision"
      );
    const entry2 = Object.freeze({
      sequence: this.#nextSequence.get(key) ?? 1,
      resourceRevision,
      delta: Object.freeze({ ...delta })
    });
    this.#nextSequence.set(key, entry2.sequence + 1);
    entries.push(entry2);
    while (entries.length > this.#capacity) entries.shift();
    this.#entries.set(key, entries);
    for (const listener of this.#listeners) listener(stream, entry2, scope);
    return entry2;
  }
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  browserSnapshot(stream, scope = {}) {
    const entries = this.#browserEntries.get(scopeKey(stream, scope)) ?? [];
    const latest = entries.at(-1);
    return Object.freeze({
      sequence: latest?.sequence ?? 0,
      resourceRevision: latest?.resourceRevision ?? 0
    });
  }
  browserReplay(stream, cursor, scope = {}) {
    if (!Number.isInteger(cursor) || cursor < 0)
      return Object.freeze({ kind: "gap", reason: "cursor_gap" });
    const entries = this.#browserEntries.get(scopeKey(stream, scope)) ?? [];
    const oldest = entries[0]?.sequence;
    const latest = entries.at(-1)?.sequence ?? 0;
    if (cursor > latest)
      return Object.freeze({ kind: "gap", reason: "cursor_gap" });
    if (oldest !== void 0 && cursor < oldest - 1)
      return Object.freeze({ kind: "gap", reason: "cursor_compacted" });
    return Object.freeze({
      kind: "resume",
      entries: entries.filter((entry2) => entry2.sequence > cursor)
    });
  }
  publishBrowserWork(stream, resourceRevision, delta, scope = {}) {
    if (!Number.isInteger(resourceRevision) || resourceRevision < 0)
      throw new Error(
        "browser work replay resource revision must be a non-negative integer"
      );
    const key = scopeKey(stream, scope);
    const entries = this.#browserEntries.get(key) ?? [];
    const prior = entries.at(-1);
    if (prior && resourceRevision < prior.resourceRevision)
      throw new Error(
        "browser work replay resource revision must not regress below the canonical prior revision"
      );
    const entry2 = Object.freeze({
      sequence: this.#browserNextSequence.get(key) ?? 1,
      resourceRevision,
      delta: BrowserWorkInvalidationSchema.parse(delta)
    });
    this.#browserNextSequence.set(key, entry2.sequence + 1);
    entries.push(entry2);
    while (entries.length > this.#capacity) entries.shift();
    this.#browserEntries.set(key, entries);
    for (const listener of this.#browserListeners)
      listener(stream, entry2, scope);
    return entry2;
  }
  subscribeBrowserWork(listener) {
    this.#browserListeners.add(listener);
    return () => this.#browserListeners.delete(listener);
  }
};
function scopeKey(stream, scope) {
  return `${stream}\0${scope.projectId ?? "global"}\0${scope.policyVersion ?? 1}`;
}
function scopeFor(stream, context) {
  return stream === "tracker.tree" || stream === "tracker.board" || stream === "management.controls" || stream === "communication.operations" ? { projectId: context.defaultProjectId, policyVersion: 1 } : {};
}
function originFor(request) {
  return `http://127.0.0.1:${request.socket.localPort ?? 0}`;
}
function frame(instanceId, stream, sequence, revision, payload2) {
  return WebSocketFrameV1Schema.parse({
    schema_version: "golem.websocket-frame/v1",
    instance_id: instanceId,
    stream,
    sequence,
    resource_revision: revision,
    correlation_id: `corr_${crypto23.randomUUID()}`,
    payload: payload2
  });
}
function browserSnapshotFrame(instanceId, sequence, projection) {
  return BrowserWorkWebSocketFrameSchema.parse({
    schema_version: "golem.browser-work-websocket-frame/v1",
    instance_id: instanceId,
    stream: projection.stream,
    sequence,
    resource_revision: projection.resource_revision,
    correlation_id: `corr_${crypto23.randomUUID()}`,
    payload: {
      kind: "snapshot",
      cursor: String(sequence),
      payload: projection
    }
  });
}
function browserDeltaFrame(instanceId, stream, sequence, revision, delta) {
  return BrowserWorkWebSocketFrameSchema.parse({
    schema_version: "golem.browser-work-websocket-frame/v1",
    instance_id: instanceId,
    stream,
    sequence,
    resource_revision: revision,
    correlation_id: `corr_${crypto23.randomUUID()}`,
    payload: {
      kind: "delta",
      cursor: String(sequence),
      delta: BrowserWorkInvalidationSchema.parse(delta)
    }
  });
}
function browserResyncFrame(instanceId, stream, revision, reason, snapshotUrl) {
  return BrowserWorkWebSocketFrameSchema.parse({
    schema_version: "golem.browser-work-websocket-frame/v1",
    instance_id: instanceId,
    stream,
    sequence: 0,
    resource_revision: revision,
    correlation_id: `corr_${crypto23.randomUUID()}`,
    payload: { kind: "resync_required", reason, snapshot_url: snapshotUrl }
  });
}
function registerWsReplay(options) {
  const streams = /* @__PURE__ */ new Map();
  const unsubscribe = options.replay.subscribe((stream, entry2, scope) => {
    if (options.browserReplay && BrowserWorkStreamSchema.safeParse(stream).success)
      return;
    for (const socket of options.sockets) {
      const subscription = streams.get(socket);
      if (!subscription || subscription.stream !== stream) continue;
      if (scopeKey(stream, subscription.scope) !== scopeKey(stream, scope))
        continue;
      if (scope.projectId && !options.principal.policy.allowsProject(
        subscription.context,
        scope.projectId
      ))
        continue;
      try {
        const message = frame(
          options.instanceId,
          stream,
          entry2.sequence,
          entry2.resourceRevision,
          {
            kind: "delta",
            cursor: String(entry2.sequence),
            delta: entry2.delta
          }
        );
        socket.send(JSON.stringify(message));
      } catch {
        options.sockets.delete(socket);
        streams.delete(socket);
      }
    }
  });
  const unsubscribeBrowser = options.browserReplay?.subscribeBrowserWork(
    (stream, entry2, scope) => {
      for (const socket of options.sockets) {
        const subscription = streams.get(socket);
        if (!subscription || subscription.stream !== stream) continue;
        if (scopeKey(stream, subscription.scope) !== scopeKey(stream, scope))
          continue;
        if (scope.projectId && !options.principal.policy.allowsProject(
          subscription.context,
          scope.projectId
        ))
          continue;
        try {
          const message = browserDeltaFrame(
            options.instanceId,
            stream,
            entry2.sequence,
            entry2.resourceRevision,
            entry2.delta
          );
          socket.send(JSON.stringify(message));
        } catch {
          options.sockets.delete(socket);
          streams.delete(socket);
        }
      }
    }
  );
  options.app.get(
    "/api/v1/ws",
    { websocket: true },
    (socket, request) => {
      const url = new URL(request.url, originFor(request));
      const parsed = ProjectionParamsSchema.safeParse({
        stream: url.searchParams.get("stream") ?? "runtime.live"
      });
      if (!parsed.success) {
        socket.close(1008, "stream invalid");
        return;
      }
      const stream = parsed.data.stream;
      const browserOnly = options.browserOnlyStreams?.includes(stream) ?? false;
      const context = options.principal.resolve(request, {
        action: "read",
        allowBrowser: true,
        allowBearer: !browserOnly
      });
      if (!isExpectedHost(request.headers.host) || hasRequestAuthorityOverride(request) || !context || !options.principal.policy.allows(context, "read")) {
        socket.close(1008, "authentication required");
        return;
      }
      const scope = scopeFor(stream, context);
      const suppliedInstance = url.searchParams.get("instance_id");
      const cursorValue = url.searchParams.get("cursor");
      const suppliedPolicy = url.searchParams.get("policy_version");
      const snapshotUrl = `${originFor(request)}/api/v1/projections/${stream}`;
      const browserStream = BrowserWorkStreamSchema.safeParse(stream);
      const browserProjection = options.browserProjection;
      if (browserStream.success && browserProjection) {
        const browserReplay = options.browserReplay;
        if (!browserReplay) {
          socket.close(1011, "browser replay unavailable");
          return;
        }
        const currentProjection = () => browserProjection(browserStream.data, context.defaultProjectId);
        let messages2;
        if (!suppliedInstance || cursorValue === null) {
          const snapshot = browserReplay.browserSnapshot(
            browserStream.data,
            scope
          );
          messages2 = [
            browserSnapshotFrame(
              options.instanceId,
              snapshot.sequence,
              currentProjection()
            )
          ];
        } else if (suppliedInstance !== options.instanceId) {
          messages2 = [
            browserResyncFrame(
              options.instanceId,
              browserStream.data,
              currentProjection().resource_revision,
              "instance_changed",
              snapshotUrl
            )
          ];
        } else if (suppliedPolicy !== null && suppliedPolicy !== String(scope.policyVersion ?? 1)) {
          messages2 = [
            browserResyncFrame(
              options.instanceId,
              browserStream.data,
              currentProjection().resource_revision,
              "policy_changed",
              snapshotUrl
            )
          ];
        } else {
          const result2 = browserReplay.browserReplay(
            browserStream.data,
            Number(cursorValue),
            scope
          );
          messages2 = result2.kind === "gap" ? [
            browserResyncFrame(
              options.instanceId,
              browserStream.data,
              currentProjection().resource_revision,
              result2.reason,
              snapshotUrl
            )
          ] : result2.entries.map(
            (entry2) => browserDeltaFrame(
              options.instanceId,
              browserStream.data,
              entry2.sequence,
              entry2.resourceRevision,
              entry2.delta
            )
          );
        }
        options.sockets.add(socket);
        streams.set(socket, { stream, context, scope });
        socket.once("close", () => {
          options.sockets.delete(socket);
          streams.delete(socket);
        });
        for (const message of messages2) socket.send(JSON.stringify(message));
        return;
      }
      let messages;
      if (!suppliedInstance || cursorValue === null) {
        const snapshot = options.replay.snapshot(stream, scope);
        messages = [
          frame(
            options.instanceId,
            stream,
            snapshot.sequence,
            options.revision(stream, context.defaultProjectId),
            {
              kind: "snapshot",
              cursor: String(snapshot.sequence),
              payload: options.read(stream, context.defaultProjectId)
            }
          )
        ];
      } else if (suppliedInstance !== options.instanceId) {
        messages = [
          frame(
            options.instanceId,
            stream,
            0,
            options.revision(stream, context.defaultProjectId),
            {
              kind: "resync_required",
              reason: "instance_changed",
              snapshot_url: snapshotUrl
            }
          )
        ];
      } else if (suppliedPolicy !== null && suppliedPolicy !== String(scope.policyVersion ?? 1)) {
        messages = [
          frame(
            options.instanceId,
            stream,
            0,
            options.revision(stream, context.defaultProjectId),
            {
              kind: "resync_required",
              reason: "policy_changed",
              snapshot_url: snapshotUrl
            }
          )
        ];
      } else {
        const result2 = options.replay.replay(
          stream,
          Number(cursorValue),
          scope
        );
        messages = result2.kind === "gap" ? [
          frame(
            options.instanceId,
            stream,
            0,
            options.revision(stream, context.defaultProjectId),
            {
              kind: "resync_required",
              reason: result2.reason,
              snapshot_url: snapshotUrl
            }
          )
        ] : result2.entries.map(
          (entry2) => frame(
            options.instanceId,
            stream,
            entry2.sequence,
            entry2.resourceRevision,
            {
              kind: "delta",
              cursor: String(entry2.sequence),
              delta: entry2.delta
            }
          )
        );
      }
      options.sockets.add(socket);
      streams.set(socket, { stream, context, scope });
      socket.once("close", () => {
        options.sockets.delete(socket);
        streams.delete(socket);
      });
      for (const message of messages) socket.send(JSON.stringify(message));
    }
  );
  return () => {
    unsubscribe();
    unsubscribeBrowser?.();
    streams.clear();
  };
}

// apps/control-plane/src/lifecycle.ts
function defaultProjection() {
  return {
    read: () => ({}),
    revision: () => 0
  };
}
async function startControlPlane(options) {
  if (options.host && options.host !== "127.0.0.1")
    throw new Error("control plane may bind only to 127.0.0.1");
  if (options.token.trim().length < 24)
    throw new Error(
      "control plane bearer token must contain at least 24 characters"
    );
  if (!fs15.existsSync(options.staticDirectory))
    throw new Error(
      `control plane static directory does not exist: ${options.staticDirectory}`
    );
  const lock = acquireServiceLock(options.stateDirectory);
  const instanceId = `cpi_${crypto24.randomUUID()}`;
  const projection = options.projection ?? defaultProjection();
  const replay = options.replay ?? new BoundedReplayWindow(options.replayWindowSize ?? 32);
  const legacyCompatibility = options.legacyCompatibility ?? createLegacyCompatibilitySource();
  const principal = options.principalResolver ?? createFailClosedBrowserPrincipalResolver();
  const browserWork = options.browserWork;
  const sockets = /* @__PURE__ */ new Set();
  const app = Fastify({
    logger: {
      level: "warn",
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers.set-cookie"
      ]
    },
    disableRequestLogging: true
  });
  let closed = false;
  let closeTypedReplay = () => {
  };
  let closeLegacyWebSocket = () => {
  };
  let publicationTimer;
  try {
    await app.register(websocket);
    app.addHook("onRequest", async (request, reply) => {
      if (isExpectedHost(request.headers.host)) return;
      return fail(
        request,
        reply,
        400,
        "host.invalid",
        "loopback Host header is required"
      );
    });
    registerErrorEnvelope(app);
    registerValidatedRoutes({
      app,
      token: options.token,
      instanceId,
      projection,
      ...options.runtimeProjection ? { runtimeProjection: options.runtimeProjection } : {},
      replay,
      legacy: legacyCompatibility,
      principal,
      ...options.runtimeIngress ? { runtimeIngress: options.runtimeIngress } : {},
      ...options.runtimeHealth ? { runtimeHealth: options.runtimeHealth } : {},
      ...options.invalidResponseForTest === void 0 ? {} : { invalidResponseForTest: options.invalidResponseForTest },
      ...options.browserWork ? { browserWork: options.browserWork } : {}
    });
    if (options.browserWork && options.trackerCore && options.management && options.commandGateway && options.ticketDispatch)
      registerBrowserWorkRoutes({
        app,
        principal,
        browserWork: options.browserWork,
        core: options.trackerCore,
        management: options.management,
        gateway: options.commandGateway,
        ticketDispatch: options.ticketDispatch
      });
    if (options.browserSettings)
      registerBrowserSettingsRoutes({
        app,
        principal,
        settings: options.browserSettings
      });
    if (options.trackerCore) {
      registerTrackerCoreCompatibilityRoutes({
        app,
        tracker: options.trackerCore.compatibility,
        principal,
        ...options.commandGateway ? { gateway: options.commandGateway } : {}
      });
    }
    if (options.trackerCore && options.trackerServices)
      registerApiV1Routes({
        app,
        principal,
        core: options.trackerCore,
        services: options.trackerServices,
        ...options.ticketDispatch ? { ticketDispatch: options.ticketDispatch } : {},
        ...options.commandGateway ? { gateway: options.commandGateway } : {}
      });
    if (options.management)
      registerManagementRoutes({
        app,
        principal,
        management: options.management,
        ...options.commandGateway ? { gateway: options.commandGateway } : {}
      });
    closeTypedReplay = registerWsReplay({
      app,
      instanceId,
      principal,
      replay,
      read: (stream, projectId2) => projection.read(stream, projectId2),
      ...browserWork ? {
        browserProjection: (stream, projectId2) => browserWork.projection(stream, projectId2),
        browserReplay: replay
      } : {},
      revision: (stream, projectId2) => projection.revision(stream, projectId2),
      sockets,
      ...options.browserWork ? { browserOnlyStreams: BrowserWorkStreamSchema.options } : {}
    });
    if (options.committedPublications) {
      const dispatcher = new CommittedPublicationDispatcher({
        storage: options.committedPublications,
        replay,
        ...browserWork ? { browserReplay: replay } : {},
        workerId: `control-plane-${process.pid}`,
        now: () => (/* @__PURE__ */ new Date()).toISOString()
      });
      dispatcher.drain();
      publicationTimer = setInterval(() => dispatcher.drain(), 25);
      publicationTimer.unref();
    }
    closeLegacyWebSocket = registerLegacyWebSocket({
      app,
      source: legacyCompatibility
    });
    await registerStaticCompatibility({
      app,
      staticDirectory: path17.resolve(options.staticDirectory)
    });
    const address = await app.listen({
      host: "127.0.0.1",
      port: options.port ?? 0
    });
    const origin = address.replace("localhost", "127.0.0.1");
    return Object.freeze({
      origin,
      instanceId,
      lockPath: lock.path,
      close: async () => {
        if (closed) return;
        closed = true;
        if (publicationTimer) clearInterval(publicationTimer);
        closeTypedReplay();
        closeLegacyWebSocket();
        for (const socket of sockets)
          socket.close(1001, "service shutting down");
        await app.close();
        lock.release();
      }
    });
  } catch (error2) {
    if (publicationTimer) clearInterval(publicationTimer);
    closeTypedReplay();
    closeLegacyWebSocket();
    lock.release();
    throw error2;
  }
}
function controlPlanePortFromEnvironment(value2) {
  if (typeof value2 !== "string") return 0;
  const parsed = Number(value2);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : 0;
}

// apps/control-plane/src/tracker.ts
function composeControlPlaneTrackerServices(options) {
  return createTrackerServices({
    storage: options.writer.trackerStorage(),
    eligibility: options.eligibility,
    clock: options.clock
  });
}
function composeControlPlaneCommandGateway(options) {
  return createCommandGateway({
    storage: options.writer.commandGatewayStorage(),
    clock: options.clock,
    core: options.core
  });
}
function composeControlPlaneEndpointEligibility(options) {
  return Object.freeze({
    resolve(recipientId) {
      const direct = options.endpoints.get(recipientId);
      const generationId = direct?.generationId ?? recipientId;
      const eligibility = options.endpoints.deliveryEligibility({
        generationId,
        routeKind: "delivery",
        requiredCapability: "delivery",
        now: options.clock.now()
      });
      const endpoint3 = eligibility.endpoint;
      if (eligibility.disposition === "ineligible" || !endpoint3)
        return void 0;
      return Object.freeze({
        recipientId,
        generationId: endpoint3.generationId,
        endpointId: endpoint3.endpointId,
        ownerFence: endpoint3.ownerFence,
        readiness: endpoint3.readiness,
        mode: endpoint3.deliveryMode,
        capabilities: endpoint3.capabilities.map((capability3) => ({
          capability: capability3.capability,
          qualification: capability3.qualification,
          observedAt: capability3.observedAt
        }))
      });
    }
  });
}
function composeControlPlaneTicketDispatchService(options) {
  const sessions = options.writer.runtimeSessionStorage();
  const tracker = options.writer.trackerStorage();
  return createTicketDispatchService({
    tickets: {
      get(projectId2, ticketId) {
        const ticket = options.core.tickets.get(ticketId)?.ticket;
        return ticket?.projectId === projectId2 ? ticket : void 0;
      },
      record(input) {
        try {
          return options.core.tickets.recordDispatch(input);
        } catch (error2) {
          if (error2 instanceof TrackerCoreError && error2.code === "tracker.conflict")
            return void 0;
          throw error2;
        }
      }
    },
    sessions: {
      resolve: (projectId2, reference) => sessions.resolveLogicalSession(projectId2, reference)
    },
    eligibility: options.eligibility,
    delivery: options.services.delivery,
    operations: {
      list: (projectId2) => tracker.listDispatchOperations(projectId2)
    }
  });
}
function composeControlPlaneTrackerCoreServices(options) {
  return createTrackerCoreServices({
    storage: options.writer.trackerCoreStorage(),
    clock: options.clock,
    ...options.trustedExceptionalCloseContext === void 0 ? {} : {
      trustedExceptionalCloseContext: options.trustedExceptionalCloseContext
    }
  });
}
function composeControlPlaneManagementServices(options) {
  const sessions = options.writer.runtimeSessionStorage();
  const identity = {
    getSession: (projectId2, sessionId) => sessions.get(projectId2, sessionId),
    findGeneration: (projectId2, generationId) => sessions.list(projectId2).flatMap((session2) => session2.generations).find((generation2) => generation2.generationId === generationId)
  };
  return createTrackerManagementServices({
    storage: options.writer.managementStorage(),
    clock: options.clock,
    assetRoot: options.assetRoot,
    identity,
    ...options.tickets ? { tickets: options.tickets } : {}
  });
}

// apps/control-plane/src/main.ts
var configuredTokenFile = process.env.GOLEM_CONTROL_PLANE_TOKEN_FILE;
var tokenFromFile = configuredTokenFile ? (() => {
  try {
    return fs16.readFileSync(configuredTokenFile, "utf8").trim();
  } catch {
    return void 0;
  }
})() : void 0;
var token = process.env.GOLEM_CONTROL_PLANE_TOKEN ?? tokenFromFile;
var golemHome = process.env.GOLEM_HOME;
var stateDirectory = golemHome ? path18.join(golemHome, "control-plane") : void 0;
var staticDirectory = process.env.GOLEM_CONTROL_PLANE_STATIC_ROOT;
var browserLocalOperatorBindingId = process.env.GOLEM_BROWSER_LOCAL_OPERATOR_BINDING_ID ?? "principal_local_operator";
var replayWindowValue = Number(process.env.GOLEM_CONTROL_PLANE_REPLAY_WINDOW);
var replayWindowSize = Number.isInteger(replayWindowValue) && replayWindowValue >= 1 ? replayWindowValue : void 0;
var projectionRevisionRaw = process.env.GOLEM_CONTROL_PLANE_PROJECTION_REVISION;
var projectionRevisionValue = projectionRevisionRaw === void 0 ? void 0 : Number(projectionRevisionRaw);
var projectionFixtureRaw = process.env.GOLEM_CONTROL_PLANE_PROJECTION_FIXTURE;
var projectionFixture;
if (projectionFixtureRaw) {
  try {
    const parsed = JSON.parse(projectionFixtureRaw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      projectionFixture = parsed;
  } catch {
  }
}
var projectionRevision = projectionRevisionValue !== void 0 && Number.isInteger(projectionRevisionValue) && projectionRevisionValue >= 0 ? projectionRevisionValue : 0;
var testProjection = projectionFixture !== void 0 || projectionRevisionValue !== void 0 && Number.isInteger(projectionRevisionValue) && projectionRevisionValue >= 0 ? {
  projection: {
    read: () => projectionFixture ?? {},
    revision: () => projectionRevision
  }
} : {};
if (!token || !golemHome || !stateDirectory || !staticDirectory) {
  process.stderr.write(
    "GOLEM_CONTROL_PLANE_TOKEN, GOLEM_HOME, and GOLEM_CONTROL_PLANE_STATIC_ROOT are required\n"
  );
  process.exitCode = 64;
} else {
  const persistence = resolveControlPlanePersistencePaths(golemHome);
  const owner = openControlPlanePersistence({
    runtimePath: persistence.runtimePath,
    trackerPath: persistence.trackerPath,
    ...persistence.lockPath ? { lockPath: persistence.lockPath } : {}
  });
  const clock = {
    now: () => (/* @__PURE__ */ new Date()).toISOString(),
    after: (milliseconds) => new Date(Date.now() + milliseconds).toISOString()
  };
  const principals = owner.browserPrincipalStorage();
  const projectIds = [
    .../* @__PURE__ */ new Set([
      ...owner.runtimeProjectionStorage().projects().map((project2) => project2.projectId),
      ...owner.trackerCoreStorage().listWorkItems().map((ticket) => ticket.projectId)
    ])
  ].sort();
  if (projectIds.length === 0) projectIds.push("golem-local");
  const defaultProjectId = projectIds[0] ?? "golem-local";
  const timestamp3 = clock.now();
  const hasBoundToken = principals.resolveCredential({
    adapter: "bearer",
    credential: token,
    now: timestamp3
  });
  if (!hasBoundToken) {
    try {
      principals.provision({
        id: browserLocalOperatorBindingId,
        actorId: "human:local-operator",
        role: "operator",
        defaultProjectId,
        scopeProjectIds: projectIds
      });
    } catch {
    }
  }
  for (const adapter of ["bearer", "mcp", "internal"]) {
    if (principals.resolveCredential({
      adapter,
      credential: token,
      now: timestamp3
    }))
      continue;
    principals.bindCredential({
      bindingId: browserLocalOperatorBindingId,
      adapter,
      credential: token
    });
  }
  const trackerCore = composeControlPlaneTrackerCoreServices({
    writer: owner,
    clock
  });
  const trackerServices = composeControlPlaneTrackerServices({
    writer: owner,
    clock,
    eligibility: composeControlPlaneEndpointEligibility({
      endpoints: owner.runtimeEndpointStorage(),
      clock
    })
  });
  const ticketDispatch = composeControlPlaneTicketDispatchService({
    writer: owner,
    core: trackerCore,
    services: trackerServices,
    eligibility: composeControlPlaneEndpointEligibility({
      endpoints: owner.runtimeEndpointStorage(),
      clock
    })
  });
  const management = composeControlPlaneManagementServices({
    writer: owner,
    clock,
    assetRoot: path18.join(golemHome, "ticket-assets"),
    tickets: trackerCore.tickets
  });
  const commandGateway = composeControlPlaneCommandGateway({
    writer: owner,
    clock,
    core: trackerCore
  });
  const browserWork = createBrowserWorkServices({
    core: trackerCore,
    management,
    ticketDispatch,
    projectRevision: (projectId2) => owner.committedPublicationStorage().projectRevision(projectId2)
  });
  const modulePath = fileURLToPath(import.meta.url);
  const moduleDirectory = path18.dirname(modulePath);
  const workspaceRoot = path18.basename(moduleDirectory) === "release" && path18.basename(path18.dirname(moduleDirectory)) === "dist" ? path18.resolve(moduleDirectory, "../..") : path18.resolve(moduleDirectory, "../../..");
  const cliEntry = path18.resolve(
    process.env.GOLEM_CLI_ENTRY ?? path18.join(workspaceRoot, "cli", "golem.js")
  );
  const serviceCredentialPath = path18.join(stateDirectory, "service-token");
  const openCodeConfigPath = path18.resolve(
    process.env.OPENCODE_CONFIG_PATH ?? path18.join(
      process.env.XDG_CONFIG_HOME ?? path18.join(os2.homedir(), ".config"),
      "opencode",
      "opencode.jsonc"
    )
  );
  const launchAgentDirectory = path18.resolve(
    process.env.GOLEM_CONTROL_PLANE_LAUNCH_AGENT_DIR ?? path18.join(os2.homedir(), "Library", "LaunchAgents")
  );
  const serviceEnvironment = {
    GOLEM_HOME: golemHome,
    GOLEM_CONTROL_PLANE_STATIC_ROOT: staticDirectory,
    GOLEM_CONTROL_PLANE_TOKEN_FILE: serviceCredentialPath,
    ...process.env.GOLEM_CONTROL_PLANE_PORT ? {
      GOLEM_CONTROL_PLANE_PORT: process.env.GOLEM_CONTROL_PLANE_PORT
    } : {},
    GOLEM_BROWSER_LOCAL_OPERATOR_BINDING_ID: browserLocalOperatorBindingId
  };
  let cutoverScheduler;
  let cutoverStop;
  const browserSettings = createBrowserSettingsServices({
    home: golemHome,
    runtimeProjection: owner.runtimeProjectionStorage(),
    cliEntry,
    openCodeConfigPath,
    environment: process.env,
    beforeCutover: async () => {
      await cutoverScheduler?.stop();
    },
    afterCutover: () => {
      const timer = setTimeout(() => {
        void cutoverStop?.();
      }, 250);
      timer.unref();
    },
    service: {
      directory: launchAgentDirectory,
      uid: process.getuid?.() ?? 0,
      credentialPath: serviceCredentialPath,
      credential: token,
      definition: {
        label: "dev.golem.control-plane",
        program: process.execPath,
        arguments: [modulePath],
        workingDirectory: workspaceRoot,
        environment: serviceEnvironment
      }
    }
  });
  const principalResolver = createBrowserPrincipalResolver({
    storage: principals,
    localOperatorBindingId: browserLocalOperatorBindingId
  });
  const sessions = createSessionService({
    projects: owner.runtimeProjectStorage(),
    sessions: owner.runtimeSessionStorage()
  });
  const runtime = createRuntimeMaterializer({
    home: golemHome,
    writer: owner,
    sessions
  });
  const runtimeProjection = createRuntimeProjectionService({
    storage: owner.runtimeProjectionStorage(),
    clock
  });
  const controlProjection = {
    read: (stream, _projectId) => stream === "runtime.live" || stream === "runtime.history" || stream === "runtime.diagnostics" ? runtimeProjection.read(stream) : {},
    revision: (stream, projectId2) => stream === "runtime.live" || stream === "runtime.history" || stream === "runtime.diagnostics" ? runtimeProjection.revision(stream) : projectId2 ? owner.committedPublicationStorage().projectRevision(projectId2) : 0
  };
  const outbox = new RuntimeOutboxDrainer({
    writer: owner,
    workerId: `control-plane-${process.pid}`,
    destinations: {
      // Wave 5 intentionally has no tracker/management transport adapter.
      // The bounded durable scheduler records retry/permanent state rather
      // than pretending this cross-store delivery is already atomic.
      tracker: {
        deliver: async () => {
          throw new Error("runtime tracker destination is not configured");
        }
      },
      management: {
        deliver: async () => {
          throw new Error("runtime management destination is not configured");
        }
      }
    }
  });
  const scheduler = new RuntimeEngineScheduler({
    materializer: runtime.materializer,
    outbox,
    writer: owner
  });
  cutoverScheduler = scheduler;
  try {
    await scheduler.start();
  } catch (error2) {
    await owner.close();
    throw error2;
  }
  let service;
  try {
    service = await startControlPlane({
      token,
      stateDirectory,
      staticDirectory,
      port: controlPlanePortFromEnvironment(
        process.env.GOLEM_CONTROL_PLANE_PORT
      ),
      runtimeIngress: runtime.inbox,
      runtimeHealth: scheduler,
      projection: controlProjection,
      runtimeProjection,
      management,
      trackerCore,
      trackerServices,
      ticketDispatch,
      commandGateway,
      browserWork,
      browserSettings,
      committedPublications: owner.committedPublicationStorage(),
      principalResolver,
      ...replayWindowSize ? { replayWindowSize } : {},
      ...testProjection
    });
  } catch (error2) {
    await scheduler.stop();
    await owner.close();
    throw error2;
  }
  process.stdout.write(
    `${JSON.stringify({ type: "ready", origin: service.origin, instance_id: service.instanceId })}
`
  );
  const dashboardRecordPath = path18.join(golemHome, "dashboard.json");
  try {
    fs16.mkdirSync(path18.dirname(dashboardRecordPath), {
      recursive: true,
      mode: 448
    });
    const temporary = `${dashboardRecordPath}.${process.pid}.tmp`;
    fs16.writeFileSync(
      temporary,
      `${JSON.stringify(
        {
          schema_version: "golem.dashboard-discovery/v1",
          generated: true,
          authoritative: false,
          mode: persistence.authority.stage === "C4" ? "canonical" : "dark",
          canonical_revision: persistence.authority.canonical_revision ?? 0,
          authority_revision: persistence.authority.revision,
          url: service.origin.replace("127.0.0.1", "dashboard.golem.localhost"),
          host: "127.0.0.1",
          port: Number(new URL(service.origin).port),
          pid: process.pid,
          instance_id: service.instanceId,
          started_at: clock.now()
        },
        null,
        2
      )}
`,
      { encoding: "utf8", mode: 384 }
    );
    fs16.renameSync(temporary, dashboardRecordPath);
  } catch {
  }
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await scheduler.stop();
    await service.close();
    await owner.close();
  };
  cutoverStop = stop;
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}
