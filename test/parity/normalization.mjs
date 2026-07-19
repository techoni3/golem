import assert from 'node:assert/strict';

const ISO_TIMESTAMP = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const ABSOLUTE_PATH = /(?:\/Users\/[^\s"']+|\/private\/[^\s"']+|\/tmp\/[^\s"']+|\/var\/folders\/[^\s"']+|\/home\/[^\s"']+)/g;
const URL_PORT = /\b(https?:\/\/[^\s/:]+):\d{2,5}\b/g;
const SECRET_VALUE = /\b(?:sk|ghp|xoxb)-[-_A-Za-z0-9]{6,}\b|\bBearer\s+[-_A-Za-z0-9.]{6,}\b/gi;
const SECRET_KEY = /(?:api[_-]?key|authorization|credential|cookie|owner[_-]?token|password|secret|token)/i;
const PID_KEY = /(?:^|_)(?:pid|ppid|process_id)$/i;
const PORT_KEY = /(?:^|_)(?:port)$/i;
const TIMESTAMP_KEY = /(?:^|_)(?:created|updated|observed|started|ended|received|materialized|last_seen|last_activity|heartbeat)_at$|^timestamp$/i;
const UNORDERED_ARRAY_KEYS = new Set(['capabilities', 'labels', 'roles', 'scopes', 'tags']);

function placeholder(state, kind, value) {
  const key = `${kind}:${String(value)}`;
  if (!state.placeholders.has(key)) state.placeholders.set(key, `$${kind}_${state.counts[kind]++}`);
  return state.placeholders.get(key);
}

function normalizeString(value, state) {
  let normalized = value.replace(SECRET_VALUE, '$REDACTED');
  normalized = normalized.replace(URL_PORT, (_match, origin) => `${origin}:${placeholder(state, 'PORT', _match)}`);
  normalized = normalized.replace(ABSOLUTE_PATH, (match) => placeholder(state, 'PATH', match));
  normalized = normalized.replace(ISO_TIMESTAMP, '$TIMESTAMP');
  normalized = normalized.replace(UUID, (match) => placeholder(state, 'UUID', match.toLowerCase()));
  return normalized;
}

function normalizeValue(value, state, key = '') {
  if (SECRET_KEY.test(key)) return '$REDACTED';
  if (TIMESTAMP_KEY.test(key)) return '$TIMESTAMP';
  if (typeof value === 'string' && PID_KEY.test(key)) return placeholder(state, 'PID', value);
  if (typeof value === 'string' && PORT_KEY.test(key)) return placeholder(state, 'PORT', value);
  if (typeof value === 'string') return normalizeString(value, state);
  if (typeof value === 'number' && PID_KEY.test(key)) return placeholder(state, 'PID', value);
  if (typeof value === 'number' && PORT_KEY.test(key)) return placeholder(state, 'PORT', value);
  if (Array.isArray(value)) {
    const normalized = value.map((entry) => normalizeValue(entry, state));
    return UNORDERED_ARRAY_KEYS.has(key)
      ? normalized.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
      : normalized;
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((childKey) => [
    childKey,
    normalizeValue(value[childKey], state, childKey),
  ]));
}

/**
 * Produce a deterministic comparison projection without hiding semantic array order,
 * readiness state, lifecycle state, or identifier equality relationships.
 */
export function normalizeLegacyObservation(observation) {
  const state = {
    placeholders: new Map(),
    counts: { PATH: 1, PID: 1, PORT: 1, UUID: 1 },
  };
  return normalizeValue(observation, state);
}

export function stableProjectionJson(observation) {
  return `${JSON.stringify(normalizeLegacyObservation(observation), null, 2)}\n`;
}

/**
 * Reusable adapter for future legacy-versus-typed parity checks. Callers receive both
 * normalized projections so a mismatch can be reported without exposing raw data.
 */
export function compareParityProjection(legacy, replacement) {
  const expected = normalizeLegacyObservation(legacy);
  const actual = normalizeLegacyObservation(replacement);
  return {
    equal: JSON.stringify(expected) === JSON.stringify(actual),
    expected,
    actual,
  };
}

export function assertNormalizationContract() {
  const raw = {
    endpoint: 'http://127.0.0.1:48123/api/health',
    observed_at: '2026-07-20T12:34:56.789Z',
    started_at: 1_721_477_696_789,
    pid: 9876,
    service_port: '48123',
    project_path: '/Users/alice/work/golem',
    session_id: 'ses_11111111-1111-4111-8111-111111111111',
    duplicate_session_id: 'ses_11111111-1111-4111-8111-111111111111',
    owner_token: 'secret-owner-token',
    diagnostic: 'Bearer abcdefghijklmnop',
    readiness: 'pull_only',
    queue: ['first', 'second'],
    labels: ['zeta', 'alpha'],
  };
  const normalized = normalizeLegacyObservation(raw);
  assert.equal(normalized.observed_at, '$TIMESTAMP');
  assert.equal(normalized.started_at, '$TIMESTAMP');
  assert.equal(normalized.pid, '$PID_1');
  assert.equal(normalized.service_port, '$PORT_2');
  assert.equal(normalized.project_path, '$PATH_1');
  assert.equal(normalized.owner_token, '$REDACTED');
  assert.equal(normalized.diagnostic, '$REDACTED');
  assert.equal(normalized.readiness, 'pull_only');
  assert.deepEqual(normalized.queue, ['first', 'second'], 'semantic sequence order is retained');
  assert.deepEqual(normalized.labels, ['alpha', 'zeta'], 'declared unordered collections are stable');
  assert.equal(normalized.session_id, normalized.duplicate_session_id, 'semantic identity equality is retained');
  assert.equal(normalized.endpoint, 'http://127.0.0.1:$PORT_1/api/health');
  return normalized;
}
