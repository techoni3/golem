// ct-draft.js — per-project composer drafts (GitHub-issue style).
//
// Persists in-progress ticket-composer state to localStorage so dismissing the
// drawer or refreshing the tab never loses work. One draft per project, keyed
// by canonical project_id (`ct:draft:<project_id>`), plus a transient
// `__unscoped__` bucket used before a project is chosen (migrated into the
// project's own key once the user picks one).
//
// Exposed as window.CtDraft. Loaded as a plain script (no JSX) before the
// babel-compiled create-ticket-drawer.jsx so the drawer can call it on mount.
//
// Snapshot shape (matches the composer fields 1:1):
//   { project_id, kind, title, body, priority, stream_id, assignee,
//     dispatch_session, uploads: [{url, filename}] }

(function () {
  const PREFIX = 'ct:draft:';
  const UNSCOPED = '__unscoped__';
  const VERSION = 1;
  const SAVE_DELAY = 300; // ms — coalesce rapid keystrokes into one write

  let pendingTimer = null;
  let pendingKey = null;
  let pendingSnap = null;

  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

  const keyFor = (projectId) =>
    PREFIX + (projectId && projectId !== UNSCOPED ? projectId : UNSCOPED);

  const read = (k) => safe(() => {
    const raw = localStorage.getItem(k);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || obj.version !== VERSION) return null;
    return obj;
  }, null);

  const write = (k, snap) => safe(() => {
    // Don't litter localStorage with empty drafts: if the snapshot has no
    // title and no body, treat it as "no draft" and remove the key instead.
    // This keeps discard + the post-discard autosave tick from re-creating an
    // empty entry that would later show a spurious "restored draft" banner.
    if (!hasContent(snap)) { localStorage.removeItem(k); return; }
    localStorage.setItem(k, JSON.stringify({ ...snap, version: VERSION, updated_at: Date.now() }));
  });

  const remove = (k) => safe(() => localStorage.removeItem(k));

  const hasContent = (d) => !!(
    (d && typeof d.title === 'string' && d.title.trim()) ||
    (d && typeof d.body === 'string' && d.body.trim())
  );

  // ── Public API ───────────────────────────────────────────────────────────

  function load(projectId) {
    return read(keyFor(projectId));
  }

  function hasDraft(projectId) {
    return hasContent(read(keyFor(projectId)));
  }

  // Immediate write (used by the debounced flush path / explicit save).
  function saveNow(projectId, snap) {
    if (!snap) return;
    write(keyFor(projectId), snap);
  }

  // Debounced save — coalesces rapid field changes into one write. Replaces
  // any pending write for the SAME key; switching projects cancels the pending
  // write (the caller should flush before swapping projects).
  function scheduleSave(projectId, snap) {
    pendingKey = keyFor(projectId);
    pendingSnap = snap;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      if (pendingKey && pendingSnap) write(pendingKey, pendingSnap);
      pendingKey = null; pendingSnap = null;
    }, SAVE_DELAY);
  }

  // Flush any pending debounced write immediately — call on close / beforeunload.
  function flush() {
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    if (pendingKey && pendingSnap) write(pendingKey, pendingSnap);
    pendingKey = null; pendingSnap = null;
  }

  function discard(projectId) {
    const k = keyFor(projectId);
    remove(k);
    if (pendingKey === k) { pendingKey = null; pendingSnap = null; }
  }

  // When the user finally picks a project, carry the unscoped draft into the
  // project's bucket so it isn't orphaned. No-op if the project already has
  // its own draft (we never overwrite one project's work with another's).
  // Returns the draft that should now be shown (the project's, possibly the
  // migrated unscoped one), or null.
  function migrateToProject(projectId) {
    if (!projectId || projectId === UNSCOPED) return null;
    const existing = read(keyFor(projectId));
    if (hasContent(existing)) return existing;
    const unscoped = read(keyFor(UNSCOPED));
    if (!hasContent(unscoped)) return existing;
    const moved = { ...unscoped, project_id: projectId };
    write(keyFor(projectId), moved);
    remove(keyFor(UNSCOPED));
    return moved;
  }

  window.CtDraft = {
    load, hasDraft, saveNow, scheduleSave, flush, discard, migrateToProject,
    UNSCOPED, PREFIX, VERSION,
  };
})();