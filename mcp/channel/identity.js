import fs from 'node:fs';
import path from 'node:path';

function pidAlive(pid) {
  if (!pid || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function liveBridgesForParent({ home, parentPid = process.ppid }) {
  try {
    const file = path.join(home, 'opencode-bridges.json');
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const bridges = Array.isArray(json?.bridges) ? json.bridges : [];
    return bridges.filter((bridge) => (
      bridge && bridge.session_id &&
      Number(bridge.opencode_pid) === Number(parentPid) &&
      (!bridge.pid || pidAlive(bridge.pid))
    ));
  } catch {
    return [];
  }
}

/**
 * Resolve the caller for one MCP invocation. A shared opencode MCP cannot
 * infer which sibling called, so ambiguity is an error, never a newest-row
 * guess. Injected ids share the shim's local-plugin trust boundary.
 */
export function resolveCallerSessionId({ injectedId, home, parentPid } = {}) {
  if (typeof injectedId === 'string' && injectedId.trim()) {
    return { sessionId: injectedId.trim(), source: 'injected' };
  }
  const candidates = liveBridgesForParent({ home, parentPid });
  if (candidates.length === 1) {
    return { sessionId: candidates[0].session_id, source: 'single_bridge' };
  }
  if (candidates.length > 1) {
    return {
      sessionId: null,
      error: `golem: cannot determine which session is calling (${candidates.length} sibling sessions share this opencode server, no caller id injected); refusing to write. Restart this opencode session, or upgrade the golem plugin.`,
    };
  }
  return {
    sessionId: null,
    error: 'golem: cannot determine which session is calling (no live opencode bridge row, no caller id injected); refusing to write. Restart this opencode session, or upgrade the golem plugin.',
  };
}

/**
 * Sibling bridge rows share one endpoint, so newest is valid only for endpoint
 * delivery. It must never be used to choose a caller identity.
 */
export function bridgeEndpointForParent({ home, parentPid } = {}) {
  const candidates = liveBridgesForParent({ home, parentPid })
    .filter((bridge) => bridge.host && bridge.port)
    .sort((a, b) => Date.parse(b.updated_at || b.started_at || 0) - Date.parse(a.updated_at || a.started_at || 0));
  return candidates[0] || null;
}
