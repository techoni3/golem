// Tracker data layer — a NEW SQLite database the dashboard server owns.
//
// This is the cross-project ticket tracker's storage. It supersedes the
// legacy read-only markdown reader in tracker.js (which WS2 will keep around
// for back-compat). Everything here is synchronous (better-sqlite3); the
// dashboard's request handlers are async but the DB calls inside them are not.
//
// DB path resolution mirrors how the rest of the codebase finds the golem
// config dir (see orchestrator.js): XDG_CONFIG_HOME ?? ~/.config, then /golem.
// The file is tracker.db inside that dir, overridable wholesale via
// GOLEM_TRACKER_DB.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const SCHEMA_VERSION = 1;

const KINDS = new Set(['work-item', 'decision', 'spec', 'question', 'fix']);
const STATES = new Set(['todo', 'in_progress', 'blocked', 'review', 'done', 'archived']);
const STREAM_MODES = new Set(['sequential', 'parallel']);
const LINK_TYPES = new Set(['blocks', 'relates', 'duplicates']);

const HOME = os.homedir();

function configDir() {
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(HOME, '.config'), 'golem');
}

/** Default DB path: <golem config dir>/tracker.db, overridable by GOLEM_TRACKER_DB. */
export function defaultDbPath() {
  return process.env.GOLEM_TRACKER_DB ?? path.join(configDir(), 'tracker.db');
}

function now() {
  return new Date().toISOString();
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
        priority      TEXT,
        labels        TEXT NOT NULL DEFAULT '[]',
        stream_id     TEXT,
        parent_id     TEXT,
        assignee      TEXT,
        created_by    TEXT NOT NULL DEFAULT 'human',
        dispatched_to TEXT,
        dispatched_at TEXT,
        source_ref    TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tickets_project  ON tickets(project_id);
      CREATE INDEX IF NOT EXISTS idx_tickets_state    ON tickets(state);
      CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets(assignee);

      CREATE TABLE IF NOT EXISTS comments (
        id         TEXT PRIMARY KEY,
        ticket_id  TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        author     TEXT NOT NULL,
        body       TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_comments_ticket ON comments(ticket_id);

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
        ticket_id  TEXT,
        project_id TEXT,
        type       TEXT NOT NULL,
        actor      TEXT,
        data       TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_ticket  ON events(ticket_id);
      CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id);

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // Seed meta defaults idempotently.
    const seed = db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)');
    seed.run('schema_version', String(SCHEMA_VERSION));
    seed.run('ticket_seq', '0');
  }

  // ---- prepared statements (built lazily after migrate) ----------------
  let stmts = null;
  function prepare() {
    stmts = {
      insertTicket: db.prepare(`
        INSERT INTO tickets
          (id, seq, project_id, kind, title, body, state, priority, labels,
           stream_id, parent_id, assignee, created_by, dispatched_to,
           dispatched_at, source_ref, created_at, updated_at)
        VALUES
          (@id, @seq, @project_id, @kind, @title, @body, @state, @priority, @labels,
           @stream_id, @parent_id, @assignee, @created_by, @dispatched_to,
           @dispatched_at, @source_ref, @created_at, @updated_at)
      `),
      getTicket: db.prepare('SELECT * FROM tickets WHERE id = ?'),
      getComments: db.prepare('SELECT * FROM comments WHERE ticket_id = ? ORDER BY created_at ASC, id ASC'),
      insertComment: db.prepare(`
        INSERT INTO comments (id, ticket_id, author, body, created_at)
        VALUES (@id, @ticket_id, @author, @body, @created_at)
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
        INSERT INTO events (ticket_id, project_id, type, actor, data, created_at)
        VALUES (@ticket_id, @project_id, @type, @actor, @data, @created_at)
      `),
      getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    };
  }

  // ---- internal helpers -------------------------------------------------

  // recordEvent — internal, also exported on the returned object. Persists one
  // event row; `data` is JSON-serialized.
  function recordEvent({ ticket_id = null, project_id = null, type, actor = null, data = {} } = {}) {
    if (!type) throw new Error('recordEvent: type is required');
    const row = {
      ticket_id,
      project_id,
      type,
      actor,
      data: typeof data === 'string' ? data : JSON.stringify(data ?? {}),
      created_at: now(),
    };
    const info = stmts.insertEvent.run(row);
    return { id: Number(info.lastInsertRowid), ...row, data: safeParse(row.data) };
  }

  function safeParse(s) {
    try {
      return JSON.parse(s);
    } catch {
      return {};
    }
  }

  // allocateTicketId — bump the meta ticket_seq counter inside a transaction
  // and format the new id. Monotonic and collision-free under concurrent opens
  // because better-sqlite3 transactions serialize and busy_timeout retries.
  const allocateTxn = db.transaction(() => {
    const cur = Number(stmts.getMeta.get('ticket_seq')?.value ?? '0');
    const seq = cur + 1;
    stmts.setMeta.run('ticket_seq', String(seq));
    const id = `TKT-${String(seq).padStart(4, '0')}`;
    return { id, seq };
  });

  function allocateTicketId() {
    return allocateTxn();
  }

  // ---- public API -------------------------------------------------------

  const api = {
    init() {
      migrate();
      prepare();
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

    createTicket(input = {}) {
      const {
        project_id,
        kind = 'work-item',
        title,
        body = '',
        state = 'todo',
        priority = null,
        labels = [],
        stream_id = null,
        parent_id = null,
        assignee = null,
        created_by = 'human',
        source_ref = null,
      } = input;

      if (!project_id) throw new Error('createTicket: project_id is required');
      if (!title) throw new Error('createTicket: title is required');
      if (!KINDS.has(kind)) throw new Error(`createTicket: invalid kind '${kind}'`);
      if (!STATES.has(state)) throw new Error(`createTicket: invalid state '${state}'`);

      const ts = now();
      const txn = db.transaction(() => {
        const { id, seq } = allocateTicketId();
        const row = {
          id,
          seq,
          project_id,
          kind,
          title,
          body,
          state,
          priority,
          labels: serializeLabels(labels),
          stream_id,
          parent_id,
          assignee,
          created_by,
          dispatched_to: null,
          dispatched_at: null,
          source_ref,
          created_at: ts,
          updated_at: ts,
        };
        stmts.insertTicket.run(row);
        recordEvent({
          ticket_id: id,
          project_id,
          type: 'created',
          actor: created_by,
          data: { kind, state, title },
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
      return { ...hydrateTicket(row), comments, links };
    },

    listTickets(filter = {}) {
      const { project_id, state, assignee, kind, stream_id, includeArchived } = filter;
      const where = [];
      const params = {};
      if (project_id != null) {
        where.push('project_id = @project_id');
        params.project_id = project_id;
      }
      if (state != null) {
        where.push('state = @state');
        params.state = state;
      }
      if (assignee != null) {
        where.push('assignee = @assignee');
        params.assignee = assignee;
      }
      if (kind != null) {
        where.push('kind = @kind');
        params.kind = kind;
      }
      if (stream_id != null) {
        where.push('stream_id = @stream_id');
        params.stream_id = stream_id;
      }
      // Exclude archived by default unless explicitly asking for it.
      if (state !== 'archived' && !includeArchived) {
        where.push("state != 'archived'");
      }
      const sql =
        'SELECT * FROM tickets' +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        ' ORDER BY seq ASC';
      return db.prepare(sql).all(params).map(hydrateTicket);
    },

    updateTicket(id, patch = {}) {
      const existing = stmts.getTicket.get(id);
      if (!existing) throw new Error(`updateTicket: ticket '${id}' not found`);

      const actor = patch.actor ?? 'human';
      const ALLOWED = ['title', 'body', 'kind', 'state', 'priority', 'labels', 'stream_id', 'parent_id', 'assignee'];
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

      const ts = now();
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
            data: { from: existing.state, to: updates.state },
          });
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

    setDispatched(id, { session_id, actor = 'human' } = {}) {
      const existing = stmts.getTicket.get(id);
      if (!existing) throw new Error(`setDispatched: ticket '${id}' not found`);
      if (!session_id) throw new Error('setDispatched: session_id is required');
      const ts = now();
      const txn = db.transaction(() => {
        db.prepare(
          'UPDATE tickets SET assignee = @s, dispatched_to = @s, dispatched_at = @ts, updated_at = @ts WHERE id = @id',
        ).run({ s: session_id, ts, id });
        recordEvent({
          ticket_id: id,
          project_id: existing.project_id,
          type: 'dispatched',
          actor,
          data: { session_id },
        });
        return stmts.getTicket.get(id);
      });
      return hydrateTicket(txn());
    },

    addComment(ticket_id, { author, body } = {}) {
      const existing = stmts.getTicket.get(ticket_id);
      if (!existing) throw new Error(`addComment: ticket '${ticket_id}' not found`);
      if (!author) throw new Error('addComment: author is required');
      if (body == null) throw new Error('addComment: body is required');
      const ts = now();
      const row = { id: crypto.randomUUID(), ticket_id, author, body, created_at: ts };
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
        return row;
      });
      return txn();
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
