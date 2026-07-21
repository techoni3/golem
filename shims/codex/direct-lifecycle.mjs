import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = 1;
const INBOX_VERSION = 'golem.runtime-signal/v1';

// This deliberately mirrors packages/adapters/codex/src/direct/index.ts.
// The installed hook has to stay checkout-independent, so the algorithm is
// repeated byte-for-byte rather than importing a workspace package at runtime.
function stableUuid(seed) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < seed.length; index += 1) {
    const code = seed.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  const digest = `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}${seed.length.toString(16).padStart(16, '0')}`.padEnd(32, '0');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function stableId(prefix, seed) {
  return `${prefix}_${stableUuid(seed)}`;
}

function lifecyclePath(home) {
  return path.join(home, 'codex-lifecycle.json');
}

function readLifecycle(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.version === VERSION && parsed.sessions && typeof parsed.sessions === 'object') return parsed;
  } catch { /* fail-open: native launch must not be blocked by state */ }
  return { version: VERSION, sessions: {} };
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomUUID()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  const fd = fs.openSync(tmp, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

function withLock(file, fn) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      fs.mkdirSync(lock);
      try { return fn(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.rmSync(lock, { recursive: true, force: true });
      } catch { /* another producer owns the lock */ }
      const until = Date.now() + 10;
      while (Date.now() < until) { /* bounded lock retry */ }
    }
  }
  throw new Error('codex lifecycle lock unavailable');
}

function signalEventId(sessionId, revision, event) {
  return stableId('evt', `codex-event:${sessionId}:${revision}:${event}`);
}

function runtimeSignal({ record, event, revision, model, resumed, resumedFromGenerationId, observedAt }) {
  const sourceObservedAt = observedAt || new Date().toISOString();
  const generation = {
    project_id: record.project_id,
    session_id: record.session_id,
    generation_id: record.generation_id,
  };
  const eventKind = event === 'session-start' && resumed
    ? 'session.resumed'
    : event === 'session-start'
      ? 'session.started'
      : event === 'stop'
        ? 'session.ended'
        : event === 'subagent-stop'
          ? 'session.idle'
          : 'session.activity';
  const payload = eventKind === 'session.started'
    ? { kind: eventKind, generation, metadata: model ? { model } : {} }
    : eventKind === 'session.resumed'
      ? { kind: eventKind, generation, ...(resumedFromGenerationId ? { resumed_from_generation_id: resumedFromGenerationId } : {}) }
      : eventKind === 'session.ended'
        ? { kind: eventKind, generation, disposition: 'ended' }
        : eventKind === 'session.idle'
          ? { kind: eventKind, generation }
          : { kind: eventKind, generation, activity_kind: event === 'user-prompt' ? 'prompt' : event.startsWith('tool-') ? 'tool' : 'work' };
  return {
    schema_version: INBOX_VERSION,
    event_id: signalEventId(record.session_id, revision, event),
    event_kind: eventKind,
    producer: 'codex-direct-hook',
    producer_instance_id: record.producer_id,
    harness: 'codex',
    correlation_id: `codex:${record.session_id}`,
    deduplication_key: `codex:${record.session_id}:${record.generation_id}:${revision}:${event}`,
    clocks: { source_observed_at: sourceObservedAt, source_event_at: sourceObservedAt, received_at: sourceObservedAt },
    provenance: { source: 'adapter', confidence: 'observed', evidence_id: `codex-hook:${event}` },
    clear_fields: [],
    payload,
  };
}

function projectSignal(record, observedAt) {
  const projectKey = `codex-project:${record.project_path}`;
  return {
    schema_version: INBOX_VERSION,
    event_id: stableId('evt', `${projectKey}:observed`),
    event_kind: 'project.observed',
    producer: 'codex-direct-hook',
    producer_instance_id: record.producer_id,
    harness: 'codex',
    correlation_id: `codex:${record.session_id}`,
    deduplication_key: `codex:project:${record.project_path}`,
    clocks: { source_observed_at: observedAt, source_event_at: observedAt, received_at: observedAt },
    provenance: { source: 'adapter', confidence: 'observed', evidence_id: projectKey },
    clear_fields: [],
    payload: {
      kind: 'project.observed',
      project: { project_id: record.project_id },
      location: {
        project_id: record.project_id,
        location_id: stableId('loc', `codex-location:${record.project_path}`),
        relation: 'main',
        canonical_path: record.project_path,
      },
    },
  };
}

function writeEnvelope(home, signal) {
  const pending = path.join(home, 'inbox', 'pending');
  fs.mkdirSync(pending, { recursive: true, mode: 0o700 });
  const target = path.join(pending, `${signal.event_id}.json`);
  const tmp = path.join(pending, `.${signal.event_id}.${crypto.randomUUID()}.tmp`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(signal)}\n`);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try {
    fs.linkSync(tmp, target);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already published */ }
  }
  return target;
}

function initialRecord(projectPath, rawSessionId) {
  const projectId = stableId('prj', `codex-project:${projectPath}`);
  const sessionId = stableId('ses', `codex-session:${projectId}:${rawSessionId}`);
  const generationId = stableId('gen', `codex-generation:${sessionId}:1`);
  return {
    project_path: projectPath,
    raw_session_id: rawSessionId,
    project_id: projectId,
    session_id: sessionId,
    generation_ordinal: 1,
    generation_id: generationId,
    producer_id: stableId('prod', `codex-hook:${projectId}`),
    revision: 0,
    state: 'starting',
    aliases: { native_conversation: rawSessionId },
    alias_bound: false,
    generations: [{ generation_id: generationId, ordinal: 1, state: 'starting' }],
  };
}

function generationHistory(record) {
  const existing = Array.isArray(record.generations) ? record.generations : [];
  const current = existing.find((generation) => generation.generation_id === record.generation_id);
  return current ? existing.map((generation) => ({ ...generation })) : [
    ...existing.map((generation) => ({ ...generation })),
    { generation_id: record.generation_id, ordinal: record.generation_ordinal, state: record.state },
  ];
}

function replaceCurrentGeneration(record, state, revision) {
  return generationHistory(record).map((generation) => generation.generation_id === record.generation_id
    ? { ...generation, state, revision, ...(state === 'ended' || state === 'errored' ? { terminal_at: generation.terminal_at ?? new Date().toISOString() } : {}) }
    : generation);
}

/** Persist a direct Codex callback as canonical inbox work, fail-open at the caller. */
export function recordCodexLifecycle({ home, projectPath, rawSessionId, event, model, threadId, resume = false }) {
  if (!home || !projectPath || !rawSessionId || !event) throw new Error('codex lifecycle identity is incomplete');
  const file = lifecyclePath(home);
  return withLock(file, () => {
    const registry = readLifecycle(file);
    const key = `${projectPath}\u0000${rawSessionId}`;
    const prior = registry.sessions[key];
    const record = prior
      ? { ...prior, aliases: { ...(prior.aliases ?? {}) }, generations: generationHistory(prior) }
      : initialRecord(projectPath, rawSessionId);
    const now = new Date().toISOString();
    const previousRevision = Number(record.revision ?? 0);
    const terminal = record.state === 'ended' || record.state === 'errored';
    const isStart = event === 'session-start';
    const isStop = event === 'stop';
    const resumed = isStart && terminal && resume === true;
    const resumedFromGenerationId = resumed ? record.generation_id : undefined;

    record.revision = previousRevision + 1;
    if (resumed) {
      const nextOrdinal = Math.max(...record.generations.map((generation) => Number(generation.ordinal) || 0), record.generation_ordinal) + 1;
      const generationId = stableId('gen', `codex-generation:${record.session_id}:${nextOrdinal}`);
      record.generations = replaceCurrentGeneration(record, record.state, previousRevision);
      record.generation_ordinal = nextOrdinal;
      record.generation_id = generationId;
      record.state = 'active';
      record.resumed_from_generation_id = resumedFromGenerationId;
      record.generations.push({
        generation_id: generationId,
        ordinal: nextOrdinal,
        state: 'active',
        revision: record.revision,
        resumed_from_generation_id: resumedFromGenerationId,
      });
    } else {
      const effectiveState = isStop ? 'ended' : (isStart && !terminal ? 'active' : record.state);
      record.state = effectiveState;
      record.generations = replaceCurrentGeneration(record, effectiveState, record.revision);
    }
    if (threadId && !record.alias_bound) {
      record.aliases = { ...record.aliases, native_conversation: threadId };
      record.alias_bound = true;
    }

    const effectiveEvent = isStart && terminal && !resumed ? 'stop' : event;
    const signals = [];
    if (isStart && previousRevision === 0) signals.push(projectSignal(record, now));
    signals.push(runtimeSignal({
      record,
      event: effectiveEvent,
      revision: record.revision,
      model,
      resumed,
      resumedFromGenerationId,
      observedAt: now,
    }));
    // Publication and durable lifecycle state are inside the same lock. An
    // envelope is linked before state commit; retrying an interrupted callback
    // republishes the identical event id rather than silently dropping it.
    const envelopePaths = signals.map((signal) => writeEnvelope(home, signal));
    registry.sessions[key] = record;
    writeAtomic(file, registry);
    return Object.freeze({ record, signals, envelopePaths, terminal: record.state === 'ended' || record.state === 'errored' });
  });
}
