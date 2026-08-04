// Tracker data layer — a NEW SQLite database the dashboard server owns.
//
// This is the cross-project ticket tracker's storage. It supersedes the
// legacy read-only markdown reader in tracker.js (which WS2 will keep around
// for back-compat). Everything here is synchronous (better-sqlite3); the
// dashboard's request handlers are async but the DB calls inside them are not.
//
// DB path resolution goes through lib/golem-home.js (TKT-0573, ADR-4) — the
// tracker DB lives at <golem home>/tracker.db, overridable wholesale via
// GOLEM_TRACKER_DB.

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { marked } from 'marked';
import TurndownService from 'turndown';
import { gfm as turndownGfm } from 'turndown-plugin-gfm';
import { trackerDbPath } from '../../lib/golem-home.js';
import { loadConfig } from '../../lib/golem-config.js';
import { createCommentDispatchService, defaultDispatchStateForComment } from './comment-dispatch.js';
import { canonicalStateForPhase, initialPhaseForKind, isKnownPhase, legalNextPhases, phaseFromLegacyState, requirementsForPhase } from './phase-machine.js';

const SCHEMA_VERSION = 17;

const KINDS = new Set(['work-item', 'decision', 'spec', 'question', 'fix']);
const STATES = new Set(['todo', 'in_progress', 'blocked', 'review', 'done', 'archived']);
const STREAM_MODES = new Set(['sequential', 'parallel']);
const LINK_TYPES = new Set(['blocks', 'relates', 'duplicates']);
const COMMENT_TAGS = new Set(['confirmed', 'partial', 'disputed', 'fix', 'risk', 'question', 'note']);
const EVENT_CLASSES = new Set(['tracker', 'lifecycle', 'activity', 'custom']);
const DEFAULT_SUBSCRIPTION_CLASSES = ['tracker', 'lifecycle', 'custom'];
const SUBSCRIPTION_BACKLOG_CAP = 500;
const PASSIVE_GROUP_CAP = 20;
const PASSIVE_BYTE_CAP = 4096;
const PASSIVE_LEASE_MS = 30_000;
// Typed endpoints reject stale envelopes before their native primitive runs.
// Keep this durable value on every envelope so all routes render one canonical
// protocol body rather than inventing per-adapter expiry metadata.
const MESSAGE_ENVELOPE_TTL_MS = 60 * 60_000;
const LIFECYCLE_EVENTS = new Set(['session-start', 'session-end', 'user-prompt', 'stop', 'subagent-stop', 'pre-compact', 'notification']);
const ACTIVITY_EVENTS = new Set(['tool-pre', 'tool-post', 'agent-spawn', 'agent-return', 'send-message', 'send-message-post']);

/** Default DB path: <golem home>/tracker.db, overridable by GOLEM_TRACKER_DB. */
export function defaultDbPath() {
  return trackerDbPath();
}

function now() {
  return new Date().toISOString();
}

function expiresAt(createdAt) {
  return new Date(Date.parse(createdAt) + MESSAGE_ENVELOPE_TTL_MS).toISOString();
}

function parseLabels(raw) {
  if (raw == null) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function serializeLabels(labels) {
  if (labels == null) return '[]';
  if (typeof labels === 'string') {
    // Already a JSON array string? keep it; otherwise wrap a single label.
    const parsed = parseLabels(labels);
    return JSON.stringify(parsed.length ? parsed : []);
  }
  return JSON.stringify(Array.isArray(labels) ? labels : []);
}

function normalizeWave(value, context = 'wave') {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${context}: wave must be a positive integer or null`);
  }
  return value;
}

function normalizeEventClass(value) {
  const cls = String(value || 'tracker').trim() || 'tracker';
  if (!EVENT_CLASSES.has(cls)) throw new Error(`event class must be one of ${[...EVENT_CLASSES].join(', ')}`);
  return cls;
}

function normalizeHookType(value) {
  return String(value || 'unknown').trim() || 'unknown';
}

function classForHookType(value) {
  const event = normalizeHookType(value);
  if (LIFECYCLE_EVENTS.has(event)) return 'lifecycle';
  if (ACTIVITY_EVENTS.has(event)) return 'activity';
  return 'custom';
}

function busTypeForHookType(value) {
  return `hook_${normalizeHookType(value).replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown'}`;
}

function eventUuid(input) {
  const raw = input?.uuid ?? input?.event_uuid ?? input?.id ?? input?.event_id ?? null;
  const s = raw == null ? '' : String(raw).trim();
  return s || null;
}

function normalizeClassFilter(value) {
  if (value == null) return DEFAULT_SUBSCRIPTION_CLASSES;
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const classes = [...new Set(raw.map((x) => String(x || '').trim()).filter(Boolean))];
  for (const cls of classes) normalizeEventClass(cls);
  return classes.length ? classes : DEFAULT_SUBSCRIPTION_CLASSES;
}

function serializeClasses(classes) {
  return JSON.stringify(normalizeClassFilter(classes));
}

function parseClasses(raw) {
  try {
    const parsed = JSON.parse(raw);
    return normalizeClassFilter(parsed);
  } catch {
    return normalizeClassFilter(raw);
  }
}

function actorKind(actor) {
  const a = String(actor || '').trim();
  if (!a) return 'system';
  if (a === 'system' || a.startsWith('system:') || a.startsWith('golem-') || a === 'golem-drainer') return 'system';
  if (a === 'human' || a === 'you' || a.startsWith('human:') || a === 'unattributed') return 'human';
  return 'session';
}

/**
 * Detect text that is probably Markdown (headings, lists, blockquotes, links,
 * fenced code, emphasis). Used to decide whether to run marked on plain text.
 */
function looksLikeMarkdown(text) {
  if (!text) return false;
  // Headings, lists, blockquotes, numbered lists at line start.
  if (/^\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|\>\s|```)/m.test(text)) return true;
  // Inline / block markdown patterns.
  if (/\[([^\]]+)\]\(([^)]+)\)/.test(text)) return true; // links
  if (/!\[([^\]]*)\]\(([^)]+)\)/.test(text)) return true; // images
  if (/```[\s\S]*```/.test(text)) return true; // fenced code
  if (/\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|`[^`]+`/.test(text)) return true; // bold/italic/strike/code
  return false;
}

/**
 * Normalize a ticket/comment body to canonical HTML.
 * - Existing HTML (starts with a tag) passes through.
 * - Markdown-looking plain text is converted via marked.
 * - Otherwise plain text is split into paragraphs (blank-line separated) with
 *   single newlines preserved as <br/>.
 * This lets agents continue to send plain text or Markdown while the UI always
 * renders HTML.
 */
function toHtmlBody(raw) {
  if (raw == null) return '';
  const text = String(raw).trim();
  if (!text) return '';
  // Heuristic: if it starts with an HTML tag, treat as HTML.
  if (/^\s*<[a-zA-Z][^>]*>/.test(text)) return text;
  if (looksLikeMarkdown(text)) {
    return marked(text, { gfm: true, breaks: false, headerIds: false, mangle: false });
  }
  return text
    .split(/\n\n+/)
    .map((p) => `<p>${p.trim().replace(/\n/g, '<br/>')}</p>`)
    .join('');
}

/**
 * Normalize a ticket/comment body for verbatim Markdown storage (TKT-0170, v5).
 * Trim and collapse 3+ consecutive blank lines to 2. No HTML conversion and no
 * markdown->html — the body is stored as Markdown and rendered client-side (see
 * dashboard/web/src/format.js renderMarkdown). Legacy HTML-first bodies were
 * converted to Markdown once by the v4->v5 backfill migration in migrate().
 */
function toMarkdownBody(raw) {
  if (raw == null) return '';
  return String(raw).trim().replace(/\n{3,}/g, '\n\n');
}

// Hydrate a raw ticket row into a plain object with labels parsed to an array.
function hydrateTicket(row) {
  if (!row) return null;
  return { ...row, labels: parseLabels(row.labels) };
}

/**
 * Open (and migrate) the tracker DB.
 * @param {string} [dbPath] defaults to defaultDbPath()
 * @returns the data-access object documented in the WS1 spec.
 */
export function openTrackerDb(dbPath = defaultDbPath()) {
  // Ensure the parent dir exists for a file-backed DB (skip for :memory:).
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  function migrate() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tickets (
        id            TEXT PRIMARY KEY,
        seq           INTEGER NOT NULL,
        project_id    TEXT NOT NULL,
        kind          TEXT NOT NULL DEFAULT 'work-item',
        title         TEXT NOT NULL,
        body          TEXT NOT NULL DEFAULT '',
        state         TEXT NOT NULL DEFAULT 'todo',
        phase         TEXT,
        priority      TEXT,
        labels        TEXT NOT NULL DEFAULT '[]',
        stream_id     TEXT,
        parent_id     TEXT,
        wave          INTEGER,
        assignee      TEXT,
        created_by    TEXT NOT NULL DEFAULT 'human',
        dispatched_to TEXT,
        dispatched_at TEXT,
        source_ref    TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        -- TKT-0105 (v4 schema): lifecycle columns for rank ordering and
        -- the 14-day done→archived auto-archive sweep.
        rank              INTEGER NOT NULL DEFAULT 0,
        state_changed_at  TEXT,
        done_at           TEXT,
        archived_at       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tickets_project  ON tickets(project_id);
      CREATE INDEX IF NOT EXISTS idx_tickets_state    ON tickets(state);
      CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets(assignee);
      CREATE INDEX IF NOT EXISTS idx_tickets_dispatched_to ON tickets(dispatched_to);
      -- The two indexes that depend on lifecycle columns (state_rank, done_at)
      -- are created LATER in the migration block, AFTER the ALTER TABLE that
      -- adds those columns to pre-existing DBs. Doing them here would fail on
      -- any DB that pre-dates v4 because the columns don't exist yet.

      CREATE TABLE IF NOT EXISTS comments (
        id          TEXT PRIMARY KEY,
        ticket_id   TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        author      TEXT NOT NULL,
        body        TEXT NOT NULL,
        quote       TEXT,
        prefix      TEXT,
        suffix      TEXT,
        section     TEXT,
        section_id  TEXT,
        tag         TEXT NOT NULL DEFAULT 'note',
        status      TEXT NOT NULL DEFAULT 'open',
        dispatch_state TEXT NOT NULL DEFAULT 'undispatched',
        parent_id   TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_comments_ticket ON comments(ticket_id);

      CREATE TABLE IF NOT EXISTS comment_dispatches (
        id           TEXT PRIMARY KEY,
        comment_id   TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
        ticket_id    TEXT NOT NULL,
        project_id   TEXT NOT NULL,
        session_id   TEXT NOT NULL,
        batch_id     TEXT,
        status       TEXT NOT NULL DEFAULT 'pending',
        created_at   TEXT NOT NULL,
        delivered_at TEXT,
        addressed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_comment_dispatches_comment ON comment_dispatches(comment_id);
      CREATE INDEX IF NOT EXISTS idx_comment_dispatches_pending ON comment_dispatches(status) WHERE status IN ('pending','delivered');

      CREATE TABLE IF NOT EXISTS streams (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL,
        name        TEXT NOT NULL,
        mode        TEXT NOT NULL DEFAULT 'parallel',
        description TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_streams_project ON streams(project_id);

      CREATE TABLE IF NOT EXISTS links (
        from_ticket TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        to_ticket   TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        type        TEXT NOT NULL,
        PRIMARY KEY (from_ticket, to_ticket, type)
      );

      CREATE TABLE IF NOT EXISTS events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        event_uuid TEXT,
        ticket_id  TEXT,
        project_id TEXT,
        topic      TEXT,
        class      TEXT NOT NULL DEFAULT 'tracker',
        type       TEXT NOT NULL,
        actor      TEXT,
        actor_kind TEXT NOT NULL DEFAULT 'system',
        actor_label TEXT,
        data       TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_ticket  ON events(ticket_id);
      CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id);
      -- idx_events_uuid depends on the v11 event_uuid column. It is created in
      -- the migration block after the ALTER TABLE for existing DBs.

      CREATE TABLE IF NOT EXISTS subscriptions (
        id             TEXT PRIMARY KEY,
        session_id     TEXT NOT NULL,
        topic          TEXT NOT NULL,
        classes_filter TEXT NOT NULL DEFAULT '["tracker","lifecycle","custom"]',
        status         TEXT NOT NULL DEFAULT 'active',
        manual         INTEGER NOT NULL DEFAULT 0,
        cursor_seq     INTEGER NOT NULL DEFAULT 0,
        created_at     TEXT NOT NULL,
        expires_at     TEXT,
        reason         TEXT,
        UNIQUE(session_id, topic)
      );
      CREATE INDEX IF NOT EXISTS idx_subscriptions_session ON subscriptions(session_id, status);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_topic ON subscriptions(topic, status);

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- TKT-0245: asynchronous dispatch queue. A pending row represents a
      -- ticket queued for a session that is not currently idle; the drainer
      -- (dispatch-queue.js) delivers it when the target's status flips to
      -- idle. The partial unique index guarantees at most one pending row per
      -- ticket (re-queue replaces; cancel/expire/deliver resolve it).
      CREATE TABLE IF NOT EXISTS dispatch_queue (
        id           TEXT PRIMARY KEY,
        ticket_id    TEXT NOT NULL,
        project_id   TEXT NOT NULL,
        session_id   TEXT NOT NULL,
        note         TEXT,
        status       TEXT NOT NULL DEFAULT 'pending',  -- pending|delivered|cancelled|expired
        created_at   TEXT NOT NULL,
        delivered_at TEXT,
        resolved_at  TEXT,
        last_error   TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_queue_pending
        ON dispatch_queue (ticket_id) WHERE status = 'pending';

      -- GOL-421: a dispatch is an addressable durable message, rather than an
      -- inferred combination of ticket fields and best-effort channel output.
      -- Keep dispatch_queue.envelope_id nullable for v12 rows already on disk.
      CREATE TABLE IF NOT EXISTS message_envelopes (
        id                TEXT PRIMARY KEY,
        root_id           TEXT,
        parent_id         TEXT,
        ticket_id         TEXT REFERENCES tickets(id) ON DELETE CASCADE,
        project_id        TEXT,
        sender_id         TEXT,
        reply_to_session_id TEXT,
        recipient_session_id TEXT,
        sender_session_id TEXT,
        target_session_id TEXT,
        kind              TEXT NOT NULL DEFAULT 'ticket_dispatch',
        payload           TEXT NOT NULL DEFAULT '{}',
        -- Canonical typed-worker delivery lifecycle. The status field remains
        -- legacy transport/ack compatibility field; it must not collapse a
        -- claimed or accepted native turn back into a socket-write claim.
        delivery_state    TEXT NOT NULL DEFAULT 'pending',
        delivery_attempt_id TEXT,
        accepted_attempt_id TEXT,
        claimed_at        TEXT,
        accepted_at       TEXT,
        settled_at        TEXT,
        interrupted_at    TEXT,
        recovery_required_at TEXT,
        delivery_attempted_at TEXT,
        delivery_opportunity_at TEXT,
        delivery_error    TEXT,
        ack_deadline_at   TEXT,
        picked_up_at      TEXT,
        reply_envelope_id TEXT,
        completed_event_id INTEGER,
        ping_envelope_id TEXT,
        escalate_after TEXT,
        escalation_envelope_id TEXT,
        ack_via_envelope_id TEXT,
        status            TEXT NOT NULL DEFAULT 'pending',
        created_at        TEXT NOT NULL,
        expires_at        TEXT NOT NULL,
        delivered_at      TEXT,
        acknowledged_at   TEXT,
        replied_at        TEXT,
        completed_at      TEXT,
        last_error        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_message_envelopes_ticket ON message_envelopes(ticket_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_message_envelopes_target ON message_envelopes(target_session_id, status);
      CREATE TABLE IF NOT EXISTS message_acknowledgements (
        envelope_id TEXT NOT NULL REFERENCES message_envelopes(id) ON DELETE CASCADE,
        recipient_session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        acknowledged_at TEXT NOT NULL,
        PRIMARY KEY (envelope_id, recipient_session_id)
      );

      -- GOL-423: model-free, per-session deltas. A slot is coalesced by the
      -- recipient/ticket/category key; a cursor owns at most one replayable
      -- claimed batch, so an interrupted next-turn hook cannot lose it.
      CREATE TABLE IF NOT EXISTS passive_slots (
        session_id     TEXT NOT NULL,
        ticket_id      TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        category       TEXT NOT NULL,
        baseline       TEXT NOT NULL,
        value          TEXT NOT NULL,
        first_event_id INTEGER NOT NULL,
        last_event_id  INTEGER NOT NULL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        PRIMARY KEY (session_id, ticket_id, category)
      );
      CREATE INDEX IF NOT EXISTS idx_passive_slots_session ON passive_slots(session_id, ticket_id, category);
      CREATE TABLE IF NOT EXISTS passive_cursors (
        session_id          TEXT PRIMARY KEY,
        cursor_seq          INTEGER NOT NULL DEFAULT 0,
        pending_batch_id    TEXT,
        pending_body        TEXT,
        pending_slots       TEXT,
        pending_to_seq      INTEGER,
        lease_id            TEXT,
        lease_expires_at    TEXT,
        pending_created_at  TEXT,
        updated_at          TEXT NOT NULL
      );

      -- TKT-0266: durable session-name labels. One row per session_id with a
      -- known name. Survives the session going offline so old tickets still
      -- render the friendly assignee name instead of a uuid stub. Derived
      -- (labels are JOINed onto tickets at read time, never stored on tickets).
      CREATE TABLE IF NOT EXISTS session_labels (
        session_id   TEXT PRIMARY KEY,
        label        TEXT NOT NULL,
        project_id   TEXT,
        last_seen_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_labels_project ON session_labels(project_id);
    `);
    // Read schema_version BEFORE seeding it. A brand-new DB has no row yet —
    // that must read as "predates every migration" (0), not silently
    // coalesce to the current version once the seed below inserts it, or
    // every version-gated migration (incl. the v6 ALTER TABLE that adds
    // pseq/display_id) would wrongly no-op on a fresh DB whose base
    // CREATE TABLE above never had those columns (TKT-0572).
    const schemaVersion = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')?.value ?? '0';

    // Seed meta defaults idempotently.
    const seed = db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)');
    seed.run('schema_version', String(SCHEMA_VERSION));
    seed.run('ticket_seq', '0');

    // Schema migration v1 -> v2: add annotation columns to comments.
    const columns = db.prepare("PRAGMA table_info(comments)").all().map((c) => c.name);
    const needed = ['quote', 'prefix', 'suffix', 'section', 'section_id', 'tag', 'status', 'parent_id', 'updated_at'];
    for (const col of needed) {
      if (!columns.includes(col)) {
        db.exec(`ALTER TABLE comments ADD COLUMN ${col} TEXT`);
      }
    }
    // tag/status have defaults; backfill any nulls from pre-v2 rows.
    db.prepare("UPDATE comments SET tag = COALESCE(tag, 'note'), status = COALESCE(status, 'open'), updated_at = COALESCE(updated_at, created_at) WHERE tag IS NULL OR status IS NULL OR updated_at IS NULL").run();

    // Schema migration v2 -> v3: canonical HTML bodies. Convert any ticket or
    // comment body that is not already HTML into HTML (Markdown -> HTML via
    // marked, plain text -> wrapped paragraphs).
    if (schemaVersion && Number(schemaVersion) < 3) {
      const updateTicketBody = db.prepare('UPDATE tickets SET body = ?, updated_at = ? WHERE id = ?');
      for (const { id, body } of db.prepare('SELECT id, body FROM tickets').all()) {
        const html = toHtmlBody(body);
        if (html !== body) updateTicketBody.run(html, now(), id);
      }
      const updateCommentBody = db.prepare('UPDATE comments SET body = ?, updated_at = ? WHERE id = ?');
      for (const { id, body } of db.prepare('SELECT id, body FROM comments').all()) {
        const html = toHtmlBody(body);
        if (html !== body) updateCommentBody.run(html, now(), id);
      }
    }

    // Schema migration v3 -> v4 (TKT-0105): lifecycle columns. ALTER TABLE
    // adds them to existing rows (NULL by default). The backfill below writes
    // state_changed_at, done_at, archived_at, and rank so the new columns are
    // immediately useful (sortable by rank, sweep-able by done_at).
    const ticketCols = db.prepare("PRAGMA table_info(tickets)").all().map((c) => c.name);
    for (const [col, def] of [
      ['rank',             'INTEGER NOT NULL DEFAULT 0'],
      ['state_changed_at', 'TEXT'],
      ['done_at',          'TEXT'],
      ['archived_at',      'TEXT'],
    ]) {
      if (!ticketCols.includes(col)) {
        db.exec(`ALTER TABLE tickets ADD COLUMN ${col} ${def}`);
      }
    }
    // Backfill rank: seq * 1000 leaves gaps between sequential tickets so
    // manual reorders can drop cards between without rewriting every row.
    db.prepare(`UPDATE tickets SET rank = seq * 1000 WHERE rank = 0`).run();
    // state_changed_at from event rows where present; fall back to updated_at.
    db.prepare(`UPDATE tickets
SET state_changed_at = COALESCE(
  (SELECT MAX(e.created_at) FROM events e
     WHERE e.ticket_id = tickets.id AND e.type = 'state_change'),
  updated_at
)
WHERE state_changed_at IS NULL`).run();
    db.prepare(`UPDATE tickets SET done_at = state_changed_at
      WHERE state = 'done' AND done_at IS NULL`).run();
    db.prepare(`UPDATE tickets SET archived_at = state_changed_at
      WHERE state = 'archived' AND archived_at IS NULL`).run();

    // Schema migration v4 -> v5 (TKT-0170): Markdown-canonical bodies + a
    // block_id column for block-anchored comments. Convert every HTML-first
    // ticket/comment body (legacy "house-style" report) to Markdown via
    // turndown, keeping svg/figure/figcaption as raw-HTML blocks the client
    // renderer (format.js renderMarkdown) handles. <style>/<script> blocks are
    // stripped first so their text doesn't leak as stray paragraphs. Gated on
    // schema_version < 5 so it runs once and is idempotent across restarts.
    if (schemaVersion && Number(schemaVersion) < 5) {
      const commentCols = db.prepare("PRAGMA table_info(comments)").all().map((c) => c.name);
      if (!commentCols.includes('block_id')) {
        db.exec('ALTER TABLE comments ADD COLUMN block_id TEXT');
      }
      const td = new TurndownService();
      td.use(turndownGfm);
      td.keep(['svg', 'figure', 'figcaption']);
      const toMd = (html) => {
        const s = String(html ?? '').trim();
        if (!s || !/^\s*<[a-zA-Z][^>]*>/.test(s)) return html; // not HTML-first; leave as-is
        const stripped = s.replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').trim();
        return td.turndown(stripped).trim();
      };
      const updateTicketBody = db.prepare('UPDATE tickets SET body = ?, updated_at = ? WHERE id = ?');
      for (const { id, body } of db.prepare('SELECT id, body FROM tickets').all()) {
        const md = toMd(body);
        if (md !== body) updateTicketBody.run(md, now(), id);
      }
      const updateCommentBody = db.prepare('UPDATE comments SET body = ?, updated_at = ? WHERE id = ?');
      for (const { id, body } of db.prepare('SELECT id, body FROM comments').all()) {
        const md = toMd(body);
        if (md !== body) updateCommentBody.run(md, now(), id);
      }
    }

    // Schema migration v5 -> v6 (TKT-0519): per-project display ids (pseq +
    // display_id) + a project_prefixes table. Historical smoke debris is
    // quarantined to smoketests-000000 BEFORE backfill so real projects number
    // 1..N with no smoke gaps. Gated on schema_version < 6 (runs once).
    if (schemaVersion && Number(schemaVersion) < 6) {
      const ticketCols6 = db.prepare("PRAGMA table_info(tickets)").all().map((c) => c.name);
      if (!ticketCols6.includes('pseq')) db.exec('ALTER TABLE tickets ADD COLUMN pseq INTEGER');
      if (!ticketCols6.includes('display_id')) db.exec('ALTER TABLE tickets ADD COLUMN display_id TEXT');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_display ON tickets(display_id) WHERE display_id IS NOT NULL');
      db.exec(`CREATE TABLE IF NOT EXISTS project_prefixes (
        project_id TEXT PRIMARY KEY,
        prefix TEXT NOT NULL UNIQUE
      )`);
      // Quarantine historical smoke debris BEFORE numbering. Rule is exactly
      // created_by='smoke' OR title LIKE 'SMOKE-%' — do NOT match %smoke%
      // broadly (real tickets mention smoke in titles).
      db.prepare("UPDATE tickets SET project_id='smoketests-000000' WHERE created_by='smoke' OR title LIKE 'SMOKE-%'").run();
      db.prepare("UPDATE events SET project_id='smoketests-000000' WHERE ticket_id IN (SELECT id FROM tickets WHERE project_id='smoketests-000000')").run();
      // Backfill: number each project's tickets 1..N by (created_at, seq) and
      // seed the per-project pseq counter so future creates continue from N+1.
      const setPseq = db.prepare('UPDATE tickets SET pseq = ?, display_id = ? WHERE id = ?');
      const setMetaV6 = db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      for (const { project_id } of db.prepare('SELECT DISTINCT project_id FROM tickets').all()) {
        const prefix = ensurePrefix(project_id);
        let n = 0;
        for (const r of db.prepare('SELECT id FROM tickets WHERE project_id = ? ORDER BY created_at ASC, seq ASC').all(project_id)) {
          n += 1;
          setPseq.run(n, `${prefix}-${n}`, r.id);
        }
        setMetaV6.run(`pseq:${project_id}`, String(n));
      }
    }

    // Schema migration v6 -> v7 (TKT-0642): per-comment dispatch state and
    // per-attempt dispatch history for spec comment fan-out.
    const commentCols7 = db.prepare("PRAGMA table_info(comments)").all().map((c) => c.name);
    if (!commentCols7.includes('dispatch_state')) {
      db.exec("ALTER TABLE comments ADD COLUMN dispatch_state TEXT NOT NULL DEFAULT 'undispatched'");
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS comment_dispatches (
        id           TEXT PRIMARY KEY,
        comment_id   TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
        ticket_id    TEXT NOT NULL,
        project_id   TEXT NOT NULL,
        session_id   TEXT NOT NULL,
        batch_id     TEXT,
        status       TEXT NOT NULL DEFAULT 'pending',
        created_at   TEXT NOT NULL,
        delivered_at TEXT,
        addressed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_comment_dispatches_comment ON comment_dispatches(comment_id);
      CREATE INDEX IF NOT EXISTS idx_comment_dispatches_pending ON comment_dispatches(status) WHERE status IN ('pending','delivered');
    `);
    if (schemaVersion && Number(schemaVersion) < 7) {
      db.prepare(`
        UPDATE comments
        SET dispatch_state = CASE
          WHEN author IN ('human', 'you', 'human:dashboard') AND status = 'open' THEN 'undispatched'
          ELSE 'n/a'
        END
      `).run();
    }

    // Schema migration v7 -> v8 (TKT-0643): dependency-wave metadata for
    // spec fan-out tickets. NULL means the ticket is not wave-managed.
    const ticketCols8 = db.prepare("PRAGMA table_info(tickets)").all().map((c) => c.name);
    if (!ticketCols8.includes('wave')) {
      db.exec('ALTER TABLE tickets ADD COLUMN wave INTEGER');
    }
    if (schemaVersion && Number(schemaVersion) < 8) {
      db.prepare(`
        UPDATE tickets
        SET wave = CASE
          WHEN title LIKE '[W1]%' THEN 1
          WHEN title LIKE '[W2]%' THEN 2
          WHEN title LIKE '[W3]%' THEN 3
          ELSE wave
        END
        WHERE parent_id = 'TKT-0638'
          AND (title LIKE '[W1]%' OR title LIKE '[W2]%' OR title LIKE '[W3]%')
      `).run();
    }

    // Schema migration v8 -> v9 (GOL-311): tracker events become the named bus
    // with topic/class/actor metadata plus durable per-session subscriptions.
    const eventCols9 = db.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
    for (const [col, def] of [
      ['topic', 'TEXT'],
      ['class', "TEXT NOT NULL DEFAULT 'tracker'"],
      ['actor_kind', "TEXT NOT NULL DEFAULT 'system'"],
      ['actor_label', 'TEXT'],
    ]) {
      if (!eventCols9.includes(col)) db.exec(`ALTER TABLE events ADD COLUMN ${col} ${def}`);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_topic ON events(topic, id);
      CREATE INDEX IF NOT EXISTS idx_events_class ON events(class, id);
      CREATE TABLE IF NOT EXISTS subscriptions (
        id             TEXT PRIMARY KEY,
        session_id     TEXT NOT NULL,
        topic          TEXT NOT NULL,
        classes_filter TEXT NOT NULL DEFAULT '["tracker","lifecycle","custom"]',
        status         TEXT NOT NULL DEFAULT 'active',
        cursor_seq     INTEGER NOT NULL DEFAULT 0,
        created_at     TEXT NOT NULL,
        expires_at     TEXT,
        reason         TEXT,
        UNIQUE(session_id, topic)
      );
      CREATE INDEX IF NOT EXISTS idx_subscriptions_session ON subscriptions(session_id, status);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_topic ON subscriptions(topic, status);
    `);
    db.prepare(`
      UPDATE events
      SET class = COALESCE(class, 'tracker'),
          actor_kind = CASE
            WHEN actor IS NULL OR actor = '' THEN 'system'
            WHEN actor = 'system' OR actor LIKE 'system:%' OR actor LIKE 'golem-%' THEN 'system'
            WHEN actor = 'human' OR actor = 'you' OR actor LIKE 'human:%' OR actor = 'unattributed' THEN 'human'
            ELSE 'session'
          END,
          actor_label = COALESCE(actor_label, actor),
          topic = COALESCE(topic, (
            SELECT 'ticket/' || COALESCE(t.display_id, t.id)
            FROM tickets t
            WHERE t.id = events.ticket_id
          ))
      WHERE topic IS NULL OR class IS NULL OR actor_kind IS NULL OR actor_label IS NULL
    `).run();

    // Schema migration v9 -> v10 (GOL-314): phase machines. Phase is the
    // workflow source of truth; state remains a derived board-column cache.
    const ticketCols10 = db.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name);
    if (!ticketCols10.includes('phase')) db.exec('ALTER TABLE tickets ADD COLUMN phase TEXT');
    if (schemaVersion && Number(schemaVersion) < 10) {
      const setPhase = db.prepare('UPDATE tickets SET phase = ?, state = ? WHERE id = ?');
      for (const row of db.prepare("SELECT id, kind, state FROM tickets WHERE phase IS NULL OR phase = ''").all()) {
        const phase = phaseFromLegacyState(row.kind, row.state);
        const state = row.state === 'archived' ? 'archived' : canonicalStateForPhase(row.kind, phase);
        setPhase.run(phase, state, row.id);
      }
    }
    const setDefaultPhase = db.prepare('UPDATE tickets SET phase = ? WHERE id = ?');
    for (const row of db.prepare("SELECT id, kind FROM tickets WHERE phase IS NULL OR phase = ''").all()) {
      setDefaultPhase.run(initialPhaseForKind(row.kind), row.id);
    }

    // Schema migration v10 -> v11 (GOL-313): external hook ingest is
    // idempotent by source event UUID. Existing tracker events remain null.
    const eventCols11 = db.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
    if (!eventCols11.includes('event_uuid')) db.exec('ALTER TABLE events ADD COLUMN event_uuid TEXT');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_events_uuid ON events(event_uuid) WHERE event_uuid IS NOT NULL');

    // Schema migration v11 -> v12 (GOL-319): workspace directive on queued
    // dispatches so the drainer can reconstruct the workspace block.
    const dqCols12 = db.prepare('PRAGMA table_info(dispatch_queue)').all().map((c) => c.name);
    if (!dqCols12.includes('workspace')) db.exec('ALTER TABLE dispatch_queue ADD COLUMN workspace TEXT');

    // Schema migration v12 -> v13 (GOL-421): correlate durable channel
    // envelopes with new queue rows. Existing queue history intentionally stays
    // NULL: it predates envelopes and remains visible/monitorable as legacy.
    const dqCols13 = db.prepare('PRAGMA table_info(dispatch_queue)').all().map((c) => c.name);
    if (!dqCols13.includes('envelope_id')) db.exec('ALTER TABLE dispatch_queue ADD COLUMN envelope_id TEXT');
    if (!dqCols13.includes('publishing_owner')) db.exec('ALTER TABLE dispatch_queue ADD COLUMN publishing_owner TEXT');
    if (!dqCols13.includes('publishing_expires_at')) db.exec('ALTER TABLE dispatch_queue ADD COLUMN publishing_expires_at TEXT');
    // GOL-421 additive facts/links. Keep old columns and rows intact; the old
    // status is compatibility display data, never the source of core delivery
    // or acknowledgement truth.
    const envelopeCols = db.prepare('PRAGMA table_info(message_envelopes)').all().map((c) => c.name);
    for (const [col, def] of [
      ['root_id', 'TEXT'], ['parent_id', 'TEXT'], ['sender_id', 'TEXT'],
      ['reply_to_session_id', 'TEXT'], ['recipient_session_id', 'TEXT'],
      ['delivery_attempted_at', 'TEXT'], ['delivery_opportunity_at', 'TEXT'],
      ['delivery_error', 'TEXT'], ['ack_deadline_at', 'TEXT'], ['picked_up_at', 'TEXT'], ['reply_envelope_id', 'TEXT'], ['completed_event_id', 'INTEGER'],
    ]) if (!envelopeCols.includes(col)) db.exec(`ALTER TABLE message_envelopes ADD COLUMN ${col} ${def}`);
    const envelopeCols14 = db.prepare('PRAGMA table_info(message_envelopes)').all().map((c) => c.name);
    for (const [col, def] of [
      ['ping_envelope_id', 'TEXT'], ['escalate_after', 'TEXT'],
      ['escalation_envelope_id', 'TEXT'], ['ack_via_envelope_id', 'TEXT'],
    ]) if (!envelopeCols14.includes(col)) db.exec(`ALTER TABLE message_envelopes ADD COLUMN ${col} ${def}`);

    // GOL-124: typed native workers distinguish publication, slot claim,
    // correlated acceptance, settlement, interruption, and recovery-required
    // outcomes. Existing rows start as `pending`; the old status field stays
    // readable for CC/OC and historical dashboard clients.
    const envelopeCols124 = db.prepare('PRAGMA table_info(message_envelopes)').all().map((c) => c.name);
    for (const [col, def] of [
      ['delivery_state', "TEXT NOT NULL DEFAULT 'pending'"], ['delivery_attempt_id', 'TEXT'], ['accepted_attempt_id', 'TEXT'],
      ['claimed_at', 'TEXT'], ['accepted_at', 'TEXT'], ['settled_at', 'TEXT'],
      ['interrupted_at', 'TEXT'], ['recovery_required_at', 'TEXT'],
    ]) if (!envelopeCols124.includes(col)) db.exec(`ALTER TABLE message_envelopes ADD COLUMN ${col} ${def}`);
    // v16 stored only the then-current attempt. For an already accepted row,
    // that value is the only durable first-acceptance lineage available; copy
    // it before later duplicate publishes begin updating current attempts.
    db.prepare(`UPDATE message_envelopes
      SET accepted_attempt_id = delivery_attempt_id
      WHERE accepted_attempt_id IS NULL
        AND delivery_attempt_id IS NOT NULL
        AND delivery_state IN ('accepted', 'settled', 'interrupted', 'recovery_required')`).run();
    const envelopeColsExpiry = db.prepare('PRAGMA table_info(message_envelopes)').all().map((c) => c.name);
    if (!envelopeColsExpiry.includes('expires_at')) db.exec('ALTER TABLE message_envelopes ADD COLUMN expires_at TEXT');
    for (const row of db.prepare('SELECT id, created_at FROM message_envelopes WHERE expires_at IS NULL').all()) {
      db.prepare('UPDATE message_envelopes SET expires_at = ? WHERE id = ?').run(expiresAt(row.created_at), row.id);
    }

    // Schema migration v14 -> v15 (GOL-423): preserve which subscriptions were
    // explicitly manual even when lifecycle resume later replaces their reason.
    const subscriptionCols15 = db.prepare('PRAGMA table_info(subscriptions)').all().map((c) => c.name);
    if (!subscriptionCols15.includes('manual')) db.exec("ALTER TABLE subscriptions ADD COLUMN manual INTEGER NOT NULL DEFAULT 0");
    db.prepare("UPDATE subscriptions SET manual = 1 WHERE manual = 0 AND reason = 'manual'").run();
    db.exec(`
      CREATE TABLE IF NOT EXISTS passive_slots (
        session_id     TEXT NOT NULL,
        ticket_id      TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        category       TEXT NOT NULL,
        baseline       TEXT NOT NULL,
        value          TEXT NOT NULL,
        first_event_id INTEGER NOT NULL,
        last_event_id  INTEGER NOT NULL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        PRIMARY KEY (session_id, ticket_id, category)
      );
      CREATE INDEX IF NOT EXISTS idx_passive_slots_session ON passive_slots(session_id, ticket_id, category);
      CREATE TABLE IF NOT EXISTS passive_cursors (
        session_id          TEXT PRIMARY KEY,
        cursor_seq          INTEGER NOT NULL DEFAULT 0,
        pending_batch_id    TEXT,
        pending_body        TEXT,
        pending_slots       TEXT,
        pending_to_seq      INTEGER,
        lease_id            TEXT,
        lease_expires_at    TEXT,
        pending_created_at  TEXT,
        updated_at          TEXT NOT NULL
      );
    `);

    // Indexes that depend on lifecycle columns. Idempotent: no-op on fresh
    // DBs (CREATE TABLE above already created them), first-time-create on
    // existing DBs (where the ALTER TABLE above just added the columns).
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tickets_state_rank ON tickets(state, rank)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tickets_done_at ON tickets(done_at) WHERE done_at IS NOT NULL`);
    // Update schema_version to the current version.
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION), 'schema_version');
}

  // ---- prepared statements (built lazily after migrate) ----------------
  let stmts = null;
  let commentDispatch = null;
  function prepare() {
    stmts = {
      insertTicket: db.prepare(`
        INSERT INTO tickets
          (id, seq, project_id, kind, title, body, state, priority, labels,
           stream_id, parent_id, wave, assignee, created_by, dispatched_to,
           dispatched_at, source_ref, created_at, updated_at, pseq, display_id, phase)
        VALUES
          (@id, @seq, @project_id, @kind, @title, @body, @state, @priority, @labels,
           @stream_id, @parent_id, @wave, @assignee, @created_by, @dispatched_to,
           @dispatched_at, @source_ref, @created_at, @updated_at, @pseq, @display_id, @phase)
      `),
      getTicket: db.prepare('SELECT * FROM tickets WHERE id = ?'),
      getComments: db.prepare('SELECT * FROM comments WHERE ticket_id = ? ORDER BY created_at ASC, id ASC'),
      insertComment: db.prepare(`
        INSERT INTO comments
          (id, ticket_id, author, body, quote, prefix, suffix, section, section_id,
           tag, status, dispatch_state, parent_id, block_id, created_at, updated_at)
        VALUES
          (@id, @ticket_id, @author, @body, @quote, @prefix, @suffix, @section, @section_id,
            @tag, @status, @dispatch_state, @parent_id, @block_id, @created_at, @updated_at)
      `),
      touchTicket: db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?'),
      insertStream: db.prepare(`
        INSERT INTO streams (id, project_id, name, mode, description, created_at, updated_at)
        VALUES (@id, @project_id, @name, @mode, @description, @created_at, @updated_at)
      `),
      getStream: db.prepare('SELECT * FROM streams WHERE id = ?'),
      listStreams: db.prepare('SELECT * FROM streams WHERE project_id = ? ORDER BY created_at ASC, id ASC'),
      insertLink: db.prepare('INSERT OR IGNORE INTO links (from_ticket, to_ticket, type) VALUES (?, ?, ?)'),
      deleteLink: db.prepare('DELETE FROM links WHERE from_ticket = ? AND to_ticket = ? AND type = ?'),
      listLinks: db.prepare('SELECT * FROM links WHERE from_ticket = ? OR to_ticket = ? ORDER BY type ASC'),
      insertEvent: db.prepare(`
        INSERT INTO events (event_uuid, ticket_id, project_id, topic, class, type, actor, actor_kind, actor_label, data, created_at)
        VALUES (@event_uuid, @ticket_id, @project_id, @topic, @class, @type, @actor, @actor_kind, @actor_label, @data, @created_at)
      `),
      getEventByUuid: db.prepare('SELECT * FROM events WHERE event_uuid = ?'),
      upsertSubscription: db.prepare(`
        INSERT INTO subscriptions (id, session_id, topic, classes_filter, status, manual, cursor_seq, created_at, expires_at, reason)
        VALUES (@id, @session_id, @topic, @classes_filter, 'active', @manual, @cursor_seq, @created_at, @expires_at, @reason)
        ON CONFLICT(session_id, topic) DO UPDATE SET
          classes_filter = excluded.classes_filter,
          status = 'active',
          manual = CASE WHEN subscriptions.manual = 1 OR excluded.manual = 1 THEN 1 ELSE 0 END,
          expires_at = excluded.expires_at,
          reason = excluded.reason
      `),
      suspendSubscription: db.prepare(`
        UPDATE subscriptions
        SET status = 'suspended', reason = @reason
        WHERE session_id = @session_id AND topic = @topic AND status = 'active'
      `),
      suspendSubscriptionsForSession: db.prepare(`
        UPDATE subscriptions
        SET status = 'suspended', reason = @reason
        WHERE session_id = @session_id AND status = 'active'
      `),
      reactivateSubscriptionsForSession: db.prepare(`
        UPDATE subscriptions
        SET status = 'active', reason = @reason
        WHERE session_id = @session_id AND status = 'suspended'
      `),
      deleteSubscriptionsForSession: db.prepare('DELETE FROM subscriptions WHERE session_id = ?'),
      getSubscriptionById: db.prepare('SELECT * FROM subscriptions WHERE id = ?'),
      listSubscriptions: db.prepare('SELECT * FROM subscriptions WHERE (@session_id IS NULL OR session_id = @session_id) ORDER BY created_at ASC, id ASC'),
      listActiveSubscriptions: db.prepare("SELECT * FROM subscriptions WHERE status = 'active' ORDER BY created_at ASC, id ASC"),
      advanceSubscriptionCursor: db.prepare("UPDATE subscriptions SET cursor_seq = @to_seq WHERE id = @id AND cursor_seq = @from_seq AND status = 'active'"),
      getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
      // TKT-0245: dispatch_queue prepared statements.
      insertDispatchQueue: db.prepare(`
        INSERT INTO dispatch_queue (id, ticket_id, project_id, session_id, note, workspace, envelope_id, status, created_at)
        VALUES (@id, @ticket_id, @project_id, @session_id, @note, @workspace, @envelope_id, 'pending', @created_at)
      `),
      cancelPendingForTicket: db.prepare(
        "UPDATE dispatch_queue SET status = 'cancelled', resolved_at = @resolved_at WHERE ticket_id = @ticket_id AND status = 'pending'"
      ),
      getPendingForTicket: db.prepare(
        "SELECT * FROM dispatch_queue WHERE ticket_id = ? AND status IN ('pending','next_turn')"
      ),
      getQueueRow: db.prepare('SELECT * FROM dispatch_queue WHERE id = ?'),
      cancelQueueRow: db.prepare(
        "UPDATE dispatch_queue SET status = 'cancelled', resolved_at = @resolved_at WHERE id = @id AND status = 'pending'"
      ),
      expireQueueRow: db.prepare(
        "UPDATE dispatch_queue SET status = 'expired', last_error = @last_error, resolved_at = @resolved_at WHERE id = @id AND status = 'pending'"
      ),
      markQueueDeliveredRow: db.prepare(
        "UPDATE dispatch_queue SET status = 'delivered', delivered_at = @delivered_at, last_error = @last_error, resolved_at = @resolved_at, publishing_owner = NULL, publishing_expires_at = NULL WHERE id = @id AND status IN ('pending','next_turn','publishing') AND (status != 'publishing' OR publishing_owner = @owner)"
      ),
      markQueueNextTurnRow: db.prepare("UPDATE dispatch_queue SET status = 'next_turn', publishing_owner = NULL, publishing_expires_at = NULL WHERE id = @id AND status = 'publishing' AND publishing_owner = @owner"),
      claimQueuePublishingRow: db.prepare("UPDATE dispatch_queue SET status = 'publishing', publishing_owner = @owner, publishing_expires_at = @expires WHERE id = @id AND (status = 'pending' OR (status = 'publishing' AND publishing_expires_at < @now))"),
      releaseQueuePublishingRow: db.prepare("UPDATE dispatch_queue SET status = 'pending', publishing_owner = NULL, publishing_expires_at = NULL WHERE id = @id AND status = 'publishing' AND publishing_owner = @owner"),
      listPendingDispatches: db.prepare(
        "SELECT * FROM dispatch_queue WHERE status IN ('pending','publishing') ORDER BY created_at ASC"
      ),
      listPendingForSession: db.prepare(
        "SELECT * FROM dispatch_queue WHERE session_id = ? AND status IN ('pending','next_turn') ORDER BY created_at ASC"
      ),
      countPendingForSession: db.prepare(
        "SELECT COUNT(*) AS n FROM dispatch_queue WHERE session_id = ? AND status IN ('pending','next_turn')"
      ),
      countPendingBySession: db.prepare(
        "SELECT session_id, COUNT(*) AS n FROM dispatch_queue WHERE status IN ('pending','next_turn') GROUP BY session_id"
      ),
      currentInProgressForSession: db.prepare(
        "SELECT id, display_id, title FROM tickets WHERE state = 'in_progress' AND (assignee = ? OR dispatched_to = ?) ORDER BY state_changed_at DESC, updated_at DESC, seq DESC LIMIT 1"
      ),
      setTicketAssignee: db.prepare(
        'UPDATE tickets SET assignee = @assignee, updated_at = @updated_at WHERE id = @id'
      ),
      // TKT-0266: durable session-name labels.
      getSessionLabel: db.prepare('SELECT * FROM session_labels WHERE session_id = ?'),
      setSessionLabel: db.prepare(`
        INSERT INTO session_labels (session_id, label, project_id, last_seen_at)
        VALUES (@session_id, @label, @project_id, @last_seen_at)
        ON CONFLICT(session_id) DO UPDATE SET
          label = excluded.label,
          project_id = excluded.project_id,
          last_seen_at = excluded.last_seen_at
      `),
      insertEnvelope: db.prepare(`
        INSERT INTO message_envelopes
          (id, root_id, parent_id, ticket_id, project_id, sender_id, reply_to_session_id, recipient_session_id, sender_session_id, target_session_id, kind, payload, status, ack_deadline_at, created_at, expires_at)
        VALUES (@id, @root_id, @parent_id, @ticket_id, @project_id, @sender_id, @reply_to_session_id, @recipient_session_id, @sender_session_id, @target_session_id, @kind, @payload, @status, @ack_deadline_at, @created_at, @expires_at)
      `),
      getEnvelope: db.prepare('SELECT * FROM message_envelopes WHERE id = ?'),
      setEnvelopePayload: db.prepare(`UPDATE message_envelopes SET payload = @payload
        WHERE id = @id AND status = 'pending' AND delivery_attempted_at IS NULL`),
      renewEnvelopeExpiry: db.prepare(`UPDATE message_envelopes SET expires_at = @expires_at
        WHERE id = @id AND completed_at IS NULL
          AND status IN ('pending', 'queued', 'delivery_failed')
          AND delivery_state IN ('pending', 'published')`),
      insertEnvelopeFact: db.prepare(`INSERT OR IGNORE INTO message_acknowledgements
        (envelope_id, recipient_session_id, kind, summary, acknowledged_at)
        VALUES (@envelope_id, @recipient_session_id, @kind, @summary, @acknowledged_at)`),
      supersedeOpenEnvelopes: db.prepare(`UPDATE message_envelopes SET completed_at = @ts, status = 'superseded'
        WHERE ticket_id = @ticket_id AND recipient_session_id != @recipient_session_id
          AND completed_at IS NULL AND kind = 'ticket_dispatch'`),
      markEnvelopeDelivery: db.prepare(`
        UPDATE message_envelopes
        SET status = CASE WHEN @error IS NULL THEN 'delivered' ELSE 'delivery_failed' END,
            delivery_state = CASE
              WHEN delivery_state IN ('accepted', 'settled', 'interrupted', 'recovery_required') THEN delivery_state
              WHEN @error IS NULL THEN 'published'
              ELSE 'pending'
            END,
            delivered_at = @delivered_at, delivery_attempted_at = @delivered_at,
            delivery_error = @error, last_error = @error,
            delivery_opportunity_at = CASE WHEN @error IS NULL THEN COALESCE(delivery_opportunity_at, @delivered_at) ELSE delivery_opportunity_at END,
            ack_deadline_at = CASE WHEN @error IS NULL AND kind = 'ticket_dispatch' THEN COALESCE(ack_deadline_at, @ack_deadline_at) ELSE ack_deadline_at END
        WHERE id = @id AND status IN ('pending', 'queued', 'delivery_failed')
      `),
      updateTypedEnvelopeLifecycle: db.prepare(`
        UPDATE message_envelopes
        SET status = @status,
            delivery_state = @delivery_state,
            delivery_attempt_id = COALESCE(@delivery_attempt_id, delivery_attempt_id),
            accepted_attempt_id = COALESCE(accepted_attempt_id, @accepted_attempt_id),
            delivery_attempted_at = COALESCE(@delivery_attempted_at, delivery_attempted_at),
            delivery_error = @delivery_error,
            last_error = @delivery_error,
            delivered_at = CASE WHEN @delivery_state IN ('accepted', 'settled', 'interrupted', 'recovery_required')
              THEN COALESCE(delivered_at, @delivery_attempted_at) ELSE delivered_at END,
            delivery_opportunity_at = CASE WHEN @delivery_state = 'accepted'
              THEN COALESCE(delivery_opportunity_at, @delivery_attempted_at) ELSE delivery_opportunity_at END,
            ack_deadline_at = CASE WHEN @delivery_state = 'accepted' AND kind = 'ticket_dispatch'
              THEN COALESCE(ack_deadline_at, @ack_deadline_at) ELSE ack_deadline_at END,
            claimed_at = CASE WHEN @delivery_state = 'claimed' THEN COALESCE(claimed_at, @delivery_attempted_at) ELSE claimed_at END,
            accepted_at = CASE WHEN @delivery_state = 'accepted' THEN COALESCE(accepted_at, @delivery_attempted_at) ELSE accepted_at END,
            settled_at = CASE WHEN @delivery_state = 'settled' THEN COALESCE(settled_at, @delivery_attempted_at) ELSE settled_at END,
            interrupted_at = CASE WHEN @delivery_state = 'interrupted' THEN COALESCE(interrupted_at, @delivery_attempted_at) ELSE interrupted_at END,
            recovery_required_at = CASE WHEN @delivery_state = 'recovery_required' THEN COALESCE(recovery_required_at, @delivery_attempted_at) ELSE recovery_required_at END
        WHERE id = @id
      `),
      acknowledgeEnvelope: db.prepare(`
        UPDATE message_envelopes SET acknowledged_at = COALESCE(acknowledged_at, @ts),
            picked_up_at = COALESCE(picked_up_at, @ts)
        WHERE id = @id AND recipient_session_id = @target_session_id
      `),
      replyEnvelope: db.prepare(`
        UPDATE message_envelopes SET replied_at = COALESCE(replied_at, @ts), reply_envelope_id = COALESCE(reply_envelope_id, @reply_envelope_id)
        WHERE id = @id AND recipient_session_id = @target_session_id
      `),
      resolveEnvelope: db.prepare(`
        UPDATE message_envelopes SET status = @status, completed_at = @ts, last_error = @last_error
        WHERE id = @id AND status IN ('pending', 'queued', 'delivery_failed')
      `),
    };
  }

  // ---- internal helpers -------------------------------------------------

  function ticketTopic(ticket) {
    return ticket ? `ticket/${ticket.display_id || ticket.id}` : null;
  }

  function specTreeTopicForTicket(ticket) {
    if (!ticket?.parent_id) return null;
    const parent = stmts.getTicket.get(ticket.parent_id);
    if (!parent || parent.kind !== 'spec') return null;
    return `spec/${parent.display_id || parent.id}/tree`;
  }

  function actorLabel(actor, kind = actorKind(actor)) {
    const a = String(actor || '').trim();
    if (kind === 'session') return resolveAssigneeLabel(a) || a;
    return a || kind;
  }

  function maxEventSeqForTopic(topic) {
    if (!topic) return 0;
    return Number(db.prepare('SELECT MAX(id) AS m FROM events WHERE topic = ?').get(topic)?.m ?? 0);
  }

  // recordEvent — internal, also exported on the returned object. Persists one
  // bus row; `data` is JSON-serialized. Ticket-scoped tracker events default to
  // `ticket/<display_id>` and child tickets mirror onto `spec/<parent>/tree` so
  // managers/planners can subscribe to a whole spec tree without joins.
  function hydrateEvent(row) {
    return row ? { ...row, data: safeParse(row.data) } : null;
  }

  function applySubscriptionLifecycle({ session_id, type, actor = 'system:lifecycle' } = {}) {
    if (!session_id || !type) return { suspended: 0, reactivated: 0, purged: 0 };
    if (type === 'hook_session_end' || type === 'session_end') {
      const info = stmts.suspendSubscriptionsForSession.run({ session_id, reason: 'session_end' });
      return { suspended: info.changes, reactivated: 0, purged: 0 };
    }
    if (type === 'hook_session_start' || type === 'session_start' || type === 'session_resume') {
      const info = stmts.reactivateSubscriptionsForSession.run({ session_id, reason: 'session_active' });
      return { suspended: 0, reactivated: info.changes, purged: 0 };
    }
    if (type === 'session_purged') {
      const info = stmts.deleteSubscriptionsForSession.run(session_id);
      recordEvent({
        project_id: null,
        topic: `session/${session_id}`,
        class: 'lifecycle',
        type: 'session_subscriptions_purged',
        actor,
        data: { session_id, purged: info.changes },
      });
      return { suspended: 0, reactivated: 0, purged: info.changes };
    }
    return { suspended: 0, reactivated: 0, purged: 0 };
  }

  function recordEvent({ event_uuid = null, ticket_id = null, project_id = null, topic = null, class: eventClass = 'tracker', type, actor = null, actor_kind = null, actor_label = null, data = {}, created_at = null } = {}) {
    if (!type) throw new Error('recordEvent: type is required');
    const uuid = event_uuid == null ? null : String(event_uuid).trim() || null;
    if (uuid) {
      const existing = stmts.getEventByUuid.get(uuid);
      if (existing) return { ...hydrateEvent(existing), duplicate: true };
    }
    const cls = normalizeEventClass(eventClass);
    const ticket = ticket_id ? stmts.getTicket.get(ticket_id) : null;
    const derivedTopic = topic || ticketTopic(ticket);
    const kind = actor_kind || actorKind(actor);
    const row = {
      event_uuid: uuid,
      ticket_id,
      project_id: project_id ?? ticket?.project_id ?? null,
      topic: derivedTopic,
      class: cls,
      type,
      actor,
      actor_kind: kind,
      actor_label: actor_label ?? actorLabel(actor, kind),
      data: typeof data === 'string' ? data : JSON.stringify(data ?? {}),
      created_at: created_at ?? now(),
    };
    const info = stmts.insertEvent.run(row);
    const out = { id: Number(info.lastInsertRowid), ...row, data: safeParse(row.data) };
    // GOL-423 deliberately projects only the canonical ticket event. Spec-tree
    // mirrors are written below as separate rows and must never duplicate a
    // recipient's passive delta; activity/lifecycle telemetry is excluded too.
    if (ticket && cls === 'tracker' && derivedTopic === ticketTopic(ticket)) {
      projectPassiveEvent({ event: out, ticket });
    }
    const mirrorTopic = !topic && cls === 'tracker' ? specTreeTopicForTicket(ticket) : null;
    if (mirrorTopic && mirrorTopic !== derivedTopic) {
      const mirror = {
        ...row,
        topic: mirrorTopic,
        data: JSON.stringify({ ...safeParse(row.data), mirrored_from_seq: out.id, mirrored_from_topic: derivedTopic }),
      };
      stmts.insertEvent.run({ ...mirror, event_uuid: null });
    }
    if (cls === 'lifecycle') {
      out.subscription_lifecycle = applySubscriptionLifecycle({ session_id: safeParse(row.data).session_id, type, actor });
    }
    return out;
  }

  function normalizeIngestEvent(input = {}) {
    const hookEvent = normalizeHookType(input.event ?? input.hook_event ?? input.kind ?? input.type);
    const data = input.data && typeof input.data === 'object'
      ? { ...input.data }
      : { ...(input.payload && typeof input.payload === 'object' ? input.payload : {}) };
    const sessionId = String(input.session_id ?? data.session_id ?? '').trim() || null;
    const projectId = String(input.project_id ?? data.project_id ?? '').trim() || null;
    const projectPath = input.project_path ?? data.project_path ?? null;
    const eventClass = input.class ?? input.event_class ?? classForHookType(hookEvent);
    const ts = input.ts ?? input.created_at ?? now();
    return {
      event_uuid: eventUuid(input),
      ticket_id: input.ticket_id ?? data.ticket_id ?? null,
      project_id: projectId,
      topic: input.topic ?? (sessionId ? `session/${sessionId}` : (projectId ? `project/${projectId}/events` : 'hooks/unknown')),
      class: eventClass,
      type: input.bus_type ?? busTypeForHookType(hookEvent),
      actor: input.actor ?? (sessionId || 'system:hook'),
      actor_kind: input.actor_kind ?? (sessionId ? 'session' : 'system'),
      actor_label: input.actor_label ?? input.session_name ?? data.session_name ?? data.name ?? null,
      created_at: ts,
      data: {
        ...data,
        hook_event: hookEvent,
        session_id: sessionId,
        project_id: projectId,
        project_path: projectPath,
        cwd: input.cwd ?? data.cwd ?? null,
        payload: input.payload ?? data.payload ?? null,
      },
    };
  }

  function ingestBusEvents(input) {
    const events = Array.isArray(input) ? input : (Array.isArray(input?.events) ? input.events : [input]);
    const txn = db.transaction(() => {
      const rows = [];
      let inserted = 0;
      let duplicates = 0;
      let roster_inserted = 0;
      for (const raw of events) {
        const event = normalizeIngestEvent(raw || {});
        const row = recordEvent(event);
        if (row.duplicate) duplicates += 1;
        else inserted += 1;
        rows.push(row);
        const data = row.data || event.data || {};
        if (event.class === 'lifecycle' && data.project_id && data.session_id && ['hook_session_start', 'hook_session_end'].includes(event.type)) {
          const roster = recordEvent({
            ...event,
            event_uuid: event.event_uuid ? `${event.event_uuid}:roster` : null,
            topic: `project/${data.project_id}/roster`,
            type: event.type === 'hook_session_start' ? 'roster_session_active' : 'roster_session_ended',
            data: { ...data, source_event_seq: row.id, source_topic: row.topic },
          });
          if (!roster.duplicate) roster_inserted += 1;
          rows.push(roster);
        }
      }
      return { ok: true, accepted: events.length, inserted, duplicates, roster_inserted, events: rows };
    });
    return txn();
  }

  function safeParse(s) {
    try {
      return JSON.parse(s);
    } catch {
      return {};
    }
  }

  // ---- GOL-423 passive next-turn deltas ----------------------------------
  // These helpers intentionally live beside recordEvent: the event ledger is
  // the one durable source from which we can project a deterministic, bounded
  // recipient view without turning ordinary tracker activity into a push.
  function passiveJson(value) {
    return JSON.stringify(value ?? null);
  }

  function parsePassiveJson(raw, fallback = null) {
    try { return JSON.parse(raw); } catch { return fallback; }
  }

  function passiveText(value) {
    const text = value == null || value === '' ? 'none' : String(value);
    return text.length > 160 ? `${text.slice(0, 157)}…` : text;
  }

  function passiveIsBlocked(phase) {
    return phase === 'blocked' || phase === 'parked';
  }

  function resultForPhase(phase) {
    if (!['built', 'verified', 'rejected', 'done'].includes(phase)) return null;
    return {
      built: phase === 'built',
      verdict: phase === 'rejected' ? 'FAIL' : (phase === 'verified' ? 'PASS' : null),
      terminal: phase === 'done' ? 'done' : null,
    };
  }

  function mergePassiveResult(previous, next) {
    const prev = previous && typeof previous === 'object' ? previous : {};
    const value = {
      built: !!prev.built || !!next?.built,
      // FAIL wins if both verdicts were observed before a batch is consumed.
      verdict: prev.verdict === 'FAIL' || next?.verdict === 'FAIL'
        ? 'FAIL'
        : (prev.verdict === 'PASS' || next?.verdict === 'PASS' ? 'PASS' : null),
      terminal: prev.terminal === 'done' || next?.terminal === 'done' ? 'done' : null,
    };
    return value;
  }

  function passiveChangesForEvent(event) {
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    const changes = [];
    const phaseEvent = event.type === 'phase_change' || event.type === 'state_change' || event.type === 'auto_archived';
    const fromPhase = data.from_phase ?? data.from ?? null;
    const toPhase = data.to_phase ?? data.to ?? null;
    if (phaseEvent && toPhase != null && fromPhase !== toPhase) {
      changes.push({ category: 'phase', baseline: fromPhase, value: toPhase });
      const fromBlocked = passiveIsBlocked(fromPhase);
      const toBlocked = passiveIsBlocked(toPhase);
      if (fromBlocked !== toBlocked) {
        changes.push({ category: 'blocker', baseline: fromBlocked ? 'blocked' : 'clear', value: toBlocked ? 'blocked' : 'clear' });
      }
      const result = resultForPhase(toPhase);
      if (result) changes.push({ category: 'result', baseline: { built: false, verdict: null, terminal: null }, value: result });
    }
    if (event.type === 'assigned') {
      changes.push({ category: 'assignment', baseline: data.from ?? null, value: data.to ?? null });
    } else if (event.type === 'dispatched' || event.type === 'dispatch_queued') {
      changes.push({ category: 'assignment', baseline: data.from ?? null, value: data.to ?? data.session_id ?? null });
    } else if (event.type === 'dispatch_revoked') {
      changes.push({ category: 'assignment', baseline: data.previous_session_id ?? null, value: data.next_session_id ?? null });
    }
    return changes;
  }

  function passiveRecipientAllowed(sessionId, actor) {
    const id = String(sessionId || '').trim();
    if (!id || id === String(actor || '').trim()) return false;
    if (id === 'human' || id === 'you' || id === 'unattributed' || id === 'system' || id.startsWith('human:')) return false;
    return true;
  }

  function passiveRelationshipRecipients(ticket, actor) {
    const contexts = [ticket];
    const parent = ticket?.parent_id ? stmts.getTicket.get(ticket.parent_id) : null;
    if (parent?.kind === 'spec') contexts.push(parent);
    const candidates = new Set();
    const topics = new Set();
    for (const context of contexts) {
      if (!context) continue;
      candidates.add(context.assignee);
      candidates.add(context.dispatched_to);
      const envelope = db.prepare(`SELECT sender_id, reply_to_session_id, recipient_session_id, sender_session_id, target_session_id
        FROM message_envelopes
        WHERE ticket_id = ? AND status != 'superseded'
        ORDER BY created_at DESC, id DESC LIMIT 1`).get(context.id);
      if (envelope) {
        for (const key of ['sender_id', 'reply_to_session_id', 'recipient_session_id', 'sender_session_id', 'target_session_id']) candidates.add(envelope[key]);
      }
      const topic = ticketTopic(context);
      if (topic) topics.add(topic);
      if (context.kind === 'spec') topics.add(`spec/${context.display_id || context.id}/tree`);
    }
    if (topics.size) {
      const placeholders = [...topics].map(() => '?').join(', ');
      for (const row of db.prepare(`SELECT session_id FROM subscriptions
        WHERE status = 'active' AND manual = 1 AND topic IN (${placeholders})`).all(...topics)) {
        candidates.add(row.session_id);
      }
    }
    return [...candidates].filter((sessionId) => passiveRecipientAllowed(sessionId, actor));
  }

  function upsertPassiveSlot({ sessionId, ticketId, category, baseline, value, eventId, ts }) {
    const existing = db.prepare(`SELECT * FROM passive_slots
      WHERE session_id = ? AND ticket_id = ? AND category = ?`).get(sessionId, ticketId, category);
    const firstBaseline = existing ? parsePassiveJson(existing.baseline) : baseline;
    const nextValue = category === 'result'
      ? mergePassiveResult(existing ? parsePassiveJson(existing.value, {}) : {}, value)
      : value;
    if (category !== 'result' && passiveJson(firstBaseline) === passiveJson(nextValue)) {
      if (existing) db.prepare('DELETE FROM passive_slots WHERE session_id = ? AND ticket_id = ? AND category = ?').run(sessionId, ticketId, category);
      return;
    }
    if (existing) {
      db.prepare(`UPDATE passive_slots SET value = ?, last_event_id = ?, updated_at = ?
        WHERE session_id = ? AND ticket_id = ? AND category = ?`).run(
        passiveJson(nextValue), eventId, ts, sessionId, ticketId, category,
      );
      return;
    }
    db.prepare(`INSERT INTO passive_slots
      (session_id, ticket_id, category, baseline, value, first_event_id, last_event_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      sessionId, ticketId, category, passiveJson(firstBaseline), passiveJson(nextValue), eventId, eventId, ts, ts,
    );
  }

  function projectPassiveEvent({ event, ticket }) {
    const changes = passiveChangesForEvent(event);
    if (!changes.length) return;
    const recipients = passiveRelationshipRecipients(ticket, event.actor);
    if (!recipients.length) return;
    for (const sessionId of recipients) {
      for (const change of changes) {
        upsertPassiveSlot({
          sessionId,
          ticketId: ticket.id,
          category: change.category,
          baseline: change.baseline,
          value: change.value,
          eventId: event.id,
          ts: event.created_at,
        });
      }
    }
  }

  function passiveCategoryLine(category, baseline, value) {
    if (category === 'result') {
      const result = value && typeof value === 'object' ? value : {};
      return `result: ${[result.built ? 'built' : null, result.verdict, result.terminal].filter(Boolean).join('; ') || 'updated'}`;
    }
    const from = passiveText(baseline);
    const to = passiveText(value);
    return from === to ? `${category}: ${to}` : `${category}: ${from} → ${to}`;
  }

  function buildPassiveBatch(sessionId) {
    const rows = db.prepare(`SELECT s.*, t.display_id, t.seq
      FROM passive_slots s JOIN tickets t ON t.id = s.ticket_id
      WHERE s.session_id = ?
      ORDER BY t.seq ASC, t.id ASC,
        CASE s.category WHEN 'phase' THEN 1 WHEN 'assignment' THEN 2 WHEN 'blocker' THEN 3 WHEN 'result' THEN 4 ELSE 99 END ASC`).all(sessionId);
    if (!rows.length) return null;
    const byTicket = new Map();
    for (const row of rows) {
      const group = byTicket.get(row.ticket_id) ?? { ticket_id: row.ticket_id, label: row.display_id || row.ticket_id, slots: [] };
      group.slots.push(row);
      byTicket.set(row.ticket_id, group);
    }
    const groups = [];
    let body = 'Since your last turn:';
    for (const group of byTicket.values()) {
      if (groups.length >= PASSIVE_GROUP_CAP) break;
      const lines = [`- ${passiveText(group.label)}`];
      for (const slot of group.slots) {
        lines.push(`  ${passiveCategoryLine(slot.category, parsePassiveJson(slot.baseline), parsePassiveJson(slot.value))}`);
      }
      const candidate = `${body}\n${lines.join('\n')}`;
      if (Buffer.byteLength(candidate, 'utf8') > PASSIVE_BYTE_CAP) break;
      body = candidate;
      groups.push(group);
    }
    if (!groups.length) return null;
    const slots = groups.flatMap((group) => group.slots.map((slot) => ({
      ticket_id: slot.ticket_id,
      category: slot.category,
      last_event_id: Number(slot.last_event_id),
    })));
    return {
      id: crypto.randomUUID(),
      body,
      slots,
      ticket_count: groups.length,
      to_seq: Math.max(...slots.map((slot) => slot.last_event_id)),
    };
  }

  function claimPassiveDelta(sessionId, { leaseMs = PASSIVE_LEASE_MS } = {}) {
    if (!sessionId) throw new Error('claimPassiveDelta: session_id is required');
    const ts = now();
    const safeLeaseMs = Math.max(1_000, Math.min(120_000, Number(leaseMs) || PASSIVE_LEASE_MS));
    return db.transaction(() => {
      const cursor = db.prepare('SELECT * FROM passive_cursors WHERE session_id = ?').get(sessionId);
      const leaseActive = cursor?.lease_id && Date.parse(cursor.lease_expires_at || '') > Date.parse(ts);
      if (cursor?.pending_batch_id) {
        if (leaseActive) return { busy: true, retry_at: cursor.lease_expires_at };
        const lease_id = crypto.randomUUID();
        const lease_expires_at = new Date(Date.parse(ts) + safeLeaseMs).toISOString();
        db.prepare('UPDATE passive_cursors SET lease_id = ?, lease_expires_at = ?, updated_at = ? WHERE session_id = ?')
          .run(lease_id, lease_expires_at, ts, sessionId);
        const slots = parsePassiveJson(cursor.pending_slots, []);
        return {
          lease_id,
          replayed: true,
          batch: { id: cursor.pending_batch_id, body: cursor.pending_body, ticket_count: new Set(slots.map((slot) => slot.ticket_id)).size, to_seq: cursor.pending_to_seq },
        };
      }
      const batch = buildPassiveBatch(sessionId);
      if (!batch) {
        if (!cursor) db.prepare('INSERT INTO passive_cursors (session_id, cursor_seq, updated_at) VALUES (?, 0, ?)').run(sessionId, ts);
        return { batch: null };
      }
      const lease_id = crypto.randomUUID();
      const lease_expires_at = new Date(Date.parse(ts) + safeLeaseMs).toISOString();
      if (cursor) {
        db.prepare(`UPDATE passive_cursors SET pending_batch_id = ?, pending_body = ?, pending_slots = ?, pending_to_seq = ?,
          lease_id = ?, lease_expires_at = ?, pending_created_at = ?, updated_at = ? WHERE session_id = ?`).run(
          batch.id, batch.body, passiveJson(batch.slots), batch.to_seq, lease_id, lease_expires_at, ts, ts, sessionId,
        );
      } else {
        db.prepare(`INSERT INTO passive_cursors
          (session_id, cursor_seq, pending_batch_id, pending_body, pending_slots, pending_to_seq, lease_id, lease_expires_at, pending_created_at, updated_at)
          VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          sessionId, batch.id, batch.body, passiveJson(batch.slots), batch.to_seq, lease_id, lease_expires_at, ts, ts,
        );
      }
      return { lease_id, replayed: false, batch: { id: batch.id, body: batch.body, ticket_count: batch.ticket_count, to_seq: batch.to_seq } };
    })();
  }

  function commitPassiveDelta(sessionId, leaseId) {
    if (!sessionId || !leaseId) throw new Error('commitPassiveDelta: session_id and lease_id are required');
    const ts = now();
    return db.transaction(() => {
      const cursor = db.prepare('SELECT * FROM passive_cursors WHERE session_id = ?').get(sessionId);
      if (!cursor?.pending_batch_id) return { committed: false, missing: true };
      if (cursor.lease_id !== leaseId) throw new Error('commitPassiveDelta: lease does not match current claim');
      const slots = parsePassiveJson(cursor.pending_slots, []);
      const remove = db.prepare(`DELETE FROM passive_slots
        WHERE session_id = ? AND ticket_id = ? AND category = ? AND last_event_id <= ?`);
      let removed = 0;
      for (const slot of slots) {
        removed += remove.run(sessionId, slot.ticket_id, slot.category, Number(slot.last_event_id) || 0).changes;
      }
      db.prepare(`UPDATE passive_cursors SET cursor_seq = MAX(cursor_seq, ?), pending_batch_id = NULL, pending_body = NULL,
        pending_slots = NULL, pending_to_seq = NULL, lease_id = NULL, lease_expires_at = NULL, pending_created_at = NULL, updated_at = ?
        WHERE session_id = ?`).run(Number(cursor.pending_to_seq) || 0, ts, sessionId);
      return { committed: true, removed, cursor_seq: Math.max(Number(cursor.cursor_seq) || 0, Number(cursor.pending_to_seq) || 0) };
    })();
  }

  function releasePassiveDelta(sessionId, leaseId) {
    if (!sessionId || !leaseId) throw new Error('releasePassiveDelta: session_id and lease_id are required');
    return db.transaction(() => {
      // Compare-and-swap the lease in the UPDATE itself. A release that was
      // delayed behind an expired/reclaimed cursor must never clear its newer
      // lease after the caller's initial view became stale.
      const info = db.prepare(`UPDATE passive_cursors
        SET lease_id = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE session_id = ? AND lease_id = ? AND pending_batch_id IS NOT NULL`).run(now(), sessionId, leaseId);
      if (info.changes) return { released: true };
      const cursor = db.prepare('SELECT pending_batch_id FROM passive_cursors WHERE session_id = ?').get(sessionId);
      if (!cursor?.pending_batch_id) return { released: false, missing: true };
      throw new Error('releasePassiveDelta: lease does not match current claim');
    })();
  }

  // TKT-0266: resolve an assignee/dispatched_to value to its persisted durable
  // label from session_labels. Returns null for 'human' (the UI renders "You")
  // and for sessions with no persisted label (caller falls back to the live
  // resolver). stmts is populated after prepare(), which runs before any
  // getTicket/listTickets call, so this is safe at request time.
  function resolveAssigneeLabel(assignee) {
    if (!assignee || assignee === 'human') return null;
    try {
      const row = stmts.getSessionLabel.get(assignee);
      return row ? row.label : null;
    } catch {
      return null;
    }
  }

  function activeActorFormsForSession(sessionId) {
    const out = new Set([sessionId].filter(Boolean));
    const label = resolveAssigneeLabel(sessionId);
    if (label) out.add(label);
    return [...out];
  }

  function hasSupersedingDispatch(ticketId, deliveryEventId) {
    return !!db.prepare(`
      SELECT 1 FROM events
      WHERE ticket_id = @ticket_id
        AND id > @delivery_event_id
        AND type IN ('dispatch_queued', 'dispatched', 'dispatch_delivery_attempted')
      LIMIT 1
    `).get({ ticket_id: ticketId, delivery_event_id: deliveryEventId });
  }

  function hydrateSubscription(row) {
    return row ? { ...row, classes_filter: parseClasses(row.classes_filter) } : null;
  }

  function subscribeSession({ session_id, topic, classes = null, cursor_seq = null, expires_at = null, reason = null } = {}) {
    if (!session_id) throw new Error('subscribe: session_id is required');
    if (!topic) throw new Error('subscribe: topic is required');
    const ts = now();
    const row = {
      id: crypto.randomUUID(),
      session_id,
      topic,
      classes_filter: serializeClasses(classes),
      manual: reason == null || reason === 'manual' ? 1 : 0,
      cursor_seq: cursor_seq == null ? maxEventSeqForTopic(topic) : Math.max(0, Number(cursor_seq) || 0),
      created_at: ts,
      expires_at: expires_at ?? null,
      reason: reason ?? null,
    };
    stmts.upsertSubscription.run(row);
    const existing = db.prepare('SELECT * FROM subscriptions WHERE session_id = ? AND topic = ?').get(session_id, topic);
    return hydrateSubscription(existing);
  }

  function activeSubscriptionsBySession() {
    const out = new Map();
    for (const row of stmts.listActiveSubscriptions.all()) {
      const sub = hydrateSubscription(row);
      const arr = out.get(sub.session_id) ?? [];
      arr.push(sub);
      out.set(sub.session_id, arr);
    }
    return out;
  }

  function pendingEventsForSubscription(sub, cap = SUBSCRIPTION_BACKLOG_CAP) {
    const classes = parseClasses(sub.classes_filter);
    const placeholders = classes.map((_, i) => `@c${i}`).join(', ');
    const params = { topic: sub.topic, cursor_seq: Number(sub.cursor_seq) || 0, limit: cap + 1 };
    classes.forEach((cls, i) => { params[`c${i}`] = cls; });
    const rows = db.prepare(`
      SELECT * FROM events
      WHERE topic = @topic
        AND id > @cursor_seq
        AND class IN (${placeholders})
      ORDER BY id ASC
      LIMIT @limit
    `).all(params);
    const maxRow = db.prepare(`
      SELECT MAX(id) AS max_seq, COUNT(*) AS count
      FROM events
      WHERE topic = @topic
        AND id > @cursor_seq
        AND class IN (${placeholders})
    `).get(params);
    const count = Number(maxRow?.count ?? rows.length);
    const maxSeq = Number(maxRow?.max_seq ?? sub.cursor_seq ?? 0);
    const truncated = count > cap;
    return {
      subscription: sub,
      events: rows.slice(0, cap).map((e) => ({ ...e, data: safeParse(e.data) })),
      count,
      truncated,
      omitted: truncated ? Math.max(0, count - cap) : 0,
      from_seq: Number(sub.cursor_seq) || 0,
      to_seq: maxSeq,
    };
  }

  function hasUnackedDismissal(ticketId, deliveryEventId) {
    return !!db.prepare(`
      SELECT 1 FROM events
      WHERE ticket_id = @ticket_id
        AND type = 'dispatch_unacked_dismissed'
        AND CAST(json_extract(data, '$.delivery_event_id') AS INTEGER) = @delivery_event_id
      LIMIT 1
    `).get({ ticket_id: ticketId, delivery_event_id: deliveryEventId });
  }

  function hasTargetTicketActivity(ticketId, deliveryEventId, sessionId) {
    const ticket = stmts.getTicket.get(ticketId);
    if (!ticket) return false;
    const actorForms = activeActorFormsForSession(sessionId);
    const actorPlaceholders = actorForms.map((_, i) => `@actor${i}`).join(', ');
    const params = { ticket_id: ticketId, delivery_event_id: deliveryEventId, session_id: sessionId };
    actorForms.forEach((actor, i) => { params[`actor${i}`] = actor; });
    const actorClause = actorForms.length ? `a.actor IN (${actorPlaceholders})` : '0';

    // Some MCP/REST paths still record the acting session as `human` or a
    // durable label instead of the raw session id. If the ticket is still owned
    // by the delivered-to session, any later ticket/comment lifecycle event is
    // sufficient proof that the target picked it up.
    const ownerActivity = ticket.assignee === sessionId || ticket.dispatched_to === sessionId;
    return !!db.prepare(`
      SELECT 1 FROM events a
      WHERE a.ticket_id = @ticket_id
        AND a.id > @delivery_event_id
        AND a.type NOT IN ('dispatch_unacked_warning', 'dispatch_unacked_dismissed')
        AND (
          ${actorClause}
          OR (
            @owner_activity = 1
            AND a.type IN ('state_change', 'commented', 'comment_updated', 'assigned', 'rank_change')
          )
        )
      LIMIT 1
    `).get({ ...params, owner_activity: ownerActivity ? 1 : 0 });
  }

  function unackedWarningResolved({ ticket_id, delivery_event_id, session_id }) {
    if (!ticket_id || !delivery_event_id || !session_id) return true;
    return hasUnackedDismissal(ticket_id, delivery_event_id)
      || hasSupersedingDispatch(ticket_id, delivery_event_id)
      || hasTargetTicketActivity(ticket_id, delivery_event_id, session_id);
  }

  function activeUnackedWarnings(ticketId = null) {
    const rows = db.prepare(`
      SELECT w.id AS warning_event_id, w.ticket_id, w.project_id, w.created_at AS warned_at,
             w.data AS warning_data, t.display_id, t.title, sl.label AS session_label
      FROM events w
      JOIN tickets t ON t.id = w.ticket_id
      LEFT JOIN session_labels sl ON sl.session_id = json_extract(w.data, '$.session_id')
      WHERE w.type = 'dispatch_unacked_warning'
        AND (@ticket_id IS NULL OR w.ticket_id = @ticket_id)
      ORDER BY w.created_at ASC, w.id ASC
    `).all({ ticket_id: ticketId });
    const legacy = rows.map((row) => {
      const data = safeParse(row.warning_data);
      const deliveryEventId = Number(data.delivery_event_id);
      return {
        warning_event_id: row.warning_event_id,
        ticket_id: row.ticket_id,
        project_id: row.project_id,
        delivery_event_id: Number.isFinite(deliveryEventId) ? deliveryEventId : null,
        session_id: data.session_id ?? null,
        session_label: row.session_label ?? null,
        delivered_at: data.delivered_at ?? null,
        warned_at: row.warned_at,
        window_minutes: data.window_minutes ?? null,
        display_id: row.display_id ?? null,
        title: row.title ?? null,
      };
    }).filter((w) => !unackedWarningResolved(w));
    // v13 envelopes require explicit facts. A queued envelope has no delivery
    // attempt/opportunity, so it is never reported as unhealthy.
    const envelopes = db.prepare(`
      SELECT e.*, t.display_id, t.title, sl.label AS session_label,
             escalation.acknowledged_at AS escalation_acknowledged_at,
             escalation.status AS escalation_status,
             escalation.delivery_error AS escalation_delivery_error
      FROM message_envelopes e JOIN tickets t ON t.id = e.ticket_id
      LEFT JOIN session_labels sl ON sl.session_id = e.recipient_session_id
      LEFT JOIN message_envelopes escalation ON escalation.id = e.escalation_envelope_id
      WHERE e.kind = 'ticket_dispatch' AND (@ticket_id IS NULL OR e.ticket_id = @ticket_id)
        AND e.delivery_attempted_at IS NOT NULL AND e.acknowledged_at IS NULL AND e.completed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM events d WHERE d.ticket_id = e.ticket_id
          AND d.type = 'dispatch_unacked_dismissed' AND json_extract(d.data, '$.envelope_id') = e.id)
    `).all({ ticket_id: ticketId }).map((e) => {
      // An acknowledged escalation remains timeline evidence, but no longer
      // represents an outstanding escalation. A failed escalation remains red
      // even if a later acknowledgement fact exists.
      const escalationOutstanding = !!e.escalation_envelope_id
        && (e.escalation_status === 'delivery_failed' || !!e.escalation_delivery_error || !e.escalation_acknowledged_at);
      return {
        attention_kind: 'envelope', envelope_id: e.id, ticket_id: e.ticket_id, project_id: e.project_id,
        session_id: e.recipient_session_id, session_label: e.session_label ?? null, display_id: e.display_id,
        title: e.title, delivered_at: e.delivery_opportunity_at || e.delivered_at,
        severity: escalationOutstanding ? 'escalated' : (e.ping_envelope_id ? 'pinged' : (e.delivery_error ? 'failed' : 'awaiting')),
        ping_envelope_id: e.ping_envelope_id, escalation_envelope_id: e.escalation_envelope_id,
        delivery_error: e.delivery_error,
      };
    });
    return [...legacy, ...envelopes];
  }

  // GOL-425: presentation queries for the durable envelope protocol. These are
  // deliberately derived from message_envelopes, acknowledgement facts, and
  // dismissal events; they must never grow a second persisted "attention"
  // state. One row represents a dispatch root and its small child envelope
  // tree, which is the useful unit for a human handoff timeline.
  function envelopeRootRows(filter = {}) {
    const where = ["e.kind = 'ticket_dispatch'", '(e.root_id = e.id OR e.root_id IS NULL)'];
    const params = {};
    if (filter.envelope_id) { where.push('e.id = @envelope_id'); params.envelope_id = filter.envelope_id; }
    if (filter.project_id) { where.push('e.project_id = @project_id'); params.project_id = filter.project_id; }
    if (filter.ticket_id) { where.push('e.ticket_id = @ticket_id'); params.ticket_id = filter.ticket_id; }
    if (filter.session_id) { where.push('e.recipient_session_id = @session_id'); params.session_id = filter.session_id; }
    if (filter.from) { where.push('e.created_at >= @from'); params.from = filter.from; }
    if (filter.to) { where.push('e.created_at <= @to'); params.to = filter.to; }
    const limit = Math.min(500, Math.max(1, Number(filter.limit) || 100));
    if (!filter.all) params.limit = limit;
    return db.prepare(`
      SELECT e.*, t.display_id, t.title, sl.label AS session_label,
             dq.id AS queue_id, dq.status AS queue_status, dq.created_at AS queue_created_at
      FROM message_envelopes e
      LEFT JOIN tickets t ON t.id = e.ticket_id
      LEFT JOIN session_labels sl ON sl.session_id = e.recipient_session_id
      LEFT JOIN dispatch_queue dq ON dq.envelope_id = e.id AND dq.status = 'pending'
      WHERE ${where.join(' AND ')}
      ORDER BY e.created_at DESC, e.id DESC
      ${filter.all ? '' : 'LIMIT @limit'}
    `).all(params);
  }

  function factsForEnvelopeTree(rootId) {
    const children = db.prepare(`
      SELECT * FROM message_envelopes
      WHERE id = ? OR parent_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(rootId, rootId);
    const acknowledgements = new Map();
    for (const envelope of children) {
      const rows = db.prepare(`
        SELECT envelope_id, recipient_session_id, kind, summary, acknowledged_at
        FROM message_acknowledgements WHERE envelope_id = ?
        ORDER BY acknowledged_at ASC
      `).all(envelope.id);
      acknowledgements.set(envelope.id, rows);
    }
    return { children, acknowledgements };
  }

  function dismissalForEnvelope(root) {
    if (!root?.ticket_id) return null;
    return db.prepare(`
      SELECT id, actor, created_at
      FROM events
      WHERE ticket_id = ? AND type = 'dispatch_unacked_dismissed'
        AND json_extract(data, '$.envelope_id') = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(root.ticket_id, root.id) ?? null;
  }

  function envelopeView(root, nowMs = Date.now()) {
    const { children, acknowledgements } = factsForEnvelopeTree(root.id);
    const byKind = new Map(children.map((row) => [row.kind, row]));
    const ping = byKind.get('ack_ping') ?? null;
    const escalation = byKind.get('escalation') ?? null;
    const dismissal = dismissalForEnvelope(root);
    const closed = !!(root.acknowledged_at || root.completed_at);
    const queued = root.queue_status === 'pending';
    const deadlineMs = Date.parse(root.ack_deadline_at || '');
    const overdue = !closed && Number.isFinite(deadlineMs) && deadlineMs <= nowMs;
    const rootDeliveryFailed = root.status === 'delivery_failed' || !!root.delivery_error;
    const escalationFailed = !!escalation && (escalation.status === 'delivery_failed' || !!escalation.delivery_error);
    const escalationOutstanding = !!escalation && (escalationFailed || !escalation.acknowledged_at);
    const missingDelivery = !closed && !queued && !root.delivery_attempted_at
      && ['pending', 'delivery_failed'].includes(root.status);

    let severity = 'healthy';
    if (!dismissal && !closed) {
      if (escalationOutstanding) severity = 'escalated';
      else if (rootDeliveryFailed || missingDelivery) severity = 'failed';
      else if (root.delivery_attempted_at || root.delivery_opportunity_at) severity = (ping || overdue) ? 'pinged' : 'awaiting';
    }
    const active = !dismissal && !closed && (queued || severity !== 'healthy');
    // An escalation is for the original sender. It needs a human only when its
    // own acknowledgement never arrives, or when its delivery attempt failed.
    const needsAttention = !dismissal && !closed && escalationOutstanding;
    const state = needsAttention ? 'needs_attention' : (active ? 'in_flight' : 'history');

    const facts = [];
    const add = (kind, label, at, detail = null, factSeverity = null) => {
      if (!at) return;
      facts.push({ kind, label, at, detail: detail || null, severity: factSeverity || null });
    };
    add('assigned', `Assigned to ${root.session_label || root.recipient_session_id || 'target session'}`, root.created_at);
    if (queued) add('queued', 'Queued for an idle delivery opportunity', root.queue_created_at || root.created_at);
    if (root.delivery_attempted_at) {
      add(rootDeliveryFailed ? 'delivery_error' : 'delivery_attempt', rootDeliveryFailed ? 'Delivery attempt failed' : 'Delivery attempted', root.delivery_attempted_at, root.delivery_error || root.last_error, rootDeliveryFailed ? 'failed' : null);
    }
    if (root.delivery_opportunity_at) add('delivery_opportunity', 'Delivery opportunity recorded', root.delivery_opportunity_at);
    if (root.ack_deadline_at) add('deadline', 'Acknowledgement deadline', root.ack_deadline_at, overdue && !closed ? 'overdue' : null, overdue && !closed ? 'pinged' : null);
    for (const child of children) {
      const childFacts = acknowledgements.get(child.id) ?? [];
      if (child.id !== root.id) {
        const kindLabel = child.kind === 'ack_ping' ? 'Acknowledgement reminder' : child.kind === 'escalation' ? 'Escalation' : child.kind === 'reply' ? 'Reply' : child.kind;
        add(child.kind, `${kindLabel} created`, child.created_at);
      }
      if (child.delivery_attempted_at) {
        const failed = child.status === 'delivery_failed' || !!child.delivery_error;
        const kindLabel = child.kind === 'ack_ping' ? 'Reminder' : child.kind === 'escalation' ? 'Escalation' : child.kind === 'reply' ? 'Reply' : 'Delivery';
        add(failed ? `${child.kind}_delivery_error` : `${child.kind}_delivery`, failed ? `${kindLabel} delivery failed` : `${kindLabel} delivered`, child.delivery_attempted_at, child.delivery_error || child.last_error, failed ? 'failed' : null);
      }
      for (const ack of childFacts) {
        const via = child.kind === 'ack_ping' ? ' via reminder' : child.kind === 'escalation' ? ' for escalation' : '';
        add('acknowledged', `Acknowledged${via} by ${ack.recipient_session_id}`, ack.acknowledged_at, ack.kind || null);
      }
    }
    if (root.replied_at) add('reply', 'Reply recorded', root.replied_at);
    if (root.completed_at) {
      const label = root.status === 'superseded' ? 'Superseded by a newer dispatch'
        : root.status === 'cancelled' ? 'Cancelled'
          : root.status === 'expired' ? 'Expired'
            : 'Completed';
      add('completion', label, root.completed_at, root.last_error || null);
    }
    if (dismissal) add('dismissed', `Attention dismissed by ${dismissal.actor || 'human'}`, dismissal.created_at);
    facts.sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.label.localeCompare(b.label));

    return {
      id: root.id,
      root_id: root.root_id || root.id,
      ticket_id: root.ticket_id,
      ticket_display_id: root.display_id || root.ticket_id,
      ticket_title: root.title || null,
      project_id: root.project_id,
      session_id: root.recipient_session_id,
      session_label: root.session_label || null,
      created_at: root.created_at,
      status: root.status,
      severity,
      state,
      active,
      queued,
      overdue,
      dismissed: !!dismissal,
      needs_attention: needsAttention,
      facts,
    };
  }

  function matchesEnvelopeFilter(view, filter = {}) {
    const state = filter.state;
    if (state) {
      if (state === 'needs_attention' && !view.needs_attention) return false;
      else if (state === 'in_flight' && view.state !== 'in_flight') return false;
      else if (state === 'history' && view.state !== 'history') return false;
      else if (['queued', 'awaiting', 'pinged', 'failed', 'escalated', 'healthy'].includes(state)
        && !(state === 'queued' ? view.queued : view.severity === state)) return false;
    }
    if (filter.fact) {
      const hasFact = view.facts.some((fact) => {
        if (filter.fact === 'delivery') {
          return ['delivery_attempt', 'delivery_opportunity', 'delivery_error'].includes(fact.kind)
            || fact.kind.endsWith('_delivery') || fact.kind.endsWith('_delivery_error');
        }
        return fact.kind === filter.fact || fact.kind.startsWith(`${filter.fact}_`);
      });
      if (!hasFact) return false;
    }
    return true;
  }

  function listEnvelopeViews(filter = {}) {
    return envelopeRootRows(filter)
      .map((root) => envelopeView(root))
      .filter((view) => matchesEnvelopeFilter(view, filter));
  }

  function communicationHealth(filter = {}) {
    const items = listEnvelopeViews({ ...filter, all: true });
    const red = items.filter((item) => item.active && ['failed', 'escalated'].includes(item.severity)).length;
    const amber = items.filter((item) => item.active && ['awaiting', 'pinged'].includes(item.severity)).length;
    const queued = items.filter((item) => item.queued && !item.dismissed).length;
    const needsAttention = items.filter((item) => item.needs_attention).length;
    const inFlight = items.filter((item) => item.state === 'in_flight').length;
    return {
      health: {
        level: red > 0 ? 'red' : amber > 0 ? 'amber' : 'green',
        red,
        amber,
        queued,
        in_flight: inFlight,
        needs_attention: needsAttention,
      },
      needs_attention: items.filter((item) => item.needs_attention),
    };
  }

  // TKT-0519: derive + persist a project's display-id prefix. Candidates in
  // order: first 3 chars → first 4 → dash-split initials → base+2/3/… Take the
  // first not already in project_prefixes (UNIQUE enforces it). Once persisted,
  // never recomputed — stable even if the algorithm changes. Hoisted (function
  // declaration) so the v6 migration's backfill can call it before prepare().
  function ensurePrefix(projectId) {
    const existing = db.prepare('SELECT prefix FROM project_prefixes WHERE project_id = ?').get(projectId);
    if (existing) return existing.prefix;
    const slug = String(projectId).replace(/-[0-9a-f]{6}$/, '');
    const candidates = [slug.slice(0, 3).toUpperCase(), slug.slice(0, 4).toUpperCase()];
    const initials = slug.split('-').map((p) => p[0] || '').join('').toUpperCase();
    if (initials.length >= 2) candidates.push(initials);
    const base = slug.slice(0, 3).toUpperCase();
    for (let i = 2; i <= 99; i++) candidates.push(base + i);
    const taken = new Set(db.prepare('SELECT prefix FROM project_prefixes').all().map((r) => r.prefix));
    for (const c of candidates) {
      if (c && !taken.has(c)) {
        db.prepare('INSERT INTO project_prefixes (project_id, prefix) VALUES (?, ?)').run(projectId, c);
        return c;
      }
    }
    const fb = slug.toUpperCase().slice(0, 8);
    db.prepare('INSERT INTO project_prefixes (project_id, prefix) VALUES (?, ?)').run(projectId, fb);
    return fb;
  }

  // allocateTicketId — bump the global ticket_seq (canonical TKT id, unchanged)
  // AND the per-project pseq counter, inside one transaction. Monotonic +
  // collision-free under concurrent opens (better-sqlite3 transactions
  // serialize + busy_timeout retries — same guarantee the global counter relies
  // on today). pseq is initialized from MAX(pseq) if the meta counter is
  // missing (a project that predates the v6 backfill's counter seeding).
  const allocateTxn = db.transaction((projectId) => {
    const cur = Number(stmts.getMeta.get('ticket_seq')?.value ?? '0');
    const seq = cur + 1;
    stmts.setMeta.run('ticket_seq', String(seq));
    const id = `TKT-${String(seq).padStart(4, '0')}`;
    const pseqKey = `pseq:${projectId}`;
    const pseqRow = stmts.getMeta.get(pseqKey);
    let pseq;
    if (pseqRow) {
      pseq = Number(pseqRow.value) + 1;
    } else {
      const maxRow = db.prepare('SELECT MAX(pseq) AS m FROM tickets WHERE project_id = ?').get(projectId);
      pseq = (maxRow?.m ?? 0) + 1;
    }
    stmts.setMeta.run(pseqKey, String(pseq));
    const prefix = ensurePrefix(projectId);
    return { id, seq, pseq, display_id: `${prefix}-${pseq}` };
  });

  function allocateTicketId(projectId) {
    return allocateTxn(projectId);
  }

  // ---- public API -------------------------------------------------------

  const api = {
    init() {
      migrate();
      prepare();
      commentDispatch = createCommentDispatchService({
        db,
        now,
        recordEvent,
        actorFormsForSession: activeActorFormsForSession,
      });
      return api;
    },

    close() {
      db.close();
    },

    raw() {
      return db;
    },

    allocateTicketId,

    recordEvent,

    ingestBusEvents,

    claimPassiveDelta,

    commitPassiveDelta,

    releasePassiveDelta,

    subscribe({ session_id, topic, classes = null, cursor_seq = null, expires_at = null, reason = null } = {}) {
      return subscribeSession({ session_id, topic, classes, cursor_seq, expires_at, reason });
    },

    unsubscribe({ session_id, topic, reason = 'unsubscribe' } = {}) {
      if (!session_id) throw new Error('unsubscribe: session_id is required');
      if (!topic) throw new Error('unsubscribe: topic is required');
      const info = stmts.suspendSubscription.run({ session_id, topic, reason });
      return { ok: true, removed: info.changes, session_id, topic };
    },

    suspendSubscriptionsForSession(session_id, reason = 'session_end') {
      if (!session_id) throw new Error('suspendSubscriptionsForSession: session_id is required');
      const info = stmts.suspendSubscriptionsForSession.run({ session_id, reason });
      return { ok: true, suspended: info.changes, session_id };
    },

    reactivateSubscriptionsForSession(session_id, reason = 'session_active') {
      if (!session_id) throw new Error('reactivateSubscriptionsForSession: session_id is required');
      const info = stmts.reactivateSubscriptionsForSession.run({ session_id, reason });
      return { ok: true, reactivated: info.changes, session_id };
    },

    purgeSubscriptionsForSession(session_id) {
      if (!session_id) throw new Error('purgeSubscriptionsForSession: session_id is required');
      const info = stmts.deleteSubscriptionsForSession.run(session_id);
      return { ok: true, purged: info.changes, session_id };
    },

    listSubscriptions({ session_id = null } = {}) {
      return stmts.listSubscriptions.all({ session_id }).map(hydrateSubscription);
    },

    activeSubscriptionsBySession,

    pendingEventsForSubscription,

    advanceSubscriptionCursor(id, fromSeq, toSeq) {
      const info = stmts.advanceSubscriptionCursor.run({ id, from_seq: fromSeq, to_seq: toSeq });
      return { advanced: info.changes };
    },

    busStats() {
      const rows_per_class = db.prepare('SELECT class, COUNT(*) AS count FROM events GROUP BY class ORDER BY class ASC').all();
      const oldest = db.prepare('SELECT MIN(id) AS oldest_seq, MIN(created_at) AS oldest_created_at FROM events').get();
      const subscriptions_by_status = db.prepare('SELECT status, COUNT(*) AS count FROM subscriptions GROUP BY status ORDER BY status ASC').all();
      return { rows_per_class, oldest_seq: oldest?.oldest_seq ?? null, oldest_created_at: oldest?.oldest_created_at ?? null, subscriptions_by_status };
    },

    pruneBus({ nowTs = now(), lifecycleDays = 30, activityDays = 7, activityProjectCap = 100000, actor = 'system:bus-prune' } = {}) {
      const ts = nowTs;
      const lifecycleCutoff = new Date(Date.parse(ts) - Number(lifecycleDays || 30) * 86400_000).toISOString();
      const activityCutoff = new Date(Date.parse(ts) - Number(activityDays || 7) * 86400_000).toISOString();
      const txn = db.transaction(() => {
        const lifecycle = db.prepare("DELETE FROM events WHERE class = 'lifecycle' AND created_at < ?").run(lifecycleCutoff).changes;
        let activityAge = db.prepare("DELETE FROM events WHERE class = 'activity' AND created_at < ?").run(activityCutoff).changes;
        let activityCap = 0;
        const projects = db.prepare("SELECT project_id, COUNT(*) AS n FROM events WHERE class = 'activity' GROUP BY project_id").all();
        for (const p of projects) {
          const over = Number(p.n) - Number(activityProjectCap || 100000);
          if (over <= 0) continue;
          activityCap += db.prepare(`
            DELETE FROM events
            WHERE id IN (
              SELECT id FROM events
              WHERE class = 'activity' AND project_id IS @project_id
              ORDER BY id ASC
              LIMIT @over
            )
          `).run({ project_id: p.project_id, over }).changes;
        }
        const deleted = lifecycle + activityAge + activityCap;
        if (deleted > 0) {
          recordEvent({
            project_id: null,
            topic: 'bus/prune',
            class: 'lifecycle',
            type: 'bus_pruned',
            actor,
            data: { lifecycle, activity_age: activityAge, activity_cap: activityCap, deleted },
          });
        }
        return { deleted, lifecycle, activity_age: activityAge, activity_cap: activityCap };
      });
      return txn();
    },

    // TKT-0266: persist a durable session-name label. Change-gated + 5-min
    // staleness gate so the 3s native-sessions refresh tick does NOT write a
    // row every tick for every session. Writes only when the label actually
    // changed OR last_seen_at is >5 min stale (keeps last_seen_at fresh for
    // sessions that stay alive a long time without a name change). Skips
    // silently when session_id or label is empty (unnamed sessions are not
    // worth persisting — `session 1234abcd` is the live resolver's job).
    upsertSessionLabel(session_id, label, project_id = null) {
      if (!session_id || !label) return;
      const ts = now();
      const existing = stmts.getSessionLabel.get(session_id);
      if (existing && existing.label === label) {
        // Label unchanged — only refresh last_seen_at if it's >5 min stale.
        const ageMs = Date.parse(ts) - Date.parse(existing.last_seen_at);
        if (Number.isFinite(ageMs) && ageMs < 5 * 60 * 1000) return;
      }
      stmts.setSessionLabel.run({
        session_id,
        label,
        project_id: project_id ?? null,
        last_seen_at: ts,
      });
    },

    getSessionLabel(session_id) {
      if (!session_id) return null;
      return stmts.getSessionLabel.get(session_id) ?? null;
    },

    normalizePhase(kind, phase, context = 'ticket') {
      const nextPhase = phase ?? initialPhaseForKind(kind);
      if (!isKnownPhase(kind, nextPhase)) throw new Error(`${context}: invalid phase '${nextPhase}' for kind '${kind}'`);
      return nextPhase;
    },

    validatePhaseTransition(ticket, toPhase, input = {}) {
      const current = ticket.phase ?? phaseFromLegacyState(ticket.kind, ticket.state);
      if (!legalNextPhases(ticket.kind, current).includes(toPhase)) {
        throw new Error(`transitionTicket: illegal transition ${current} -> ${toPhase}`);
      }
      const comments = stmts.getComments.all(ticket.id);
      const hasComment = (re) => comments.some((c) => re.test(String(c.body || '')));
      const missing = [];
      const req = requirementsForPhase(ticket.kind, toPhase);
      if (req.reason && !String(input.reason || '').trim()) missing.push('reason');
      if (req.closingBrief && !hasComment(/closing\s+brief/i) && !input.closingBrief) missing.push('closingBrief');
      if (req.managerDispatch && !ticket.dispatched_to && !input.managerDispatch) missing.push('managerDispatch');
      if (req.verificationReport && !hasComment(/verification|verify-done|smoke|test/i) && !input.verificationReport) missing.push('verificationReport');
      if (req.verifiedOrSkipReason && current !== 'verified' && !String(input.skip_reason || input.reason || '').trim()) missing.push('verifiedOrSkipReason');
      if (req.answerComment && comments.length === 0 && !input.answerComment) missing.push('answerComment');
      if (req.decisionComment && !hasComment(/decision|decided/i) && !input.decisionComment) missing.push('decisionComment');
      if (req.children || req.childrenTerminal || req.childStarted) {
        const children = db.prepare('SELECT state FROM tickets WHERE parent_id = ?').all(ticket.id);
        if (req.children && children.length === 0) missing.push('children');
        if (req.childrenTerminal && children.some((c) => c.state !== 'done' && c.state !== 'archived')) missing.push('childrenTerminal');
        if (req.childStarted && !children.some((c) => c.state !== 'todo')) missing.push('childStarted');
      }
      if (req.waves) {
        const wave = db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE parent_id = ? AND wave IS NOT NULL').get(ticket.id)?.n ?? 0;
        if (!wave) missing.push('waves');
      }
      if (req.comment instanceof RegExp && !hasComment(req.comment)) missing.push('comment');
      if (missing.length) throw new Error(`transitionTicket: missing required artifact(s): ${missing.join(', ')}`);
      return { from: current, to: toPhase, missing: [] };
    },

    createTicket(input = {}) {
      const {
        project_id,
        kind = 'work-item',
        title,
        body = '',
        state = 'todo',
        phase = null,
        priority = null,
        labels = [],
        stream_id = null,
        parent_id = null,
        wave = null,
        assignee = null,
        created_by = 'human',
        source_ref = null,
      } = input;

      if (!project_id) throw new Error('createTicket: project_id is required');
      if (!title) throw new Error('createTicket: title is required');
      if (!KINDS.has(kind)) throw new Error(`createTicket: invalid kind '${kind}'`);
      if (!STATES.has(state)) throw new Error(`createTicket: invalid state '${state}'`);
      const normalizedWave = normalizeWave(wave, 'createTicket');
      const nextPhase = api.normalizePhase(kind, phase ?? phaseFromLegacyState(kind, state), 'createTicket');
      const nextState = state === 'archived' ? 'archived' : canonicalStateForPhase(kind, nextPhase);

      const ts = now();
      const bodyMd = toMarkdownBody(body);
      const txn = db.transaction(() => {
        const { id, seq, pseq, display_id } = allocateTicketId(project_id);
        const row = {
          id,
          seq,
          project_id,
          kind,
          title,
          body: bodyMd,
          state: nextState,
          phase: nextPhase,
          priority,
          labels: serializeLabels(labels),
          stream_id,
          parent_id,
          wave: normalizedWave,
          assignee,
          created_by,
          dispatched_to: null,
          dispatched_at: null,
          source_ref,
          created_at: ts,
          updated_at: ts,
          pseq,
          display_id,
        };
        stmts.insertTicket.run(row);
        recordEvent({
          ticket_id: id,
          project_id,
          type: 'created',
          actor: created_by,
          data: { kind, state: nextState, phase: nextPhase, title },
        });
        return row;
      });
      return hydrateTicket(txn());
    },

    getTicket(id) {
      const row = stmts.getTicket.get(id);
      if (!row) return null;
      const comments = stmts.getComments.all(id);
      const links = stmts.listLinks.all(id, id);
      // TKT-0245: embed any pending dispatch so the drawer needs no extra fetch.
      const pending_dispatch = stmts.getPendingForTicket.get(id) ?? null;
      // TKT-0266: derived durable assignee labels (never stored on the ticket).
      const hydrated = hydrateTicket(row);
      hydrated.assignee_label = resolveAssigneeLabel(row.assignee);
      hydrated.dispatched_to_label = resolveAssigneeLabel(row.dispatched_to);
      hydrated.has_pending_dispatch = !!stmts.getPendingForTicket.get(id);
      hydrated.active_unacked_dispatches = activeUnackedWarnings(id);
      hydrated.has_unacked_dispatch = hydrated.active_unacked_dispatches.length > 0;
      // TKT-0284: child tickets (any kind with parent_id = this id). The drawer
      // only renders the panel for specs (separation by view, not by entity),
      // but populating children is cheap and any ticket can have them. Ordered
      // by created_at so the spec's work items appear in creation order.
      const children = db.prepare(
        "SELECT id, display_id, title, body, kind, state, phase, assignee, wave FROM tickets WHERE parent_id = ? ORDER BY created_at ASC, id ASC"
      ).all(id).map((c) => ({
        ...c,
        assignee_label: resolveAssigneeLabel(c.assignee),
      }));
      return { ...hydrated, comments, links, pending_dispatch, children };
    },

    // TKT-0519: lookup by display id (e.g. GOL-42) — resolves to the canonical
    // id then returns the full ticket (with comments/links/etc.).
    getTicketByDisplayId(displayId) {
      if (!displayId) return null;
      const row = db.prepare('SELECT id FROM tickets WHERE display_id = ?').get(displayId);
      return row ? api.getTicket(row.id) : null;
    },

    // Maximum user-work recency for a project. Archived rows are excluded:
    // archive sweeps are maintenance and must not make dormant projects recent.
    // Returns 0 when the project has no tickets.
    maxTicketUpdatedAt(projectId) {
      if (!projectId) return 0;
      const row = db.prepare(
        "SELECT MAX(updated_at) AS m FROM tickets WHERE project_id = ? AND state != 'archived'"
      ).get(projectId);
      if (!row?.m) return 0;
      // updated_at is stored as ISO text; parse to ms.
      const t = Date.parse(row.m);
      return Number.isFinite(t) ? t : 0;
    },

    listTickets(filter = {}) {
      const { project_id, state, assignee, kind, exclude_kind, stream_id, parent_id, includeArchived } = filter;
      const where = [];
      const params = {};
      if (project_id != null) {
        where.push('t.project_id = @project_id');
        params.project_id = project_id;
      }
      if (state != null) {
        where.push('t.state = @state');
        params.state = state;
      }
      if (assignee != null) {
        where.push('t.assignee = @assignee');
        params.assignee = assignee;
      }
      if (kind != null) {
        where.push('t.kind = @kind');
        params.kind = kind;
      }
      // TKT-0284: cheap negative-kind filter — the Specs page is the Tracker
      // minus specs, and the Specs page is the Tracker's spec slice. Avoids a
      // separate entity / table; follows the existing WHERE pattern exactly.
      if (exclude_kind != null) {
        where.push('t.kind != @exclude_kind');
        params.exclude_kind = exclude_kind;
      }
      if (stream_id != null) {
        where.push('t.stream_id = @stream_id');
        params.stream_id = stream_id;
      }
      // TKT-0284: parent_id filter — used by the drawer's children panel and
      // any future "show children of X" view.
      if (parent_id != null) {
        where.push('t.parent_id = @parent_id');
        params.parent_id = parent_id;
      }
      // Exclude archived by default unless explicitly asking for it.
      if (state !== 'archived' && !includeArchived) {
        where.push("t.state != 'archived'");
      }
      // TKT-0266: LEFT JOIN session_labels twice (assignee + dispatched_to) so
      // the board snapshot carries durable labels in one query. Derived fields
      // — never stored on tickets; a rename retroactively improves old rows.
      const activeWarningsByTicket = new Map();
      for (const warning of activeUnackedWarnings()) {
        const arr = activeWarningsByTicket.get(warning.ticket_id) ?? [];
        arr.push(warning);
        activeWarningsByTicket.set(warning.ticket_id, arr);
      }
      const sql =
        'SELECT t.*, sa.label AS assignee_label, sd.label AS dispatched_to_label, ' +
        // TKT-0286: 0/1 flag — does this ticket have a pending dispatch-queue
        // row? Powers the board card ⏳ glyph (detail payloads already carry
        // the full pending_dispatch; this is for list/snapshot contexts).
        "EXISTS(SELECT 1 FROM dispatch_queue dq WHERE dq.ticket_id = t.id AND dq.status = 'pending') AS has_pending_dispatch " +
        'FROM tickets t ' +
        'LEFT JOIN session_labels sa ON sa.session_id = t.assignee ' +
        'LEFT JOIN session_labels sd ON sd.session_id = t.dispatched_to ' +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        ' ORDER BY t.seq ASC';
      return db.prepare(sql).all(params).map((row) => {
        const { assignee_label, dispatched_to_label, has_pending_dispatch, ...ticketFields } = row;
        const activeWarnings = activeWarningsByTicket.get(row.id) ?? [];
        return {
          ...hydrateTicket(ticketFields),
          assignee_label: assignee_label ?? null,
          dispatched_to_label: dispatched_to_label ?? null,
          has_pending_dispatch: !!has_pending_dispatch,
          has_unacked_dispatch: activeWarnings.length > 0,
          active_unacked_dispatches: activeWarnings,
        };
      });
    },

    // TKT-0284: content search across ticket title + body. LIKE-based v1;
    // contract stable for an FTS5 swap if spec volume ever warrants it.
    //
    // Params:
    //   project_id — required (cross-project search is a later iteration).
    //   kind       — optional filter (specs page passes 'spec'; the later PM
    //                iteration wants work-item search too).
    //   q          — required, ≥1 char (REST layer enforces ≥2).
    //   limit      — default 50, capped here for safety.
    //
    // Returns: { id, title, kind, state, updated_at, snippet, title_match,
    //           match_start, match_len }
    //   snippet     — first case-insensitive body match ±80 chars with leading
    //                 / trailing '…' when truncated, so the client can render
    //                 it inline. Empty when no body match.
    //   title_match — true when q appears case-insensitively in the title.
    //   match_start — offset of the match within snippet (the client uses this
    //                 to slice + wrap a <mark>). -1 when no body match.
    //   match_len   — length of the match within snippet (length of q). 0 when
    //                 no body match.
    // The snippet is computed in JS after the row fetch — fighting SQL for ±80
    // chars + offsets is more brittle than a substring slice.
    //
    // LIKE-wildcard escaping: a literal '%' or '_' in user input must NOT match
    // everything (or any-single-char). We escape '\', '%', '_' and use
    // ESCAPE '\' in the LIKE clause so the wildcard chars are literal.
    searchTickets({ project_id, kind, q, limit = 50 } = {}) {
      if (q == null || q === '') return [];
      const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
      const escaped = String(q).replace(/[\\%_]/g, (c) => '\\' + c);
      const like = `%${escaped}%`;
      const where = [];
      const params = { q: like, limit: safeLimit };
      if (project_id != null) {
        where.push('project_id = @project_id');
        params.project_id = project_id;
      }
      if (kind != null) {
        where.push('kind = @kind');
        params.kind = kind;
      }
      where.push("(title LIKE @q ESCAPE '\\' OR body LIKE @q ESCAPE '\\' OR display_id LIKE @q ESCAPE '\\')");
      const sql =
        'SELECT id, title, kind, state, phase, body, updated_at, display_id FROM tickets ' +
        'WHERE ' + where.join(' AND ') + ' ' +
        'ORDER BY updated_at DESC LIMIT @limit';
      const rows = db.prepare(sql).all(params);
      const qLower = String(q).toLowerCase();
      const pad = 80;
      return rows.map((r) => {
        const title = r.title || '';
        const body = r.body || '';
        const titleMatch = title.toLowerCase().includes(qLower);
        const bodyIdx = body.toLowerCase().indexOf(qLower);
        let snippet = '';
        let matchStart = -1;
        let matchLen = 0;
        if (bodyIdx >= 0) {
          const start = Math.max(0, bodyIdx - pad);
          const end = Math.min(body.length, bodyIdx + qLower.length + pad);
          const prefix = start > 0 ? '…' : '';
          const suffix = end < body.length ? '…' : '';
          snippet = prefix + body.slice(start, end) + suffix;
          matchStart = (start > 0 ? 1 : 0) + (bodyIdx - start);
          matchLen = qLower.length;
        }
        return {
          id: r.id,
          display_id: r.display_id,
          title,
          kind: r.kind,
          state: r.state,
          phase: r.phase,
          updated_at: r.updated_at,
          snippet,
          title_match: titleMatch,
          match_start: matchStart,
          match_len: matchLen,
        };
      });
    },

    updateTicket(id, patch = {}) {
      const existing = stmts.getTicket.get(id);
      if (!existing) throw new Error(`updateTicket: ticket '${id}' not found`);

      const actor = patch.actor ?? 'human';
      // source_ref is patchable over REST so a human can repair a wrong GitHub
      // bridge link; the MCP ticket_update whitelist omits it, so provenance is
      // not rewritable through the agent-facing tracker surface. That is a
      // guardrail against casual edits, not enforcement — anything with shell
      // access can reach this route directly.
      const ALLOWED = ['title', 'body', 'kind', 'state', 'phase', 'priority', 'labels', 'stream_id', 'parent_id', 'wave', 'assignee', 'source_ref'];
      const updates = {};
      for (const key of ALLOWED) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) {
          updates[key] = patch[key];
        }
      }
      if ('kind' in updates && !KINDS.has(updates.kind)) {
        throw new Error(`updateTicket: invalid kind '${updates.kind}'`);
      }
      if ('state' in updates && !STATES.has(updates.state)) {
        throw new Error(`updateTicket: invalid state '${updates.state}'`);
      }
      if ('labels' in updates) {
        updates.labels = serializeLabels(updates.labels);
      }
      if ('body' in updates) {
        updates.body = toMarkdownBody(updates.body);
      }
      if ('wave' in updates) {
        updates.wave = normalizeWave(updates.wave, 'updateTicket');
      }
      if ('kind' in updates || 'state' in updates || 'phase' in updates) {
        const nextKind = updates.kind ?? existing.kind;
        const nextPhase = api.normalizePhase(
          nextKind,
          updates.phase ?? phaseFromLegacyState(nextKind, updates.state ?? existing.state),
          'updateTicket'
        );
        updates.phase = nextPhase;
        updates.state = (updates.state ?? existing.state) === 'archived'
          ? 'archived'
          : canonicalStateForPhase(nextKind, nextPhase);
      }

      const ts = now();
      // TKT-0266: lifecycle stamps on state transitions (mirrors moveTicket).
      // The board PATCHes state directly (not via /move), so without these the
      // Done column's done_at-based reverse-chron sort has nothing to key off
      // and state_changed_at never advances past the v4 backfill. Only set on
      // an actual state change (not a no-op re-PATCH of the same state).
      if ('state' in updates && updates.state !== existing.state) {
        updates.state_changed_at = ts;
        if (updates.state === 'done') updates.done_at = ts;
        if (updates.state === 'archived') updates.archived_at = ts;
      }

      const txn = db.transaction(() => {
        if (Object.keys(updates).length) {
          const setClause = Object.keys(updates)
            .map((k) => `${k} = @${k}`)
            .join(', ');
          db.prepare(`UPDATE tickets SET ${setClause}, updated_at = @updated_at WHERE id = @id`).run({
            ...updates,
            updated_at: ts,
            id,
          });
        } else {
          stmts.touchTicket.run(ts, id);
        }
        if ('state' in updates && updates.state !== existing.state) {
          recordEvent({
            ticket_id: id,
            project_id: existing.project_id,
            type: 'state_change',
            actor,
            data: { from: existing.state, to: updates.state, from_phase: existing.phase, to_phase: updates.phase ?? existing.phase },
          });
          commentDispatch.markAddressedForTicketActivity(id, actor);
        } else if ('phase' in updates && updates.phase !== existing.phase) {
          recordEvent({
            ticket_id: id,
            project_id: existing.project_id,
            type: 'phase_change',
            actor,
            data: { from: existing.phase, to: updates.phase, state: updates.state ?? existing.state },
          });
          commentDispatch.markAddressedForTicketActivity(id, actor);
        }
        const terminalPhase = updates.phase ?? null;
        if (['built', 'verified', 'rejected', 'done'].includes(terminalPhase) && actor && actor !== 'human') {
          const completion = recordEvent({ ticket_id: id, project_id: existing.project_id, type: 'dispatch_completion_stamped', actor,
            data: { phase: terminalPhase } });
          db.prepare(`UPDATE message_envelopes SET completed_at = COALESCE(completed_at, @ts),
              completed_event_id = COALESCE(completed_event_id, @event_id)
            WHERE ticket_id = @ticket_id AND recipient_session_id = @actor
              AND delivery_attempted_at IS NOT NULL AND completed_at IS NULL`).run({ ts, event_id: completion.id, ticket_id: id, actor });
        }
        if ('assignee' in updates && updates.assignee !== existing.assignee) {
          recordEvent({
            ticket_id: id,
            project_id: existing.project_id,
            type: 'assigned',
            actor,
            data: { from: existing.assignee, to: updates.assignee },
          });
        }
        return stmts.getTicket.get(id);
      });
      return hydrateTicket(txn());
    },

    transitionTicket(id, input = {}) {
      const existing = stmts.getTicket.get(id);
      if (!existing) throw new Error(`transitionTicket: ticket '${id}' not found`);
      const toPhase = api.normalizePhase(existing.kind, input.phase, 'transitionTicket');
      api.validatePhaseTransition(existing, toPhase, input);
      return api.updateTicket(id, { phase: toPhase, actor: input.actor ?? 'human' });
    },

    // TKT-0105: state + rank move in a single transaction. Used by the
    // /api/tickets/:id/move endpoint (drag-and-drop, archive drop, etc.).
    //   { state, before_id?, after_id?, actor? }
    //   - state      — new state (required).
    //   - before_id  — drop position: the moved ticket is placed after this
    //                  ticket within the target state (NULL = top).
    //   - after_id   — drop position: the moved ticket is placed before this
    //                  ticket within the target state (NULL = bottom).
    //   - actor      — recorded on the audit event.
    // Rank is computed as the midpoint of the neighbour ranks; if both
    // before_id and after_id are NULL, the moved ticket gets max(rank)+1000
    // (appended to end of target state).
    moveTicket(id, { state, before_id = null, after_id = null, actor = 'human' } = {}) {
      const existing = stmts.getTicket.get(id);
      if (!existing) throw new Error(`moveTicket: ticket '${id}' not found`);
      if (!STATES.has(state)) throw new Error(`moveTicket: invalid state '${state}'`);
      const nextPhase = api.normalizePhase(existing.kind, phaseFromLegacyState(existing.kind, state), 'moveTicket');
      const nextState = state === 'archived' ? 'archived' : canonicalStateForPhase(existing.kind, nextPhase);
      const ts = now();
      const txn = db.transaction(() => {
        // Compute new rank based on neighbours within the target state.
        const beforeRank = before_id
          ? (db.prepare('SELECT rank FROM tickets WHERE id = ?').get(before_id)?.rank ?? null)
          : null;
        const afterRank = after_id
          ? (db.prepare('SELECT rank FROM tickets WHERE id = ?').get(after_id)?.rank ?? null)
          : null;
        let newRank;
        if (before_id && after_id && beforeRank !== null && afterRank !== null) {
          newRank = (beforeRank + afterRank) / 2;
        } else if (beforeRank !== null && afterRank !== null) {
          newRank = (beforeRank + afterRank) / 2;
        } else if (beforeRank !== null) {
          newRank = beforeRank + 500;
        } else if (afterRank !== null) {
          newRank = afterRank - 500;
        } else {
          // Append to end of target state.
          const maxRow = db.prepare(
            "SELECT MAX(rank) AS m FROM tickets WHERE state = ? AND id != ?"
          ).get(nextState, id);
          newRank = (maxRow?.m ?? 0) + 1000;
        }
        // Build the SET clause: state + rank + lifecycle stamps.
        const setDoneAt = state === 'done' ? ', done_at = @ts' : '';
        const setArchivedAt = state === 'archived' ? ', archived_at = @ts' : '';
        db.prepare(`UPDATE tickets SET
          state = @state,
          phase = @phase,
          rank = @rank,
          state_changed_at = @ts,
          updated_at = @ts
          ${setDoneAt}
          ${setArchivedAt}
        WHERE id = @id`).run({ state: nextState, phase: nextPhase, rank: newRank, ts, id });
        // Audit event for the state change. Rank-only moves within the
        // same state still record an event for traceability.
        if (nextState !== existing.state || nextPhase !== existing.phase) {
          recordEvent({
            ticket_id: id,
            project_id: existing.project_id,
            type: 'state_change',
            actor,
            data: { from: existing.state, to: nextState, from_phase: existing.phase, to_phase: nextPhase, before_id, after_id, new_rank: newRank },
          });
          commentDispatch.markAddressedForTicketActivity(id, actor);
        } else {
          recordEvent({
            ticket_id: id,
            project_id: existing.project_id,
            type: 'rank_change',
            actor,
            data: { before_id, after_id, new_rank: newRank },
          });
        }
        return stmts.getTicket.get(id);
      });
      return hydrateTicket(txn());
    },

    // TKT-0105: 14-day done → archived sweep. Returns the list of ids
    // that were auto-archived so the caller can broadcast a single
    // batch-updated WS delta instead of one per ticket.
    autoArchiveDone(nowTs = now(), olderThanDays = 14) {
      const cutoff = new Date(Date.parse(nowTs) - olderThanDays * 86400_000).toISOString();
      const txn = db.transaction(() => {
        const rows = db.prepare(
          "SELECT id FROM tickets WHERE state = 'done' AND done_at IS NOT NULL AND done_at < ?"
        ).all(cutoff);
        if (rows.length === 0) return [];
        const ts = now();
        const update = db.prepare(
          "UPDATE tickets SET state = 'archived', archived_at = @ts, state_changed_at = @ts, updated_at = @ts WHERE id = @id"
        );
        const updated = [];
        for (const { id } of rows) {
          const t = stmts.getTicket.get(id);
          if (!t) continue;
          update.run({ id, ts });
          recordEvent({
            ticket_id: id,
            project_id: t.project_id,
            type: 'auto_archived',
            actor: 'system',
            data: { from: 'done', to: 'archived', done_at: t.done_at },
          });
          updated.push(id);
        }
        return updated;
      });
      return txn();
    },

    setDispatched(id, { session_id, actor = 'human' } = {}) {
      const existing = stmts.getTicket.get(id);
      if (!existing) throw new Error(`setDispatched: ticket '${id}' not found`);
      if (!session_id) throw new Error('setDispatched: session_id is required');
      const ts = now();
      const txn = db.transaction(() => {
        // A redispatch cannot leave an earlier envelope/queue actionable.
        // Legacy queue rows without an envelope_id remain untouched/visible.
        stmts.supersedeOpenEnvelopes.run({ ticket_id: id, recipient_session_id: session_id, ts });
        db.prepare("UPDATE dispatch_queue SET status = 'cancelled', resolved_at = @ts WHERE ticket_id = @id AND status = 'pending' AND envelope_id IS NOT NULL").run({ id, ts });
        const previous = existing.dispatched_to && existing.dispatched_to !== session_id ? existing.dispatched_to : null;
        if (previous) {
          recordEvent({
            ticket_id: id,
            project_id: existing.project_id,
            type: 'dispatch_revoked',
            actor,
            data: { previous_session_id: previous, next_session_id: session_id, reason: 'redispatched' },
          });
        }
        db.prepare(
          'UPDATE tickets SET assignee = @s, dispatched_to = @s, dispatched_at = @ts, updated_at = @ts WHERE id = @id',
        ).run({ s: session_id, ts, id });
        const updated = stmts.getTicket.get(id);
        recordEvent({
          ticket_id: id,
          project_id: existing.project_id,
          type: 'dispatched',
          actor,
          data: { from: existing.assignee ?? existing.dispatched_to ?? null, to: session_id, session_id },
        });
        return { row: updated, revoked_session_id: previous };
      });
      const result = txn();
      const ticket = hydrateTicket(result.row);
      if (result.revoked_session_id) ticket.revoked_session_id = result.revoked_session_id;
      return ticket;
    },

    // TKT-0245: asynchronous dispatch queue. The queue lives in SQLite so it
    // survives dashboard restarts (routine). A pending row asserts ownership
    // intent (assignee flips immediately) but does NOT set dispatched_to /
    // dispatched_at — those land when the drainer actually delivers the brief
    // on idle. Re-queue = replace (the unique partial index enforces one
    // pending row per ticket).
    queueDispatch(ticketId, { session_id, note = null, workspace = null, payload = '', envelope_id = null, actor = 'human' } = {}) {
      const existing = stmts.getTicket.get(ticketId);
      if (!existing) throw new Error(`queueDispatch: ticket '${ticketId}' not found`);
      if (!session_id) throw new Error('queueDispatch: session_id is required');
      const ts = now();
      const queueId = crypto.randomUUID();
      const envelopeId = envelope_id || crypto.randomUUID();
      const txn = db.transaction(() => {
        // Re-queue = replace: cancel any existing pending row for this ticket
        // (no separate event — the dispatch_queued event captures the action).
        stmts.cancelPendingForTicket.run({ resolved_at: ts, ticket_id: ticketId });
        // Ownership intent immediate; dispatched_to/dispatched_at stay null
        // until the drainer delivers on idle.
        stmts.setTicketAssignee.run({ assignee: session_id, updated_at: ts, id: ticketId });
        stmts.insertDispatchQueue.run({
          id: queueId,
          ticket_id: ticketId,
          project_id: existing.project_id,
          session_id,
          note: note ?? null,
          workspace: workspace ?? null,
          envelope_id: envelopeId,
          created_at: ts,
        });
        if (!envelope_id) stmts.insertEnvelope.run({
          id: envelopeId,
          root_id: envelopeId,
          parent_id: null,
          ticket_id: ticketId,
          project_id: existing.project_id,
          sender_id: actor === 'human' ? null : actor,
          reply_to_session_id: actor === 'human' ? null : actor,
          recipient_session_id: session_id,
          sender_session_id: actor === 'human' ? null : actor,
          target_session_id: session_id,
          kind: 'ticket_dispatch',
          payload: JSON.stringify({ content: String(payload || '') }),
          status: 'queued',
          ack_deadline_at: null,
          created_at: ts,
          expires_at: expiresAt(ts),
        });
        recordEvent({
          ticket_id: ticketId,
          project_id: existing.project_id,
          type: 'dispatch_queued',
          actor,
          data: { from: existing.assignee ?? null, to: session_id, session_id, queue_id: queueId, envelope_id: envelopeId },
        });
        return { ...stmts.getQueueRow.get(queueId), envelope: stmts.getEnvelope.get(envelopeId) };
      });
      return txn();
    },

    createDispatchEnvelope(ticketId, { session_id, payload = '', actor = 'human', sender_id = null } = {}) {
      const ticket = stmts.getTicket.get(ticketId);
      if (!ticket) throw new Error(`createDispatchEnvelope: ticket '${ticketId}' not found`);
      if (!session_id) throw new Error('createDispatchEnvelope: session_id is required');
      const sender = sender_id || (actor === 'human' ? null : actor);
      const created_at = now();
      const row = {
        id: crypto.randomUUID(),
        root_id: null,
        parent_id: null,
        ticket_id: ticketId,
        project_id: ticket.project_id,
        sender_id: sender,
        reply_to_session_id: sender,
        recipient_session_id: session_id,
        sender_session_id: sender,
        target_session_id: session_id,
        kind: 'ticket_dispatch',
        payload: JSON.stringify({ content: String(payload || '') }),
        status: 'pending',
        ack_deadline_at: null,
        created_at,
        expires_at: expiresAt(created_at),
      };
      row.root_id = row.id;
      stmts.insertEnvelope.run(row);
      return stmts.getEnvelope.get(row.id);
    },

    setEnvelopePayload(envelopeId, payload) {
      const existing = stmts.getEnvelope.get(envelopeId);
      if (!existing) throw new Error(`setEnvelopePayload: envelope '${envelopeId}' not found`);
      const info = stmts.setEnvelopePayload.run({ id: envelopeId, payload: JSON.stringify(payload) });
      if (!info.changes) throw new Error(`setEnvelopePayload: envelope '${envelopeId}' is no longer renderable`);
      return stmts.getEnvelope.get(envelopeId);
    },

    getEnvelope(envelopeId) {
      return stmts.getEnvelope.get(envelopeId) ?? null;
    },

    // Read-only handoff-health surface. The endpoint layer resolves user-facing
    // ticket ids; this layer deliberately accepts canonical ids only.
    listEnvelopeViews,

    getEnvelopeView(envelopeId) {
      const envelope = stmts.getEnvelope.get(envelopeId);
      if (!envelope) return null;
      const rootId = envelope.root_id || envelope.id;
      const root = stmts.getEnvelope.get(rootId);
      if (!root || root.kind !== 'ticket_dispatch') return null;
      const row = envelopeRootRows({ envelope_id: root.id, limit: 1 })[0];
      return row ? envelopeView(row) : null;
    },

    communicationHealth,

    // Non-ticket control messages use the same immutable envelope identity as a
    // dispatch. This is especially important for managed Codex: its typed
    // adapter accepts only an envelope and never a free-form channel route.
    // Keep the allowed vocabulary narrow so this table does not become a
    // generic, unaudited message bus.
    createControlEnvelope({ project_id = null, sender_id, recipient_session_id, kind = 'session_notify', payload = '' } = {}) {
      const allowedKinds = new Set([
        'session_notify',
        'consult_request',
        'consult_reply',
        'consult_status',
        'subscription_digest',
        'gate_resolution',
        'role_assign',
      ]);
      if (!sender_id || !recipient_session_id) throw new Error('createControlEnvelope: sender and recipient are required');
      if (!allowedKinds.has(kind)) throw new Error(`createControlEnvelope: unsupported control kind '${kind}'`);
      const body = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? { ...payload, content: String(payload.content ?? '') }
        : { content: String(payload) };
      const created_at = now();
      const row = { id: crypto.randomUUID(), root_id: null, parent_id: null, ticket_id: null, project_id,
        sender_id, reply_to_session_id: sender_id, recipient_session_id, sender_session_id: sender_id,
        target_session_id: recipient_session_id, kind, payload: JSON.stringify(body),
        status: 'pending', ack_deadline_at: null, created_at, expires_at: expiresAt(created_at) };
      row.root_id = row.id;
      stmts.insertEnvelope.run(row);
      return stmts.getEnvelope.get(row.id);
    },

    createNotificationEnvelope({ project_id = null, sender_id, recipient_session_id, payload = '' } = {}) {
      if (!sender_id || !recipient_session_id) throw new Error('createNotificationEnvelope: sender and recipient are required');
      const body = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? { ...payload, content: String(payload.content ?? '') }
        : { content: String(payload) };
      const created_at = now();
      const row = { id: crypto.randomUUID(), root_id: null, parent_id: null, ticket_id: null, project_id,
        sender_id, reply_to_session_id: sender_id, recipient_session_id, sender_session_id: sender_id,
        target_session_id: recipient_session_id, kind: 'session_notify', payload: JSON.stringify(body),
        status: 'pending', ack_deadline_at: null, created_at, expires_at: expiresAt(created_at) };
      row.root_id = row.id;
      stmts.insertEnvelope.run(row);
      return stmts.getEnvelope.get(row.id);
    },

    // The shared typed-endpoint protocol deliberately stores lifecycle beside
    // the legacy transport status. This is the source of truth for replay
    // safety: a claimed-but-unaccepted attempt may return to pending; an
    // accepted interruption/recovery-required outcome can never be claimed
    // again automatically.
    recordTypedEnvelopeLifecycle(envelopeId, { state, attempt_id = null, accepted_attempt_id = null, error = null } = {}) {
      const allowed = new Set(['pending', 'claimed', 'accepted', 'settled', 'interrupted', 'recovery_required']);
      if (!allowed.has(state)) throw new Error(`recordTypedEnvelopeLifecycle: unsupported state '${state}'`);
      const existing = stmts.getEnvelope.get(envelopeId);
      if (!existing) throw new Error(`recordTypedEnvelopeLifecycle: envelope '${envelopeId}' not found`);
      const prior = existing.delivery_state || 'pending';
      if (prior === state
        && (attempt_id == null || attempt_id === existing.delivery_attempt_id)
        && (accepted_attempt_id == null || accepted_attempt_id === existing.accepted_attempt_id)) return existing;
      const transitions = {
        pending: new Set(['claimed']),
        published: new Set(['claimed']),
        claimed: new Set(['pending', 'accepted', 'recovery_required']),
        accepted: new Set(['settled', 'interrupted', 'recovery_required']),
        settled: new Set(),
        interrupted: new Set(),
        recovery_required: new Set(),
      };
      if (prior !== state && !transitions[prior]?.has(state)) {
        throw new Error(`recordTypedEnvelopeLifecycle: illegal transition ${prior} -> ${state}`);
      }
      const ts = now();
      const minutes = Math.max(0, Number(loadConfig()?.dispatch?.unackedWindowMinutes) || 5);
      const deadline = new Date(Date.parse(ts) + minutes * 60_000).toISOString();
      const firstAcceptedAttempt = accepted_attempt_id
        ?? (['accepted', 'settled', 'interrupted', 'recovery_required'].includes(state) ? attempt_id : null);
      const status = state === 'pending'
        ? 'delivery_failed'
        : state === 'claimed'
          ? existing.status
          : 'delivered';
      const txn = db.transaction(() => {
        stmts.updateTypedEnvelopeLifecycle.run({
          id: envelopeId,
          status,
          delivery_state: state,
          delivery_attempt_id: attempt_id,
          accepted_attempt_id: firstAcceptedAttempt,
          delivery_attempted_at: ts,
          delivery_error: error ?? null,
          ack_deadline_at: deadline,
        });
        const updated = stmts.getEnvelope.get(envelopeId);
        recordEvent({
          ticket_id: existing.ticket_id,
          project_id: existing.project_id,
          type: `dispatch_delivery_${state}`,
          actor: 'golem-typed-endpoint',
          data: {
            envelope_id: envelopeId,
            target_session_id: existing.target_session_id,
            attempt_id: attempt_id ?? existing.delivery_attempt_id ?? null,
            accepted_attempt_id: firstAcceptedAttempt ?? existing.accepted_attempt_id ?? null,
            error: error ?? null,
          },
        });
        return updated;
      });
      return txn();
    },

    // Busy and wave-held work can legitimately outlive the original TTL. A
    // typed endpoint still validates expiry strictly, so renew only the durable
    // pending envelope immediately before a new publish attempt and render that
    // same persisted expiry into the protocol metadata.
    renewEnvelopeExpiry(envelopeId, { minimumValidityMs = MESSAGE_ENVELOPE_TTL_MS } = {}) {
      const existing = stmts.getEnvelope.get(envelopeId);
      if (!existing) throw new Error(`renewEnvelopeExpiry: envelope '${envelopeId}' not found`);
      const ms = Math.max(0, Number(minimumValidityMs) || MESSAGE_ENVELOPE_TTL_MS);
      const floor = Date.now() + ms;
      const prior = Date.parse(existing.expires_at || '') || 0;
      const expires_at = new Date(Math.max(prior, floor)).toISOString();
      stmts.renewEnvelopeExpiry.run({ id: envelopeId, expires_at });
      return stmts.getEnvelope.get(envelopeId);
    },

    // A schema-2/3 worker may safely fence a pre-upgrade pending envelope: it
    // cannot prove whether a forgotten old identity ever ran. Rotate only that
    // unaccepted tracker row in one transaction, keep its root/parent lineage
    // and queue ownership, and let the next typed attempt carry a post-fence
    // envelope id + created_at. Accepted/recovery rows are never eligible.
    rotatePendingEnvelope(envelopeId, { actor = 'golem-drainer', reason = 'legacy typed replay fence' } = {}) {
      const ts = now();
      const nextId = crypto.randomUUID();
      const txn = db.transaction(() => {
        // Re-read and validate inside the ownership transaction. A concurrent
        // accepted result must win rather than being rotated underneath it.
        const existing = stmts.getEnvelope.get(envelopeId);
        if (!existing) throw new Error(`rotatePendingEnvelope: envelope '${envelopeId}' not found`);
        if (existing.delivery_state !== 'pending' || !['queued', 'pending', 'delivery_failed'].includes(existing.status)) {
          throw new Error(`rotatePendingEnvelope: envelope '${envelopeId}' is not an unaccepted pending lineage`);
        }
        const queueRows = db.prepare(`SELECT id FROM dispatch_queue WHERE envelope_id = ?
          AND status IN ('pending', 'publishing')`).all(envelopeId);
        if (!queueRows.length) throw new Error(`rotatePendingEnvelope: no actionable queue row for '${envelopeId}'`);
        const replacement = {
          id: nextId,
          root_id: existing.root_id || existing.id,
          parent_id: existing.id,
          ticket_id: existing.ticket_id,
          project_id: existing.project_id,
          sender_id: existing.sender_id,
          reply_to_session_id: existing.reply_to_session_id,
          recipient_session_id: existing.recipient_session_id,
          sender_session_id: existing.sender_session_id,
          target_session_id: existing.target_session_id,
          kind: existing.kind,
          payload: existing.payload,
          status: 'queued',
          ack_deadline_at: null,
          created_at: ts,
          expires_at: expiresAt(ts),
        };
        stmts.insertEnvelope.run(replacement);
        db.prepare(`UPDATE message_envelopes
          SET status = 'superseded', completed_at = ?, delivery_error = ?, last_error = ?
          WHERE id = ? AND delivery_state = 'pending'
            AND status IN ('queued', 'pending', 'delivery_failed')`).run(ts, reason, reason, envelopeId);
        const updated = db.prepare(`UPDATE dispatch_queue SET envelope_id = ?
          WHERE envelope_id = ? AND status IN ('pending', 'publishing')`).run(nextId, envelopeId);
        if (updated.changes !== queueRows.length) throw new Error(`rotatePendingEnvelope: queue ownership changed for '${envelopeId}'`);
        recordEvent({
          ticket_id: existing.ticket_id,
          project_id: existing.project_id,
          type: 'dispatch_envelope_reissued',
          actor,
          data: {
            prior_envelope_id: envelopeId,
            envelope_id: nextId,
            root_id: replacement.root_id,
            target_session_id: existing.target_session_id,
            reason,
          },
        });
        return stmts.getEnvelope.get(nextId);
      });
      return txn();
    },

    markEnvelopeDelivery(envelopeId, { error = null } = {}) {
      const existing = stmts.getEnvelope.get(envelopeId);
      if (!existing) throw new Error(`markEnvelopeDelivery: envelope '${envelopeId}' not found`);
      const ts = now();
      const minutes = Math.max(0, Number(loadConfig()?.dispatch?.unackedWindowMinutes) || 5);
      const deadline = new Date(Date.parse(ts) + minutes * 60_000).toISOString();
      return db.transaction(() => {
        stmts.markEnvelopeDelivery.run({ id: envelopeId, delivered_at: ts, ack_deadline_at: deadline, error: error ?? null });
        if (existing.kind === 'ack_ping') {
          db.prepare(`UPDATE message_envelopes SET escalate_after = ? WHERE id = ?
            AND ping_envelope_id = ? AND escalation_envelope_id IS NULL AND acknowledged_at IS NULL`)
            .run(error == null ? deadline : ts, existing.root_id || existing.parent_id, envelopeId);
        }
        return stmts.getEnvelope.get(envelopeId);
      })();
    },

    resolveEnvelope(envelopeId, { status, error = null } = {}) {
      if (!['cancelled', 'expired'].includes(status)) throw new Error('resolveEnvelope: status must be cancelled or expired');
      const existing = stmts.getEnvelope.get(envelopeId);
      if (!existing) throw new Error(`resolveEnvelope: envelope '${envelopeId}' not found`);
      stmts.resolveEnvelope.run({ id: envelopeId, status, ts: now(), last_error: error ?? null });
      return stmts.getEnvelope.get(envelopeId);
    },

    acknowledgeEnvelope(envelopeId, { target_session_id, kind = 'brief', summary = '' } = {}) {
      const existing = stmts.getEnvelope.get(envelopeId);
      if (!existing) throw new Error(`acknowledgeEnvelope: envelope '${envelopeId}' not found`);
      if (!target_session_id || existing.recipient_session_id !== target_session_id) throw new Error('acknowledgeEnvelope: target session does not match envelope');
      const ts = now();
      return db.transaction(() => {
        const fact = stmts.insertEnvelopeFact.run({ envelope_id: envelopeId, recipient_session_id: target_session_id, kind, summary: String(summary), acknowledged_at: ts });
        if (fact.changes) stmts.acknowledgeEnvelope.run({ id: envelopeId, target_session_id, ts });
        if (fact.changes && existing.kind === 'ack_ping') {
          const rootId = existing.root_id || existing.parent_id;
          const root = stmts.getEnvelope.get(rootId);
          if (root && root.recipient_session_id === target_session_id) {
            stmts.insertEnvelopeFact.run({ envelope_id: rootId, recipient_session_id: target_session_id, kind: 'ack_via_ping', summary: String(summary), acknowledged_at: ts });
            stmts.acknowledgeEnvelope.run({ id: rootId, target_session_id, ts });
            db.prepare('UPDATE message_envelopes SET ack_via_envelope_id = ? WHERE id = ?').run(envelopeId, rootId);
          }
        }
        if (fact.changes) recordEvent({ ticket_id: existing.ticket_id, project_id: existing.project_id, type: 'dispatch_acknowledged', actor: target_session_id, data: { envelope_id: envelopeId, kind, summary } });
        return stmts.getEnvelope.get(envelopeId);
      })();
    },

    replyEnvelope(envelopeId, { target_session_id, kind = 'brief', text = '' } = {}) {
      const existing = stmts.getEnvelope.get(envelopeId);
      if (!existing) throw new Error(`replyEnvelope: envelope '${envelopeId}' not found`);
      if (!target_session_id || existing.recipient_session_id !== target_session_id) throw new Error('replyEnvelope: target session does not match envelope');
      const ts = now();
      const child = { id: crypto.randomUUID(), root_id: existing.root_id || existing.id, parent_id: existing.id,
        ticket_id: existing.ticket_id, project_id: existing.project_id, sender_id: target_session_id,
        reply_to_session_id: target_session_id, recipient_session_id: existing.reply_to_session_id,
        sender_session_id: target_session_id, target_session_id: existing.reply_to_session_id,
        kind: 'reply', payload: JSON.stringify({ text: String(text), kind }), status: 'pending', ack_deadline_at: null, created_at: ts, expires_at: expiresAt(ts) };
      if (!child.recipient_session_id) throw new Error('replyEnvelope: envelope has no reply route');
      stmts.insertEnvelope.run(child);
      stmts.replyEnvelope.run({ id: envelopeId, target_session_id, reply_envelope_id: child.id, ts });
      recordEvent({ ticket_id: existing.ticket_id, project_id: existing.project_id, type: 'dispatch_replied', actor: target_session_id, data: { envelope_id: envelopeId, reply_envelope_id: child.id, kind, text } });
      return { envelope: stmts.getEnvelope.get(envelopeId), reply: stmts.getEnvelope.get(child.id) };
    },

    cancelQueuedDispatch(queueId, { actor = 'human' } = {}) {
      const row = stmts.getQueueRow.get(queueId);
      if (!row) throw new Error(`cancelQueuedDispatch: queue row '${queueId}' not found`);
      if (row.status !== 'pending') {
        throw new Error(`cancelQueuedDispatch: queue row '${queueId}' is not pending (status=${row.status})`);
      }
      const ts = now();
      const txn = db.transaction(() => {
        stmts.cancelQueueRow.run({ resolved_at: ts, id: queueId });
        if (row.envelope_id) stmts.resolveEnvelope.run({ id: row.envelope_id, status: 'cancelled', ts, last_error: null });
        recordEvent({
          ticket_id: row.ticket_id,
          project_id: row.project_id,
          type: 'dispatch_cancelled',
          actor,
          data: { queue_id: queueId, session_id: row.session_id },
        });
        recordEvent({
          ticket_id: row.ticket_id,
          project_id: row.project_id,
          type: 'dispatch_revoked',
          actor,
          data: { queue_id: queueId, previous_session_id: row.session_id, reason: 'queue_cancelled' },
        });
        return stmts.getQueueRow.get(queueId);
      });
      return txn();
    },

    // Used by the drainer when a session stays offline too long. Idempotent on
    // a non-pending row (returns the row unchanged) so a concurrent cancel /
    // deliver doesn't throw.
    expireQueuedDispatch(queueId, reason) {
      const row = stmts.getQueueRow.get(queueId);
      if (!row) throw new Error(`expireQueuedDispatch: queue row '${queueId}' not found`);
      if (row.status !== 'pending') return row;
      const ts = now();
      const txn = db.transaction(() => {
        stmts.expireQueueRow.run({ last_error: reason ?? null, resolved_at: ts, id: queueId });
        if (row.envelope_id) stmts.resolveEnvelope.run({ id: row.envelope_id, status: 'expired', ts, last_error: reason ?? null });
        recordEvent({
          ticket_id: row.ticket_id,
          project_id: row.project_id,
          type: 'dispatch_expired',
          actor: 'system',
          data: { queue_id: queueId, session_id: row.session_id, reason },
        });
        return stmts.getQueueRow.get(queueId);
      });
      return txn();
    },

    // Used by the drainer after a delivery attempt. Idempotent on a non-pending
    // row (a concurrent cancel must not throw here).
    markQueueDelivered(queueId, { error = null, envelope_id = null, ownerToken = null } = {}) {
      const row = stmts.getQueueRow.get(queueId);
      if (!row) throw new Error(`markQueueDelivered: queue row '${queueId}' not found`);
      if (!['pending', 'next_turn', 'publishing'].includes(row.status)) return row;
      if (row.status === 'publishing' && (!ownerToken || row.publishing_owner !== ownerToken)) return row;
      const ts = now();
      const txn = db.transaction(() => {
        stmts.markQueueDeliveredRow.run({
          delivered_at: ts, last_error: error ?? null, resolved_at: ts, id: queueId, owner: ownerToken,
        });
        recordEvent({
          ticket_id: row.ticket_id,
          project_id: row.project_id,
          type: 'dispatch_delivery_attempted',
          actor: 'golem-drainer',
          data: { queue_id: queueId, session_id: row.session_id, delivered_at: ts, error: error ?? null, envelope_id: envelope_id ?? null },
        });
        return stmts.getQueueRow.get(queueId);
      });
      return txn();
    },

    markQueueNextTurn(queueId, { ownerToken } = {}) {
      const row = stmts.getQueueRow.get(queueId);
      if (!row) throw new Error(`markQueueNextTurn: queue row '${queueId}' not found`);
      if (!ownerToken) throw new Error('markQueueNextTurn: ownerToken is required');
      stmts.markQueueNextTurnRow.run({ id: queueId, owner: ownerToken });
      return stmts.getQueueRow.get(queueId);
    },

    claimQueuePublishing(queueId, { ownerToken, leaseMs = 30_000, nowMs = Date.now() } = {}) {
      if (!ownerToken) throw new Error('claimQueuePublishing: ownerToken is required');
      const result = stmts.claimQueuePublishingRow.run({ id: queueId, owner: ownerToken, now: new Date(nowMs).toISOString(), expires: new Date(nowMs + leaseMs).toISOString() });
      return result.changes === 1;
    },

    releaseQueuePublishing(queueId, { ownerToken } = {}) {
      if (!ownerToken) throw new Error('releaseQueuePublishing: ownerToken is required');
      return stmts.releaseQueuePublishingRow.run({ id: queueId, owner: ownerToken }).changes === 1;
    },

    markDispatchDeliveryAttempted(ticketId, { session_id, actor = 'human', error = null, envelope_id = null } = {}) {
      const ticket = stmts.getTicket.get(ticketId);
      if (!ticket) throw new Error(`markDispatchDeliveryAttempted: ticket '${ticketId}' not found`);
      if (!session_id) throw new Error('markDispatchDeliveryAttempted: session_id is required');
      const ts = now();
      return recordEvent({
        ticket_id: ticketId,
        project_id: ticket.project_id,
        type: 'dispatch_delivery_attempted',
        actor,
        data: { session_id, delivered_at: ts, error: error ?? null, envelope_id: envelope_id ?? null },
      });
    },

    listPendingDispatches() {
      return stmts.listPendingDispatches.all();
    },

    waveGateForTicket(ticketId) {
      const ticket = stmts.getTicket.get(ticketId);
      if (!ticket) return { blocked: false, missing: true };
      if (!ticket.parent_id || ticket.wave == null) {
        return { blocked: false, ticket_id: ticket.id, parent_id: ticket.parent_id ?? null, wave: ticket.wave ?? null, min_open_wave: null };
      }
      const row = db.prepare(`
        SELECT MIN(wave) AS min_open_wave
        FROM tickets
        WHERE parent_id = ?
          AND wave IS NOT NULL
          AND state NOT IN ('done', 'archived')
      `).get(ticket.parent_id);
      const minOpenWave = row?.min_open_wave ?? null;
      return {
        blocked: minOpenWave != null && ticket.wave > minOpenWave,
        ticket_id: ticket.id,
        parent_id: ticket.parent_id,
        wave: ticket.wave,
        min_open_wave: minOpenWave,
      };
    },

    listPendingDispatchesForSession(sessionId) {
      // TKT-0286: thin wrapper over the enriched listDispatchQueue so 0245's
      // REST (?session_id=) keeps working — rows now also carry ticket_title
      // + session_label (0245's consumer only reads .id, so enrichment is a
      // backward-compatible addition). No-arg still returns all pending.
      return api.listDispatchQueue({ session_id: sessionId ?? null });
    },

    // TKT-0286: generalized, enriched dispatch-queue list. Powers the Agents
    // page (all pending across projects), the session peek drawer (one
    // session), and the offline-orphans section. Rows carry ticket_title
    // (LEFT JOIN tickets, null-safe) + session_label (LEFT JOIN session_labels
    // from 0266, null-safe) so consumers render friendly names without a
    // second round-trip. Default status='pending'; pass status=null for all
    // statuses (history). FIFO by created_at (matches the drainer's delivery
    // order within a session).
    listDispatchQueue({ session_id, project_id, status = 'pending' } = {}) {
      const where = [];
      const params = {};
      if (status != null) { where.push('dq.status = @status'); params.status = status; }
      if (session_id != null) { where.push('dq.session_id = @session_id'); params.session_id = session_id; }
      if (project_id != null) { where.push('dq.project_id = @project_id'); params.project_id = project_id; }
      const sql =
        'SELECT dq.*, t.title AS ticket_title, sl.label AS session_label ' +
        'FROM dispatch_queue dq ' +
        'LEFT JOIN tickets t ON t.id = dq.ticket_id ' +
        'LEFT JOIN session_labels sl ON sl.session_id = dq.session_id ' +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        ' ORDER BY dq.created_at ASC, dq.id ASC';
      return db.prepare(sql).all(params);
    },

    getPendingDispatchForTicket(ticketId) {
      return stmts.getPendingForTicket.get(ticketId) ?? null;
    },

    countPendingDispatchesForSession(sessionId) {
      return Number(stmts.countPendingForSession.get(sessionId)?.n ?? 0);
    },

    countPendingDispatchesBySession() {
      const out = new Map();
      for (const r of stmts.countPendingBySession.all()) out.set(r.session_id, Number(r.n ?? 0));
      return out;
    },

    currentInProgressTicketForSession(sessionId) {
      if (!sessionId) return null;
      return stmts.currentInProgressForSession.get(sessionId, sessionId) ?? null;
    },

    unackedDispatchesForWindow(windowMinutes = 10) {
      const rawMinutes = Number(windowMinutes);
      const minutes = Math.max(0, Number.isFinite(rawMinutes) ? rawMinutes : 10);
      const cutoff = new Date(Date.now() - minutes * 60_000).toISOString();
      const candidates = db.prepare(`
        SELECT e.id AS delivery_event_id, e.ticket_id, e.project_id, e.created_at AS delivered_at,
               json_extract(e.data, '$.session_id') AS session_id,
               t.display_id, t.title
        FROM events e
        JOIN tickets t ON t.id = e.ticket_id
        WHERE e.type = 'dispatch_delivery_attempted'
          AND json_extract(e.data, '$.envelope_id') IS NULL
          AND e.created_at <= @cutoff
          AND json_extract(e.data, '$.session_id') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM events w
            WHERE w.ticket_id = e.ticket_id
              AND w.type = 'dispatch_unacked_warning'
              AND json_extract(w.data, '$.delivery_event_id') = e.id
          )
        ORDER BY e.created_at ASC
      `).all({ cutoff });
      return candidates.filter((row) => !unackedWarningResolved(row));
    },

    // GOL-422 claims use conditional root updates inside SQLite transactions:
    // concurrent/restarted drainers can observe a due root, but only one creates
    // its child. Neither transaction touches ticket ownership fields or queue.
    claimDueAckPing(windowMinutes = 5) {
      const ts = now();
      const txn = db.transaction(() => {
        const root = db.prepare(`SELECT * FROM message_envelopes
          WHERE kind = 'ticket_dispatch' AND delivery_opportunity_at IS NOT NULL
            AND ack_deadline_at <= ? AND acknowledged_at IS NULL AND completed_at IS NULL
            AND ping_envelope_id IS NULL ORDER BY ack_deadline_at ASC LIMIT 1`).get(ts);
        if (!root) return null;
        const childId = crypto.randomUUID();
        const claimed = db.prepare(`UPDATE message_envelopes SET ping_envelope_id = ?
          WHERE id = ? AND ping_envelope_id IS NULL AND acknowledged_at IS NULL AND completed_at IS NULL`).run(childId, root.id);
        if (!claimed.changes) return null;
        const ageMinutes = Math.max(0, Math.floor((Date.parse(ts) - Date.parse(root.delivery_opportunity_at)) / 60_000));
        const child = { id: childId, root_id: root.id, parent_id: root.id, ticket_id: root.ticket_id, project_id: root.project_id,
          sender_id: root.sender_id, reply_to_session_id: root.reply_to_session_id, recipient_session_id: root.recipient_session_id,
          sender_session_id: root.sender_session_id, target_session_id: root.target_session_id, kind: 'ack_ping',
          payload: JSON.stringify({ content: `Acknowledgement reminder for dispatch ${root.id}\n\nTicket: ${root.ticket_id}\nDispatch age: ${ageMinutes}m\nPlease acknowledge the original dispatch by acknowledging this ping message_id: ${childId}.` }),
          status: 'pending', ack_deadline_at: null, created_at: ts, expires_at: expiresAt(ts) };
        stmts.insertEnvelope.run(child);
        return { root: stmts.getEnvelope.get(root.id), envelope: stmts.getEnvelope.get(childId) };
      });
      return txn();
    },

    claimDueEscalation() {
      const ts = now();
      const txn = db.transaction(() => {
        const root = db.prepare(`SELECT * FROM message_envelopes
          WHERE kind = 'ticket_dispatch' AND ping_envelope_id IS NOT NULL AND escalate_after IS NOT NULL
            AND escalate_after <= ? AND acknowledged_at IS NULL AND completed_at IS NULL
            AND escalation_envelope_id IS NULL ORDER BY escalate_after ASC LIMIT 1`).get(ts);
        if (!root) return null;
        const childId = crypto.randomUUID();
        const claimed = db.prepare(`UPDATE message_envelopes SET escalation_envelope_id = ?
          WHERE id = ? AND escalation_envelope_id IS NULL AND acknowledged_at IS NULL AND completed_at IS NULL`).run(childId, root.id);
        if (!claimed.changes) return null;
        const child = { id: childId, root_id: root.id, parent_id: root.id, ticket_id: root.ticket_id, project_id: root.project_id,
          sender_id: root.sender_id, reply_to_session_id: root.reply_to_session_id, recipient_session_id: root.reply_to_session_id,
          sender_session_id: root.sender_session_id, target_session_id: root.reply_to_session_id, kind: 'escalation',
          payload: JSON.stringify({ content: `Dispatch escalation for ${root.ticket_id}\n\nOriginal message_id: ${root.id}\nPing message_id: ${root.ping_envelope_id}\nNo acknowledgement after delivery and one reminder.` }),
          status: 'pending', ack_deadline_at: null, created_at: ts, expires_at: expiresAt(ts) };
        stmts.insertEnvelope.run(child);
        return { root: stmts.getEnvelope.get(root.id), envelope: stmts.getEnvelope.get(childId) };
      });
      return txn();
    },

    recordUnackedDispatchWarning(row, { actor = 'system', windowMinutes = null } = {}) {
      return recordEvent({
        ticket_id: row.ticket_id,
        project_id: row.project_id,
        type: 'dispatch_unacked_warning',
        actor,
        data: {
          delivery_event_id: row.delivery_event_id,
          session_id: row.session_id,
          delivered_at: row.delivered_at,
          window_minutes: windowMinutes,
        },
      });
    },

    activeUnackedWarnings,

    dismissUnackedDispatchWarning(ticketId, deliveryEventId, { actor = 'human' } = {}) {
      const existing = stmts.getTicket.get(ticketId);
      if (!existing) throw new Error(`dismissUnackedDispatchWarning: ticket '${ticketId}' not found`);
      const idNum = Number(deliveryEventId);
      const envelope = stmts.getEnvelope.get(String(deliveryEventId));
      if (!Number.isFinite(idNum) && (!envelope || envelope.ticket_id !== ticketId)) throw new Error('dismissUnackedDispatchWarning: delivery_event_id or envelope_id is required');
      return recordEvent({
        ticket_id: ticketId,
        project_id: existing.project_id,
        type: 'dispatch_unacked_dismissed',
        actor,
        data: envelope ? { envelope_id: envelope.id } : { delivery_event_id: idNum },
      });
    },

    addComment(ticket_id, input = {}) {
      const existing = stmts.getTicket.get(ticket_id);
      if (!existing) throw new Error(`addComment: ticket '${ticket_id}' not found`);
      const {
        author, body, quote, prefix, suffix, section, section_id,
        tag = 'note', status = 'open', parent_id, block_id,
      } = input;
      if (!author) throw new Error('addComment: author is required');
      if (body == null) throw new Error('addComment: body is required');
      if (tag && !COMMENT_TAGS.has(tag)) throw new Error(`addComment: invalid tag '${tag}'`);
      const ts = now();
      const row = {
        id: crypto.randomUUID(), ticket_id, author,
        body: toMarkdownBody(body),
        quote: quote ?? null,
        prefix: prefix ?? null,
        suffix: suffix ?? null,
        section: section ?? null,
        section_id: section_id ?? null,
        tag,
        status,
        dispatch_state: defaultDispatchStateForComment({ author, status }),
        parent_id: parent_id ?? null,
        block_id: block_id ?? (parent_id
          ? db.prepare('SELECT block_id FROM comments WHERE id = ? AND ticket_id = ?').get(parent_id, ticket_id)?.block_id ?? null
          : null),
        created_at: ts,
        updated_at: ts,
      };
      const txn = db.transaction(() => {
        stmts.insertComment.run(row);
        stmts.touchTicket.run(ts, ticket_id);
        recordEvent({
          ticket_id,
          project_id: existing.project_id,
          type: 'commented',
          actor: author,
          data: { comment_id: row.id },
        });
        commentDispatch.markAddressedByComment(row);
        return row;
      });
      return txn();
    },

    enqueueCommentDispatch(comment, sessionId, batchId = null) {
      return commentDispatch.enqueueDispatch(comment, sessionId, batchId);
    },

    enqueueCommentDispatchBatch(ticketId, sessionId) {
      return commentDispatch.enqueueBatch(ticketId, sessionId);
    },

    cancelCommentDispatches(dispatchIds, reason = 'delivery_failed') {
      return commentDispatch.cancelDispatches(dispatchIds, reason);
    },

    markCommentAddressed(commentId, bySession) {
      return commentDispatch.markAddressed(commentId, bySession);
    },

    listUndispatchedCommentsForTicket(ticketId) {
      return commentDispatch.listUndispatchedForTicket(ticketId);
    },

    getComment(commentId) {
      if (!commentId) return null;
      return db.prepare('SELECT * FROM comments WHERE id = ?').get(commentId) ?? null;
    },

    recomputeCommentDispatchState(commentId) {
      return commentDispatch.recomputeState(commentId);
    },

    recomputeAllCommentDispatchStates() {
      return commentDispatch.recomputeAll();
    },

    markCommentDispatchesDeliveredForTicket(ticketId, sessionId) {
      return commentDispatch.markDeliveredForTicket(ticketId, sessionId);
    },

    updateComment(ticket_id, comment_id, patch = {}) {
      const existingTicket = stmts.getTicket.get(ticket_id);
      if (!existingTicket) throw new Error(`updateComment: ticket '${ticket_id}' not found`);
      const existing = db.prepare('SELECT * FROM comments WHERE id = ? AND ticket_id = ?').get(comment_id, ticket_id);
      if (!existing) throw new Error(`updateComment: comment '${comment_id}' not found`);
      const ALLOWED = ['body', 'tag', 'status', 'block_id'];
      const updates = {};
      for (const key of ALLOWED) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) updates[key] = patch[key];
      }
      if ('body' in updates) updates.body = toMarkdownBody(updates.body);
      if ('tag' in updates && updates.tag && !COMMENT_TAGS.has(updates.tag)) {
        throw new Error(`updateComment: invalid tag '${updates.tag}'`);
      }
      if (!Object.keys(updates).length) return existing;
      const setClause = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
      const ts = now();
      db.prepare(`UPDATE comments SET ${setClause}, updated_at = @updated_at WHERE id = @id AND ticket_id = @ticket_id`).run({
        ...updates,
        updated_at: ts,
        id: comment_id,
        ticket_id,
      });
      stmts.touchTicket.run(ts, ticket_id);
      recordEvent({
        ticket_id,
        project_id: existingTicket.project_id,
        type: 'comment_updated',
        actor: patch.actor ?? existing.author,
        data: { comment_id },
      });
      return db.prepare('SELECT * FROM comments WHERE id = ?').get(comment_id);
    },

    createStream(input = {}) {
      const { project_id, name, mode = 'parallel', description = '' } = input;
      if (!project_id) throw new Error('createStream: project_id is required');
      if (!name) throw new Error('createStream: name is required');
      if (!STREAM_MODES.has(mode)) throw new Error(`createStream: invalid mode '${mode}'`);
      const ts = now();
      const row = { id: crypto.randomUUID(), project_id, name, mode, description, created_at: ts, updated_at: ts };
      stmts.insertStream.run(row);
      return row;
    },

    listStreams(project_id) {
      return stmts.listStreams.all(project_id);
    },

    updateStream(id, patch = {}) {
      const existing = stmts.getStream.get(id);
      if (!existing) throw new Error(`updateStream: stream '${id}' not found`);
      const ALLOWED = ['name', 'mode', 'description'];
      const updates = {};
      for (const key of ALLOWED) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) updates[key] = patch[key];
      }
      if ('mode' in updates && !STREAM_MODES.has(updates.mode)) {
        throw new Error(`updateStream: invalid mode '${updates.mode}'`);
      }
      const ts = now();
      if (Object.keys(updates).length) {
        const setClause = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
        db.prepare(`UPDATE streams SET ${setClause}, updated_at = @updated_at WHERE id = @id`).run({
          ...updates,
          updated_at: ts,
          id,
        });
      } else {
        db.prepare('UPDATE streams SET updated_at = ? WHERE id = ?').run(ts, id);
      }
      return stmts.getStream.get(id);
    },

    addLink(from_ticket, to_ticket, type) {
      if (!LINK_TYPES.has(type)) throw new Error(`addLink: invalid type '${type}'`);
      if (!stmts.getTicket.get(from_ticket)) throw new Error(`addLink: from_ticket '${from_ticket}' not found`);
      if (!stmts.getTicket.get(to_ticket)) throw new Error(`addLink: to_ticket '${to_ticket}' not found`);
      stmts.insertLink.run(from_ticket, to_ticket, type);
      return { from_ticket, to_ticket, type };
    },

    removeLink(from_ticket, to_ticket, type) {
      const info = stmts.deleteLink.run(from_ticket, to_ticket, type);
      return { removed: info.changes };
    },

    listLinks(ticket_id) {
      return stmts.listLinks.all(ticket_id, ticket_id);
    },

    listEvents({ ticket_id, project_id, limit = 100 } = {}) {
      const where = [];
      const params = {};
      if (ticket_id != null) {
        where.push('ticket_id = @ticket_id');
        params.ticket_id = ticket_id;
      }
      if (project_id != null) {
        where.push('project_id = @project_id');
        params.project_id = project_id;
      }
      params.limit = limit;
      const sql =
        'SELECT * FROM events' +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        ' ORDER BY id DESC LIMIT @limit';
      return db.prepare(sql).all(params).map((e) => ({ ...e, data: safeParse(e.data) }));
    },
  };

  return api.init();
}
