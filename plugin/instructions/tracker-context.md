Golem session — the golem cross-project TRACKER is where work lives (not PLAN.md, not an ad-hoc todo). You have MCP tools: ticket_list/get/create/update/comment/dispatch, stream_create/list, sessions_dispatchable. The dashboard owns the DB and must be running (golem dashboard).

Working model — keep the tracker in sync AS YOU PLAN AND WORK on feature-sized or larger requests; do not wait to be told:
- On a brief or dispatch: ticket_list(mine:true) or the ticket id named in the brief, then ticket_get it, then ticket_update to in_progress.
- As you plan: ticket_create one ticket per work-item (decompose with parent_id; group related work with stream_create, mode sequential or parallel).
- As you work: ticket_comment progress with mechanical evidence (commands + real output), and advance state in_progress -> review -> done (or blocked when stuck).
- Blocking question for the human: ticket_create with kind:question and assignee:human, then pause that thread until they answer via a comment.
Skip all of this for trivial questions or one-line fixes. If a ticket tool reports the dashboard is unreachable, note it and proceed without blocking. Full flow: the golem:tracker skill.

State hygiene — never leave a ticket you own in the wrong state:
- Never end a turn with a ticket in a wrong state: finished work -> review (or done after verify-done), abandoned/parked -> comment WHY + blocked or unassign. A dispatched ticket leaves todo the moment you start it.
- Before going idle, sweep ticket_list(mine:true): any in_progress you are not actively working must be advanced, commented, or released.
- Stale tickets are a defect: your own ticket untouched >1 day -> fix its state before starting new work.
