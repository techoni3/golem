import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.join(HERE, 'golem-tmux.conf');
const DEFAULT_SOCKET = 'golem';

function tmuxBinary() {
  return process.env.GOLEM_TMUX_BIN || 'tmux';
}

function tmuxSocket() {
  return process.env.GOLEM_TMUX_SOCKET || DEFAULT_SOCKET;
}

function tmuxConfig() {
  return process.env.GOLEM_TMUX_CONFIG || DEFAULT_CONFIG;
}

function globalArgs() {
  return ['-L', tmuxSocket(), '-f', tmuxConfig()];
}

function formatFailure(result, args) {
  const detail = String(result.stderr || result.stdout || '').trim();
  return `tmux ${args.join(' ')} failed${detail ? `: ${detail}` : ` (exit ${result.status ?? 'unknown'})`}`;
}

function runTmux(args, { allowFailure = false } = {}) {
  const result = spawnSync(tmuxBinary(), [...globalArgs(), ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) {
    if (allowFailure && result.error.code === 'ENOENT') return result;
    throw new Error(`could not run tmux: ${result.error.message}`, { cause: result.error });
  }
  if (!allowFailure && result.status !== 0) throw new Error(formatFailure(result, args));
  return result;
}

function requireName(name) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('tmux session name is required');
  return name.trim();
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Create one detached, fixed-size worker pty. */
export function newSession({ name, cwd, command, width = 200, height = 50 } = {}) {
  const session = requireName(name);
  if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('tmux session cwd is required');
  if (!Array.isArray(command) || command.length === 0) throw new Error('tmux session command is required');
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new Error('tmux session dimensions must be positive integers');
  }
  const commandText = `exec ${command.map(shellQuote).join(' ')}`;
  runTmux([
    'new-session', '-d', '-s', session,
    '-x', String(width), '-y', String(height),
    '-c', cwd,
    commandText,
  ]);
  return { name: session, cwd, width, height };
}

/** Return the pane's process id. The launcher is exec'd so this is its pgid. */
export function panePid(name) {
  const session = requireName(name);
  const result = runTmux(['display-message', '-p', '-t', session, '#{pane_pid}']);
  const pid = Number.parseInt(String(result.stdout).trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`tmux did not report a valid pane pid for ${session}`);
  return pid;
}

export function listSessions() {
  const result = runTmux([
    'list-sessions',
    '-F',
    '#{session_name}\t#{session_id}\t#{session_windows}\t#{session_created}',
  ], { allowFailure: true });
  if (result.error || result.status !== 0) return [];
  return String(result.stdout || '').split('\n').filter(Boolean).map((line) => {
    const [name, id, windows, created] = line.split('\t');
    return {
      name,
      id: id || null,
      windows: Number.isFinite(Number(windows)) ? Number(windows) : null,
      created_at: created ? new Date(Number(created) * 1000).toISOString() : null,
    };
  });
}

export function hasSession(name) {
  const session = requireName(name);
  return listSessions().some((row) => row.name === session);
}

/** Capture scrollback without attaching or sending input to the worker. */
export function capturePane(name, lines = null) {
  const session = requireName(name);
  const args = ['capture-pane', '-p', '-t', session];
  if (lines != null) {
    if (!Number.isInteger(lines) || lines < 1) throw new Error('peek lines must be a positive integer');
    args.push('-S', `-${lines}`);
  }
  return runTmux(args).stdout;
}

/** Attach the caller's terminal to a worker's real tmux TUI. */
export function attachSession(name) {
  const session = requireName(name);
  const result = spawnSync(tmuxBinary(), [...globalArgs(), 'attach-session', '-t', session], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw new Error(`could not attach tmux session ${session}: ${result.error.message}`, { cause: result.error });
  return result.status ?? 1;
}

/** Stop the tmux session. Missing sessions are already stopped. */
export function killSession(name) {
  const session = requireName(name);
  const result = runTmux(['kill-session', '-t', session], { allowFailure: true });
  if (result.error?.code === 'ENOENT') throw new Error(`could not run tmux: ${result.error.message}`, { cause: result.error });
  if (result.status === 0) return true;
  const detail = String(result.stderr || '').toLowerCase();
  if (/no server running|session not found|can't find session|unknown session/.test(detail)) return false;
  throw new Error(formatFailure(result, ['kill-session', '-t', session]));
}

export function processIdsInGroup(pgid) {
  const group = Number(pgid);
  if (!Number.isInteger(group) || group <= 0) return [];
  const result = spawnSync(process.env.GOLEM_PS_BIN || 'ps', ['-axo', 'pid=,pgid='], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`could not inspect process group ${group}: ${result.error?.message || String(result.stderr || '').trim() || `ps exited ${result.status}`}`);
  }
  return String(result.stdout || '').split('\n').map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    return match ? { pid: Number(match[1]), pgid: Number(match[2]) } : null;
  }).filter((row) => row?.pgid === group).map((row) => row.pid);
}

export function signalProcessGroup(pgid, signal) {
  const group = Number(pgid);
  if (!Number.isInteger(group) || group <= 1) return false;
  try {
    process.kill(-group, signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

export async function terminateProcessGroup(pgid, {
  termGraceMs = 500,
  killGraceMs = 1000,
  pollMs = 25,
} = {}) {
  const waitUntilEmpty = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let survivors = processIdsInGroup(pgid);
    while (survivors.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      survivors = processIdsInGroup(pgid);
    }
    return survivors;
  };

  let survivors = processIdsInGroup(pgid);
  // Keep the teardown sequence explicit even when tmux already reaped the
  // pane: the required order is kill-session, TERM the recorded group, then
  // KILL any survivors, followed by a fresh ps verification.
  signalProcessGroup(pgid, 'SIGTERM');
  if (survivors.length) survivors = await waitUntilEmpty(termGraceMs);
  if (survivors.length) {
    signalProcessGroup(pgid, 'SIGKILL');
    survivors = await waitUntilEmpty(killGraceMs);
  }
  return survivors;
}

export const tmuxDriver = Object.freeze({
  newSession,
  panePid,
  listSessions,
  hasSession,
  capturePane,
  attachSession,
  killSession,
  processIdsInGroup,
  signalProcessGroup,
  terminateProcessGroup,
});
