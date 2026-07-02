// Channel registry reader (v4). The channel server spawned by each Claude Code
// session registers itself under ~/.config/golem/channels.json. This module
// exposes just the live-channel passthrough that the rest of the dashboard needs
// after the v3 orchestrator was removed.

import fs from 'node:fs/promises';
import { channelsJsonPath } from '../../lib/golem-home.js';

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
  const channels = await readRegistry(CHANNELS_REGISTRY, 'channels');
  return channels
    .filter((c) => pidAlive(c.pid))
    .map((c) => ({ ...c, url: `http://${c.host}:${c.port}` }));
}
