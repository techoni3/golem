import crypto from 'node:crypto';

export const COMMENT_DISPATCH_STATES = new Set(['undispatched', 'dispatched', 'addressed', 'n/a']);

export function isHumanCommentAuthor(author) {
  const a = String(author ?? '').trim().toLowerCase();
  return a === 'human' || a === 'you' || a === 'human:dashboard';
}

export function defaultDispatchStateForComment({ author, status } = {}) {
  return isHumanCommentAuthor(author) && (status ?? 'open') === 'open' ? 'undispatched' : 'n/a';
}

export function createCommentDispatchService({ db, now, recordEvent, actorFormsForSession }) {
  function getComment(commentOrId) {
    if (commentOrId && typeof commentOrId === 'object') return commentOrId;
    return db.prepare('SELECT * FROM comments WHERE id = ?').get(commentOrId);
  }

  function recomputeState(commentId) {
    const comment = getComment(commentId);
    if (!comment) throw new Error(`recomputeState: comment '${commentId}' not found`);
    if (comment.dispatch_state === 'n/a') return comment;
    const rows = db.prepare('SELECT status FROM comment_dispatches WHERE comment_id = ?').all(comment.id);
    // GOL-101: a cancelled row is a dispatch that never landed (delivery failed
    // and was rolled back). Only a genuine `addressed` row means the target
    // engaged; rows that are *all* cancelled fall back to the default state so
    // the comment re-enters the undispatched queue and can be retried.
    let state = defaultDispatchStateForComment(comment);
    if (rows.some((r) => r.status === 'pending' || r.status === 'delivered')) {
      state = 'dispatched';
    } else if (rows.some((r) => r.status === 'addressed')) {
      state = 'addressed';
    } else if (rows.length) {
      // Every row cancelled: the dispatch never landed. Re-queue it rather than
      // re-deriving from the comment's *current* status — a comment resolved
      // between enqueue and a failed push would otherwise fall to 'n/a', which
      // recomputeState treats as terminal, stranding it forever.
      state = isHumanCommentAuthor(comment.author) ? 'undispatched' : state;
    }
    db.prepare('UPDATE comments SET dispatch_state = ?, updated_at = ? WHERE id = ?').run(state, now(), comment.id);
    return db.prepare('SELECT * FROM comments WHERE id = ?').get(comment.id);
  }

  function enqueueDispatch(commentOrId, sessionId, batchId = null) {
    const comment = getComment(commentOrId);
    if (!comment) throw new Error('enqueueDispatch: comment not found');
    if (!sessionId) throw new Error('enqueueDispatch: session_id is required');
    const ticket = db.prepare('SELECT id, project_id FROM tickets WHERE id = ?').get(comment.ticket_id);
    if (!ticket) throw new Error(`enqueueDispatch: ticket '${comment.ticket_id}' not found`);
    const ts = now();
    const row = {
      id: crypto.randomUUID(),
      comment_id: comment.id,
      ticket_id: ticket.id,
      project_id: ticket.project_id,
      session_id: sessionId,
      batch_id: batchId ?? null,
      status: 'pending',
      created_at: ts,
      delivered_at: null,
      addressed_at: null,
    };
    db.prepare(`
      INSERT INTO comment_dispatches
        (id, comment_id, ticket_id, project_id, session_id, batch_id, status, created_at, delivered_at, addressed_at)
      VALUES
        (@id, @comment_id, @ticket_id, @project_id, @session_id, @batch_id, @status, @created_at, @delivered_at, @addressed_at)
    `).run(row);
    db.prepare("UPDATE comments SET dispatch_state = 'dispatched', updated_at = ? WHERE id = ? AND dispatch_state != 'n/a'").run(ts, comment.id);
    recordEvent({
      ticket_id: ticket.id,
      project_id: ticket.project_id,
      type: 'comment_dispatched',
      actor: 'system',
      data: { comment_id: comment.id, dispatch_id: row.id, session_id: sessionId, batch_id: row.batch_id },
    });
    return row;
  }

  function listUndispatchedForTicket(ticketId) {
    if (!ticketId) throw new Error('listUndispatchedForTicket: ticket_id is required');
    return db.prepare(`
      SELECT * FROM comments
      WHERE ticket_id = ? AND dispatch_state = 'undispatched' AND status = 'open'
      ORDER BY created_at ASC, id ASC
    `).all(ticketId);
  }

  function enqueueBatch(ticketId, sessionId) {
    if (!sessionId) throw new Error('enqueueBatch: session_id is required');
    const comments = listUndispatchedForTicket(ticketId);
    const batchId = crypto.randomUUID();
    const txn = db.transaction(() => comments.map((comment) => enqueueDispatch(comment, sessionId, batchId)));
    return { batch_id: batchId, dispatches: txn() };
  }

  // GOL-101: roll an enqueued-but-undelivered dispatch back. Enqueue happens
  // before the channel push (durable-first), so a push that fails would
  // otherwise strand its comments in `dispatched` with nothing left to retry —
  // the batch endpoint then finds zero undispatched comments and no-ops.
  function cancelDispatches(dispatchIds, reason = 'delivery_failed') {
    const ids = (Array.isArray(dispatchIds) ? dispatchIds : [dispatchIds]).filter(Boolean);
    if (ids.length === 0) return { cancelled: 0, comments: [] };
    const ts = now();
    const select = db.prepare('SELECT * FROM comment_dispatches WHERE id = ?');
    const cancel = db.prepare(`
      UPDATE comment_dispatches
      SET status = 'cancelled', addressed_at = NULL
      WHERE id = @id AND status IN ('pending', 'delivered')
    `);
    const rows = ids.map((id) => select.get(id)).filter(Boolean);
    // Only rows this call actually moved get an event — a row that was already
    // addressed or cancelled is not re-cancelled and must not be reported as if
    // it were.
    const changedIds = new Set();
    const txn = db.transaction(() => rows.reduce((n, row) => {
      const info = cancel.run({ id: row.id });
      if (info.changes > 0) changedIds.add(row.id);
      return n + info.changes;
    }, 0));
    const cancelled = txn();
    const changedRows = rows.filter((r) => changedIds.has(r.id));
    const commentIds = [...new Set(changedRows.map((r) => r.comment_id))];
    for (const commentId of commentIds) recomputeState(commentId);
    for (const row of changedRows) {
      recordEvent({
        ticket_id: row.ticket_id,
        project_id: row.project_id,
        type: 'comment_dispatch_cancelled',
        actor: 'system',
        data: {
          comment_id: row.comment_id,
          dispatch_id: row.id,
          session_id: row.session_id,
          batch_id: row.batch_id,
          reason,
          cancelled_at: ts,
        },
      });
    }
    return { cancelled, comments: commentIds };
  }

  function markAddressed(commentId, bySession) {
    const comment = getComment(commentId);
    if (!comment) throw new Error(`markAddressed: comment '${commentId}' not found`);
    if (!bySession) throw new Error('markAddressed: bySession is required');
    const ts = now();
    const info = db.prepare(`
      UPDATE comment_dispatches
      SET status = 'addressed', addressed_at = @ts
      WHERE comment_id = @comment_id
        AND session_id = @session_id
        AND status IN ('pending', 'delivered')
    `).run({ ts, comment_id: comment.id, session_id: bySession });
    if (info.changes > 0) {
      recordEvent({
        ticket_id: comment.ticket_id,
        project_id: db.prepare('SELECT project_id FROM tickets WHERE id = ?').get(comment.ticket_id)?.project_id ?? null,
        type: 'comment_addressed',
        actor: bySession,
        data: { comment_id: comment.id, addressed_by: bySession },
      });
    }
    recomputeState(comment.id);
    return { addressed: info.changes };
  }

  function markDeliveredForTicket(ticketId, sessionId) {
    if (!ticketId || !sessionId) return { delivered: 0 };
    const ts = now();
    const rows = db.prepare(`
      SELECT DISTINCT comment_id FROM comment_dispatches
      WHERE ticket_id = @ticket_id AND session_id = @session_id AND status = 'pending'
    `).all({ ticket_id: ticketId, session_id: sessionId });
    const info = db.prepare(`
      UPDATE comment_dispatches
      SET status = 'delivered', delivered_at = @ts
      WHERE ticket_id = @ticket_id AND session_id = @session_id AND status = 'pending'
    `).run({ ts, ticket_id: ticketId, session_id: sessionId });
    for (const row of rows) recomputeState(row.comment_id);
    return { delivered: info.changes };
  }

  // A durable typed envelope owns an immutable set of comment-dispatch rows.
  // Never turn a later settlement into a ticket/session-wide sweep: another
  // human comment can be queued for the same target while the older envelope
  // is waiting on a lost response or restart. The pending-state predicate is
  // the CAS guard; addressed/cancelled/newer rows cannot be advanced here.
  function markDeliveredDispatches(dispatchIds) {
    const ids = [...new Set((Array.isArray(dispatchIds) ? dispatchIds : [dispatchIds])
      .filter((id) => typeof id === 'string' && id))];
    if (ids.length === 0) return { delivered: 0, dispatches: [] };
    const ts = now();
    const select = db.prepare('SELECT id, comment_id FROM comment_dispatches WHERE id = ?');
    const deliver = db.prepare(`
      UPDATE comment_dispatches
      SET status = 'delivered', delivered_at = @ts
      WHERE id = @id AND status = 'pending'
    `);
    const rows = ids.map((id) => select.get(id)).filter(Boolean);
    const changed = [];
    const txn = db.transaction(() => {
      for (const row of rows) {
        if (deliver.run({ id: row.id, ts }).changes) changed.push(row);
      }
      for (const commentId of new Set(changed.map((row) => row.comment_id))) recomputeState(commentId);
      return { delivered: changed.length, dispatches: changed.map((row) => row.id) };
    });
    return txn();
  }

  function listPendingDispatchesForTicket(ticketId, sessionId) {
    if (!ticketId || !sessionId) return [];
    return db.prepare(`
      SELECT id, batch_id
      FROM comment_dispatches
      WHERE ticket_id = @ticket_id AND session_id = @session_id AND status = 'pending'
      ORDER BY created_at ASC, id ASC
    `).all({ ticket_id: ticketId, session_id: sessionId });
  }

  function matchingSessionIdForAuthor(author, rows) {
    for (const row of rows) {
      const forms = new Set(actorFormsForSession(row.session_id));
      if (forms.has(author)) return row.session_id;
    }
    return null;
  }

  function markAddressedByComment(comment) {
    if (!comment?.ticket_id || !comment.author) return { addressed: 0 };
    const candidates = db.prepare(`
      SELECT cd.comment_id, cd.session_id, c.block_id
      FROM comment_dispatches cd
      JOIN comments c ON c.id = cd.comment_id
      WHERE cd.ticket_id = @ticket_id
        AND cd.status IN ('pending', 'delivered')
    `).all({ ticket_id: comment.ticket_id });
    let addressed = 0;
    for (const row of candidates) {
      const sameBlock = !!row.block_id && !!comment.block_id && row.block_id === comment.block_id;
      const directReply = comment.parent_id === row.comment_id;
      if (!sameBlock && !directReply) continue;
      const sessionId = matchingSessionIdForAuthor(comment.author, [row]);
      if (!sessionId) continue;
      addressed += markAddressed(row.comment_id, sessionId).addressed;
    }
    return { addressed };
  }

  function markAddressedForTicketActivity(ticketId, bySession) {
    if (!ticketId || !bySession) return { addressed: 0 };
    const rows = db.prepare(`
      SELECT DISTINCT comment_id, session_id FROM comment_dispatches
      WHERE ticket_id = @ticket_id AND status IN ('pending', 'delivered')
    `).all({ ticket_id: ticketId });
    let addressed = 0;
    for (const row of rows) {
      const forms = new Set(actorFormsForSession(row.session_id));
      if (!forms.has(bySession)) continue;
      addressed += markAddressed(row.comment_id, row.session_id).addressed;
    }
    return { addressed };
  }

  function recomputeAll() {
    const rows = db.prepare("SELECT id FROM comments WHERE dispatch_state != 'n/a'").all();
    for (const row of rows) recomputeState(row.id);
    return { recomputed: rows.length };
  }

  return {
    enqueueDispatch,
    enqueueBatch,
    cancelDispatches,
    markAddressed,
    markAddressedByComment,
    markAddressedForTicketActivity,
    markDeliveredForTicket,
    markDeliveredDispatches,
    listPendingDispatchesForTicket,
    listUndispatchedForTicket,
    recomputeState,
    recomputeAll,
  };
}
