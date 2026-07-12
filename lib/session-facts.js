import fs from 'node:fs';
import path from 'node:path';
import { endpointLeasesJsonPath, sessionFactsJsonPath } from './golem-home.js';

export const SESSION_FACTS_VERSION = 1;
export const ENDPOINT_LEASES_VERSION = 1;
export const DEFAULT_LEASE_TTL_MS = 45_000;

function iso(value = Date.now()) { return new Date(value).toISOString(); }
function ms(value) { const n = Date.parse(value || ''); return Number.isFinite(n) ? n : 0; }
function read(file, key, version) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { version, [key]: Array.isArray(value?.[key]) ? value[key] : [] };
  } catch { return { version, [key]: [] }; }
}
function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export function withRegistryLock(file, fn) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      fs.mkdirSync(lock);
      try { return fn(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.rmSync(lock, { recursive: true, force: true }); } catch {}
      const until = Date.now() + 20; while (Date.now() < until) {}
    }
  }
  throw new Error(`failed to acquire ${lock}`);
}

export function readSessionFacts({ file = sessionFactsJsonPath() } = {}) {
  return read(file, 'facts', SESSION_FACTS_VERSION).facts;
}

// Immutable canonical identity/continuation ownership wins over later locators.
// Mutable observations advance only by revision, then observed_at.
export function upsertSessionFact(input, { file = sessionFactsJsonPath(), now = Date.now() } = {}) {
  if (!input?.canonical_id || !input?.harness || !input?.locator?.raw_session_id) throw new Error('canonical_id, harness and locator.raw_session_id are required');
  return withRegistryLock(file, () => {
    const registry = read(file, 'facts', SESSION_FACTS_VERSION);
    const index = registry.facts.findIndex((fact) => fact.canonical_id === input.canonical_id);
    const previous = index >= 0 ? registry.facts[index] : null;
    const incomingRevision = Number(input.revision ?? (previous?.revision ?? 0) + 1);
    const observedAt = input.observed_at || iso(now);
    const advances = !previous || incomingRevision > Number(previous.revision || 0)
      || (incomingRevision === Number(previous.revision || 0) && ms(observedAt) >= ms(previous.observed_at));
    const fact = previous ? {
      ...previous,
      ...(advances ? input : {}),
      canonical_id: previous.canonical_id,
      continuation_key: previous.continuation_key ?? input.continuation_key ?? null,
      harness: previous.harness,
      locator: advances ? input.locator : previous.locator,
      revision: advances ? incomingRevision : previous.revision,
      observed_at: advances ? observedAt : previous.observed_at,
    } : { ...input, continuation_key: input.continuation_key ?? null, revision: incomingRevision, observed_at: observedAt };
    if (index >= 0) registry.facts[index] = fact; else registry.facts.push(fact);
    atomicWrite(file, registry);
    return fact;
  });
}

export function readEndpointLeases({ file = endpointLeasesJsonPath(), now = Date.now(), includeExpired = false } = {}) {
  const leases = read(file, 'leases', ENDPOINT_LEASES_VERSION).leases;
  return includeExpired ? leases : leases.filter((lease) => ms(lease.expires_at) > now);
}
export function renewEndpointLease(input, { file = endpointLeasesJsonPath(), now = Date.now(), ttlMs = DEFAULT_LEASE_TTL_MS } = {}) {
  if (!input?.canonical_id || !input?.host || !input?.port || !input?.owner_token) throw new Error('canonical_id, host, port and owner_token are required');
  return withRegistryLock(file, () => {
    const registry = read(file, 'leases', ENDPOINT_LEASES_VERSION);
    const lease = { ...input, renewed_at: iso(now), expires_at: iso(now + ttlMs) };
    const index = registry.leases.findIndex((row) => row.canonical_id === input.canonical_id && row.owner_token === input.owner_token);
    if (index >= 0) registry.leases[index] = lease; else registry.leases.push(lease);
    atomicWrite(file, registry);
    return lease;
  });
}
export function releaseEndpointLeases(ownerToken, { file = endpointLeasesJsonPath(), canonicalId = null } = {}) {
  return withRegistryLock(file, () => {
    const registry = read(file, 'leases', ENDPOINT_LEASES_VERSION);
    registry.leases = registry.leases.filter((lease) => lease.owner_token !== ownerToken || (canonicalId && lease.canonical_id !== canonicalId));
    atomicWrite(file, registry);
  });
}
