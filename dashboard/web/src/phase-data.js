// GOL-314: browser-side view of the tracker phase machines. Server validation
// remains authoritative; this powers chips and legal next-phase affordances.
(function () {
  const workItem = {
    initial: 'queued',
    canonical: { queued: 'todo', building: 'in_progress', blocked: 'blocked', built: 'review', verifying: 'review', verified: 'review', rejected: 'in_progress', done: 'done' },
    transitions: { queued: ['building', 'blocked'], building: ['built', 'blocked'], blocked: ['building'], built: ['verifying', 'done'], verifying: ['verified', 'rejected'], verified: ['done'], rejected: ['building'], done: [] },
  };
  const machines = {
    spec: {
      initial: 'drafting',
      canonical: { drafting: 'todo', grounding: 'in_progress', grounded: 'in_progress', designing: 'in_progress', designed: 'review', planning: 'in_progress', planned: 'in_progress', building: 'in_progress', done: 'done', parked: 'blocked' },
      transitions: { drafting: ['grounding', 'parked'], grounding: ['grounded', 'parked'], grounded: ['designing', 'parked'], designing: ['designed', 'grounding', 'parked'], designed: ['planning', 'parked'], planning: ['planned', 'designing', 'parked'], planned: ['building', 'parked'], building: ['done', 'parked'], parked: ['drafting', 'grounding', 'designing', 'planning', 'building'], done: [] },
    },
    'work-item': workItem,
    fix: workItem,
    question: { initial: 'open', canonical: { open: 'todo', answered: 'review', closed: 'done' }, transitions: { open: ['answered'], answered: ['closed'], closed: [] } },
    decision: { initial: 'open', canonical: { open: 'todo', decided: 'review', closed: 'done' }, transitions: { open: ['decided'], decided: ['closed'], closed: [] } },
  };
  const fallback = {
    spec: { todo: 'drafting', in_progress: 'designing', blocked: 'parked', review: 'designed', done: 'done', archived: 'done' },
    'work-item': { todo: 'queued', in_progress: 'building', blocked: 'blocked', review: 'built', done: 'done', archived: 'done' },
    fix: { todo: 'queued', in_progress: 'building', blocked: 'blocked', review: 'built', done: 'done', archived: 'done' },
    question: { todo: 'open', in_progress: 'open', blocked: 'open', review: 'answered', done: 'closed', archived: 'closed' },
    decision: { todo: 'open', in_progress: 'open', blocked: 'open', review: 'decided', done: 'closed', archived: 'closed' },
  };

  function machine(kind) { return machines[kind] || machines['work-item']; }
  function phaseFor(ticket) {
    if (!ticket) return '';
    if (ticket.phase) return ticket.phase;
    const kind = ticket.kind || 'work-item';
    return fallback[kind]?.[ticket.state] || machine(kind).initial;
  }
  function stateFor(kind, phase) { return machine(kind).canonical[phase] || 'todo'; }
  function next(ticket) { return machine(ticket?.kind || 'work-item').transitions[phaseFor(ticket)] || []; }

  window.PhaseMachine = { machines, machine, phaseFor, stateFor, next };
})();
