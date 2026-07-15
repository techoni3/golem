import fs from 'node:fs';
import path from 'node:path';

/**
 * A managed Codex supervisor launches one private MCP child for one canonical
 * Golem session. Unlike the shared OpenCode server, there is no trusted shim
 * invocation boundary carrying a per-call id. Its process environment is the
 * binding. Keep the marker separate from GOLEM_CEO_SESSION_ID: ordinary CC
 * launchers also set that variable and must retain their existing behaviour.
 */
export function managedCodexBinding(env = process.env) {
  if (env.GOLEM_MANAGED_CODEX_BOUND !== '1') return { enabled: false, sessionId: null };
  const sessionId = typeof env.GOLEM_MANAGED_CODEX_BOUND_SESSION_ID === 'string'
    ? env.GOLEM_MANAGED_CODEX_BOUND_SESSION_ID.trim()
    : '';
  if (!sessionId) {
    return {
      enabled: true,
      sessionId: null,
      error: 'golem: managed Codex MCP has no supervisor-owned canonical session binding; refusing the tool call.',
    };
  }
  const ambient = typeof env.GOLEM_CEO_SESSION_ID === 'string' ? env.GOLEM_CEO_SESSION_ID.trim() : '';
  if (ambient && ambient !== sessionId) {
    return {
      enabled: true,
      sessionId: null,
      error: 'golem: managed Codex MCP binding conflicts with GOLEM_CEO_SESSION_ID; refusing the tool call.',
    };
  }
  return { enabled: true, sessionId };
}

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

/** Live top-level session bridge rows for this shared opencode server. */
export function sessionsForParent({ home, parentPid } = {}) {
  return liveBridgesForParent({ home, parentPid });
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
