import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = 1;
const INBOX_VERSION = 'golem.runtime-signal/v1';

function uuid(seed) {
  const digest = crypto.createHash('sha256').update(seed).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
function stableId(prefix, seed) {
  return `${prefix}_${uuid(seed)}`;
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

function runtimeSignal({ record, event, revision, model, resumed, observedAt }) {
  const sourceObservedAt = observedAt || new Date().toISOString();
  const generation = {
    project_id: record.project_id,
    session_id: record.session_id,
    generation_id: record.generation_id,
  };
  const eventKind = event === 'session-start'
    ? 'session.started'
    : event === 'stop'
      ? 'session.ended'
      : event === 'subagent-stop'
        ? 'session.idle'
        : 'session.activity';
  const payload = eventKind === 'session.started'
    ? { kind: eventKind, generation, metadata: { ...(model ? { model } : {}), ...(resumed ? { resumed: true } : {}) } }
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

function ensureRecord({ home, projectPath, rawSessionId }) {
  const file = lifecyclePath(home);
  return withLock(file, () => {
    const registry = readLifecycle(file);
    const key = `${projectPath}\u0000${rawSessionId}`;
    let record = registry.sessions[key];
    if (!record) {
      const projectId = stableId('prj', `codex-project:${projectPath}`);
      const sessionId = stableId('ses', `codex-session:${projectId}:${rawSessionId}`);
      record = {
        project_path: projectPath,
        raw_session_id: rawSessionId,
        project_id: projectId,
        session_id: sessionId,
        generation_ordinal: 1,
        generation_id: stableId('gen', `codex-generation:${sessionId}:1`),
        producer_id: stableId('prod', `codex-hook:${projectId}`),
        revision: 0,
        state: 'starting',
        aliases: { native_conversation: rawSessionId },
      };
    }
    return { file, registry, key, record };
  });
}

/** Persist a direct Codex callback as canonical inbox work, fail-open at the caller. */
export function recordCodexLifecycle({ home, projectPath, rawSessionId, event, model, threadId }) {
  if (!home || !projectPath || !rawSessionId || !event) throw new Error('codex lifecycle identity is incomplete');
  const now = new Date().toISOString();
  const prepared = ensureRecord({ home, projectPath, rawSessionId });
  const record = { ...prepared.record };
  const terminal = record.state === 'ended' || record.state === 'errored';
  const isStart = event === 'session-start';
  const isStop = event === 'stop';
  const effectiveEvent = isStart && terminal ? 'stop' : event;
  record.revision += 1;
  record.state = isStop ? 'ended' : (isStart ? (terminal ? record.state : 'active') : record.state);
  if (threadId) record.aliases = { ...record.aliases, native_conversation: threadId };
  const signals = [];
  if (isStart && prepared.record.revision === 0) signals.push(projectSignal(record, now));
  signals.push(runtimeSignal({
    record,
    event: effectiveEvent,
    revision: record.revision,
    model,
    resumed: isStart && prepared.record.revision > 0 && !terminal,
    observedAt: now,
  }));
  const envelopePaths = signals.map((signal) => writeEnvelope(home, signal));
  withLock(prepared.file, () => {
    const latest = readLifecycle(prepared.file);
    latest.sessions[prepared.key] = record;
    writeAtomic(prepared.file, latest);
  });
  return Object.freeze({ record, signals, envelopePaths, terminal: record.state === 'ended' || record.state === 'errored' });
}
