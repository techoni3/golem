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
    let state = defaultDispatchStateForComment(comment);
    if (rows.some((r) => r.status === 'pending' || r.status === 'delivered')) {
      state = 'dispatched';
    } else if (rows.length && rows.every((r) => r.status === 'addressed' || r.status === 'cancelled')) {
      state = 'addressed';
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

  function listUndispatchedForSpec(ticketId) {
    if (!ticketId) throw new Error('listUndispatchedForSpec: ticket_id is required');
    return db.prepare(`
      SELECT * FROM comments
      WHERE ticket_id = ? AND dispatch_state = 'undispatched'
      ORDER BY created_at ASC, id ASC
    `).all(ticketId);
  }

  function enqueueBatch(ticketId, sessionId) {
    if (!sessionId) throw new Error('enqueueBatch: session_id is required');
    const comments = listUndispatchedForSpec(ticketId);
    const batchId = crypto.randomUUID();
    const txn = db.transaction(() => comments.map((comment) => enqueueDispatch(comment, sessionId, batchId)));
    return { batch_id: batchId, dispatches: txn() };
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
    markAddressed,
    markAddressedByComment,
    markAddressedForTicketActivity,
    markDeliveredForTicket,
    listUndispatchedForSpec,
    recomputeState,
    recomputeAll,
  };
}
