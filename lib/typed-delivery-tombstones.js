// Compact, append-safe replay tombstones for typed native-worker envelopes.
// This deliberately contains no prompt content or rich adapter history: its
// only job is to preserve immutable first-acceptance lineage after the
// bounded supervisor inspection history rolls over.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { typedDeliveryTombstonesDbPath } from './golem-home.js';

function open(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS typed_delivery_tombstones (
      canonical_id TEXT NOT NULL,
      envelope_id TEXT NOT NULL,
      accepted_attempt_id TEXT,
      target_session_id TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL,
      turn_id TEXT,
      claimed_at TEXT,
      accepted_at TEXT,
      settled_at TEXT,
      interrupted_at TEXT,
      recovery_required_at TEXT,
      -- Wire expiry is retained for audit only. It is deliberately NOT the
      -- replay-retention clock: the tracker can renew a pending lineage after
      -- a lost response, and acceptance must still win on that retry.
      expires_at TEXT NOT NULL,
      retired_at TEXT,
      PRIMARY KEY (canonical_id, envelope_id)
    );
  `);
  const cols = db.prepare('PRAGMA table_info(typed_delivery_tombstones)').all().map((col) => col.name);
  if (!cols.includes('retired_at')) db.exec('ALTER TABLE typed_delivery_tombstones ADD COLUMN retired_at TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_typed_delivery_tombstones_expiry
      ON typed_delivery_tombstones(expires_at);
    CREATE INDEX IF NOT EXISTS idx_typed_delivery_tombstones_retired
      ON typed_delivery_tombstones(retired_at) WHERE retired_at IS NOT NULL;
  `);
  return db;
}

function rowToTombstone(row) {
  return row ? {
    canonical_id: row.canonical_id,
    envelope_id: row.envelope_id,
    accepted_attempt_id: row.accepted_attempt_id,
    target_session_id: row.target_session_id,
    lifecycle_state: row.lifecycle_state,
    turn_id: row.turn_id,
    claimed_at: row.claimed_at,
    accepted_at: row.accepted_at,
    settled_at: row.settled_at,
    interrupted_at: row.interrupted_at,
    recovery_required_at: row.recovery_required_at,
    expires_at: row.expires_at,
    retired_at: row.retired_at,
  } : null;
}

export function readTypedDeliveryTombstone(canonicalId, envelopeId, {
  file = typedDeliveryTombstonesDbPath(),
} = {}) {
  if (!canonicalId || !envelopeId) return null;
  const db = open(file);
  try {
    const row = db.prepare(`SELECT * FROM typed_delivery_tombstones
      WHERE canonical_id = ? AND envelope_id = ? AND retired_at IS NULL`)
      .get(canonicalId, envelopeId);
    return rowToTombstone(row);
  } finally {
    db.close();
  }
}

export function upsertTypedDeliveryTombstone(canonicalId, delivery, {
  file = typedDeliveryTombstonesDbPath(),
} = {}) {
  if (!canonicalId || !delivery?.envelope_id || !delivery?.target_session_id || !delivery?.expires_at) return null;
  const db = open(file);
  try {
    db.prepare(`
      INSERT INTO typed_delivery_tombstones (
        canonical_id, envelope_id, accepted_attempt_id, target_session_id,
        lifecycle_state, turn_id, claimed_at, accepted_at, settled_at,
        interrupted_at, recovery_required_at, expires_at, retired_at
      ) VALUES (
        @canonical_id, @envelope_id, @accepted_attempt_id, @target_session_id,
        @lifecycle_state, @turn_id, @claimed_at, @accepted_at, @settled_at,
        @interrupted_at, @recovery_required_at, @expires_at, NULL
      )
      ON CONFLICT(canonical_id, envelope_id) DO UPDATE SET
        accepted_attempt_id = COALESCE(typed_delivery_tombstones.accepted_attempt_id, excluded.accepted_attempt_id),
        target_session_id = typed_delivery_tombstones.target_session_id,
        -- The registry can be stale after a crash. Advance from claimed to
        -- accepted/terminal, but never let an older JSON snapshot replace a
        -- terminal SQLite fact (settled/interrupted/recovery_required are
        -- intentionally incomparable terminal outcomes).
        lifecycle_state = CASE
          WHEN typed_delivery_tombstones.lifecycle_state IN ('settled', 'interrupted', 'recovery_required')
            THEN typed_delivery_tombstones.lifecycle_state
          WHEN excluded.lifecycle_state IN ('settled', 'interrupted', 'recovery_required')
            THEN excluded.lifecycle_state
          WHEN typed_delivery_tombstones.lifecycle_state = 'accepted' AND excluded.lifecycle_state = 'claimed'
            THEN typed_delivery_tombstones.lifecycle_state
          ELSE excluded.lifecycle_state
        END,
        turn_id = COALESCE(excluded.turn_id, typed_delivery_tombstones.turn_id),
        claimed_at = COALESCE(typed_delivery_tombstones.claimed_at, excluded.claimed_at),
        accepted_at = COALESCE(typed_delivery_tombstones.accepted_at, excluded.accepted_at),
        settled_at = COALESCE(typed_delivery_tombstones.settled_at, excluded.settled_at),
        interrupted_at = COALESCE(typed_delivery_tombstones.interrupted_at, excluded.interrupted_at),
        recovery_required_at = COALESCE(typed_delivery_tombstones.recovery_required_at, excluded.recovery_required_at),
        expires_at = CASE WHEN excluded.expires_at > typed_delivery_tombstones.expires_at THEN excluded.expires_at ELSE typed_delivery_tombstones.expires_at END,
        -- Retirement is an explicit tracker-authoritative fence too. A stale
        -- restarted adapter may add older JSON facts, but cannot reactivate a
        -- lineage the tracker has declared non-renewable.
        retired_at = typed_delivery_tombstones.retired_at
    `).run({
      canonical_id: canonicalId,
      envelope_id: delivery.envelope_id,
      accepted_attempt_id: delivery.accepted_attempt_id ?? (delivery.accepted_at ? delivery.attempt_id ?? null : null),
      target_session_id: delivery.target_session_id,
      lifecycle_state: delivery.lifecycle_state,
      turn_id: delivery.turn_id ?? null,
      claimed_at: delivery.claimed_at ?? null,
      accepted_at: delivery.accepted_at ?? null,
      settled_at: delivery.settled_at ?? null,
      interrupted_at: delivery.interrupted_at ?? null,
      recovery_required_at: delivery.recovery_required_at ?? null,
      expires_at: delivery.expires_at,
    });
    return readTypedDeliveryTombstone(canonicalId, delivery.envelope_id, { file });
  } finally {
    db.close();
  }
}

// Reclamation requires an explicit tracker-authoritative retirement. Never
// use envelope transport expiry here: pending lineages are renewable.
export function retireTypedDeliveryTombstones(canonicalId, envelopeIds, {
  file = typedDeliveryTombstonesDbPath(),
  at = Date.now(),
} = {}) {
  const ids = [...new Set((Array.isArray(envelopeIds) ? envelopeIds : [envelopeIds])
    .filter((value) => typeof value === 'string' && value))];
  if (!canonicalId || !ids.length) return 0;
  const db = open(file);
  try {
    const marks = ids.map(() => '?').join(', ');
    return db.prepare(`UPDATE typed_delivery_tombstones SET retired_at = ?
      WHERE canonical_id = ? AND envelope_id IN (${marks}) AND retired_at IS NULL`)
      .run(new Date(at).toISOString(), canonicalId, ...ids).changes;
  } finally {
    db.close();
  }
}

export function pruneTypedDeliveryTombstones({
  file = typedDeliveryTombstonesDbPath(),
  now = Date.now(),
} = {}) {
  const db = open(file);
  try {
    return db.prepare('DELETE FROM typed_delivery_tombstones WHERE retired_at IS NOT NULL AND retired_at <= ?')
      .run(new Date(now).toISOString()).changes;
  } finally {
    db.close();
  }
}

export function countTypedDeliveryTombstones({ file = typedDeliveryTombstonesDbPath() } = {}) {
  const db = open(file);
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM typed_delivery_tombstones').get().n;
  } finally {
    db.close();
  }
}
