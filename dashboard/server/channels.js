// Channel registry reader (v4). The channel server spawned by each Claude Code
// session registers itself under ~/.config/golem/channels.json. This module
// exposes just the live-channel passthrough that the rest of the dashboard needs
// after the v3 orchestrator was removed.

import fs from 'node:fs/promises';
import { channelsJsonPath } from '../../lib/golem-home.js';
import { readEndpointLeases } from '../../lib/session-facts.js';

const CHANNELS_REGISTRY = channelsJsonPath();

function pidAlive(pid) {
  if (!pid || pid === 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but is owned by another user — treat as alive.
    return err && err.code === 'EPERM';
  }
}

async function readRegistry(file, listKey) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  try {
    const json = JSON.parse(raw);
    return Array.isArray(json[listKey]) ? json[listKey] : [];
  } catch (err) {
    console.error('[channels] failed to parse', file, err.message);
    return [];
  }
}

/** Return live channel registrations with a computed `url`. */
export async function readChannels() {
  const leases = readEndpointLeases();
  const healthy = (await Promise.all(leases.map(async (lease) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300);
    try {
      const query = new URLSearchParams({ session_id: lease.canonical_id, owner_token: lease.owner_token });
      const response = await fetch(`http://${lease.host}:${lease.port}/healthz?${query}`, { signal: controller.signal });
      const body = response.ok ? await response.json() : null;
      return response.ok && body?.canonical_id === lease.canonical_id && body?.owner_token === lease.owner_token
        ? { ...lease, session_id: lease.canonical_id, url: `http://${lease.host}:${lease.port}`, endpoint_health: 'healthy' }
        : null;
    } catch { return null; } finally { clearTimeout(timer); }
  }))).filter(Boolean);
  const channels = await readRegistry(CHANNELS_REGISTRY, 'channels');
  const canonicalIds = new Set(leases.map((lease) => lease.canonical_id));
  const legacy = channels
    .filter((c) => !canonicalIds.has(c.session_id))
    .filter((c) => pidAlive(c.pid))
    .map((c) => ({ ...c, url: `http://${c.host}:${c.port}`, endpoint_health: 'legacy-pid-only' }));
  return [...healthy, ...legacy];
}
