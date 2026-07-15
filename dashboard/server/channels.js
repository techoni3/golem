// Channel registry reader (v4). The channel server spawned by each Claude Code
// session registers itself under ~/.config/golem/channels.json. This module
// exposes just the live-channel passthrough that the rest of the dashboard needs
// after the v3 orchestrator was removed.

import fs from 'node:fs/promises';
import { channelsJsonPath } from '../../lib/golem-home.js';
import { readEndpointLeases } from '../../lib/session-facts.js';

const CHANNELS_REGISTRY = channelsJsonPath();

// A `delivery_ready:false` lease is meaningful only for the managed Codex
// adapter: it means its required bound MCP or idle App Server turn is not
// available. Legacy CC/OC registrations predate the field and retain their
// historical channel-presence semantics.
export function isChannelDeliveryReady(channel) {
  if (!channel) return false;
  return channel.kind !== 'codex-supervisor' || channel.delivery_ready === true;
}

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

// Endpoint owner tokens authenticate loopback delivery. Dashboard internals need
// the token to call a typed supervisor adapter, but channel rows are also sent
// to browser clients. Keep it non-enumerable so JSON/API broadcasts never turn
// a local lease credential into UI data.
function withPrivateOwnerToken(channel, ownerToken) {
  if (ownerToken) Object.defineProperty(channel, 'owner_token', {
    value: ownerToken,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return channel;
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
      if (!(response.ok && body?.canonical_id === lease.canonical_id && body?.owner_token === lease.owner_token)) return null;
      const { owner_token, ...publicLease } = lease;
      return withPrivateOwnerToken({
          ...publicLease,
          session_id: lease.canonical_id,
          url: `http://${lease.host}:${lease.port}`,
          endpoint_health: 'healthy',
          // Existing channel registrations predate this field and remain
          // delivery-capable. A managed Codex supervisor sets the field only
          // after its typed target adapter and required MCP are both ready.
          // The authenticated health response is newer than the persisted
          // heartbeat lease. Use its live dispatch gate so a just-started or
          // just-completed Codex turn does not spend up to one lease interval
          // displayed/routed in the opposite state.
          delivery_ready: lease.kind === 'codex-supervisor'
            ? body.delivery_ready === true
            : lease.delivery_ready !== false,
        }, owner_token);
    } catch { return null; } finally { clearTimeout(timer); }
  }))).filter(Boolean);
  const channels = await readRegistry(CHANNELS_REGISTRY, 'channels');
  const canonicalIds = new Set(leases.map((lease) => lease.canonical_id));
  const legacy = channels
    .filter((c) => !canonicalIds.has(c.session_id))
    .filter((c) => pidAlive(c.pid))
    .map((c) => ({ ...c, url: `http://${c.host}:${c.port}`, endpoint_health: 'legacy-pid-only', delivery_ready: c.delivery_ready !== false }));
  return [...healthy, ...legacy];
}
