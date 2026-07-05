const WORK_ITEM_MACHINE = {
  initial: 'queued',
  phases: ['queued', 'building', 'blocked', 'built', 'verifying', 'verified', 'rejected', 'done'],
  terminal: ['done'],
  canonical: {
    queued: 'todo',
    building: 'in_progress',
    blocked: 'blocked',
    built: 'review',
    verifying: 'review',
    verified: 'review',
    rejected: 'in_progress',
    done: 'done',
  },
  transitions: {
    queued: ['building', 'blocked'],
    building: ['built', 'blocked'],
    blocked: ['building'],
    built: ['verifying', 'done'],
    verifying: ['verified', 'rejected'],
    verified: ['done'],
    rejected: ['building'],
    done: [],
  },
  requirements: {
    blocked: { reason: true },
    built: { closingBrief: true },
    verifying: { managerDispatch: true },
    verified: { verificationReport: true },
    rejected: { verificationReport: true },
    done: { verifiedOrSkipReason: true },
  },
};

export const PHASE_MACHINES = Object.freeze({
  spec: {
    initial: 'drafting',
    phases: ['drafting', 'grounding', 'grounded', 'designing', 'designed', 'planning', 'planned', 'building', 'done', 'parked'],
    terminal: ['done'],
    canonical: {
      drafting: 'todo',
      grounding: 'in_progress',
      grounded: 'in_progress',
      designing: 'in_progress',
      designed: 'review',
      planning: 'in_progress',
      planned: 'in_progress',
      building: 'in_progress',
      done: 'done',
      parked: 'blocked',
    },
    transitions: {
      drafting: ['grounding', 'parked'],
      grounding: ['grounded', 'parked'],
      grounded: ['designing', 'parked'],
      designing: ['designed', 'grounding', 'parked'],
      designed: ['planning', 'parked'],
      planning: ['planned', 'designing', 'parked'],
      planned: ['building', 'parked'],
      building: ['done', 'parked'],
      parked: ['drafting', 'grounding', 'designing', 'planning', 'building'],
      done: [],
    },
    requirements: {
      grounded: { comment: /grounding[-\s]?summary/i },
      designed: { comment: /design/i, finalisation: 'concerns' },
      planning: { humanFinalise: true },
      planned: { children: true, waves: true },
      building: { childStarted: true },
      done: { childrenTerminal: true },
      parked: { reason: true },
    },
  },
  'work-item': WORK_ITEM_MACHINE,
  fix: WORK_ITEM_MACHINE,
  question: {
    initial: 'open',
    phases: ['open', 'answered', 'closed'],
    terminal: ['closed'],
    canonical: { open: 'todo', answered: 'review', closed: 'done' },
    transitions: { open: ['answered'], answered: ['closed'], closed: [] },
    requirements: { answered: { answerComment: true } },
  },
  decision: {
    initial: 'open',
    phases: ['open', 'decided', 'closed'],
    terminal: ['closed'],
    canonical: { open: 'todo', decided: 'review', closed: 'done' },
    transitions: { open: ['decided'], decided: ['closed'], closed: [] },
    requirements: { decided: { decisionComment: true } },
  },
});

export function machineForKind(kind) {
  return PHASE_MACHINES[kind] || PHASE_MACHINES['work-item'];
}

export function isKnownPhase(kind, phase) {
  return machineForKind(kind).phases.includes(phase);
}

export function canonicalStateForPhase(kind, phase) {
  return machineForKind(kind).canonical[phase] || 'todo';
}

export function initialPhaseForKind(kind) {
  return machineForKind(kind).initial;
}

export function legalNextPhases(kind, phase) {
  return machineForKind(kind).transitions[phase] || [];
}

export function requirementsForPhase(kind, phase) {
  return machineForKind(kind).requirements?.[phase] || {};
}

export function phaseFromLegacyState(kind, state) {
  const machine = machineForKind(kind);
  if (state === 'archived') return machine.terminal[0] || machine.initial;
  const preferred = {
    spec: { todo: 'drafting', in_progress: 'designing', blocked: 'parked', review: 'designed', done: 'done' },
    'work-item': { todo: 'queued', in_progress: 'building', blocked: 'blocked', review: 'built', done: 'done' },
    fix: { todo: 'queued', in_progress: 'building', blocked: 'blocked', review: 'built', done: 'done' },
    question: { todo: 'open', in_progress: 'open', blocked: 'open', review: 'answered', done: 'closed' },
    decision: { todo: 'open', in_progress: 'open', blocked: 'open', review: 'decided', done: 'closed' },
  };
  return preferred[kind]?.[state] || machine.initial;
}

export function legacyStateToPhase(kind, currentPhase, state) {
  const target = phaseFromLegacyState(kind, state);
  const legal = legalNextPhases(kind, currentPhase);
  if (target === currentPhase || legal.includes(target)) return target;
  return null;
}
