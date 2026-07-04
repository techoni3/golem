import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { golemHome } from './golem-home.js';

export const EXTERNAL_TOOLS = {
  aiderRepomap: {
    name: 'aiderRepomap',
    kind: 'python',
    package: 'aider-chat',
    pinnedVersion: '0.86.2',
    timeout_ms: 30_000,
    output: 'text',
    healthcheck: ['python', '-c', 'import aider.repomap; print("ok")'],
  },
};

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(text) {
  return String(text || '').replace(ANSI_RE, '');
}

function commandExists(name) {
  return spawnSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' }).status === 0;
}

function logPath() {
  return path.join(golemHome(), 'logs', 'ext-tools.log');
}

function appendToolLog(entry) {
  const file = logPath();
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

export function resolvePythonRunner() {
  if (commandExists('uvx')) return { name: 'uvx', offline: true };
  if (commandExists('pipx')) return { name: 'pipx', offline: false };
  return null;
}

function toolSpec(tool) {
  return `${tool.package}==${tool.pinnedVersion}`;
}

function buildCommand(tool, runner, argv) {
  if (runner.name === 'uvx') return ['uvx', '--offline', '--from', toolSpec(tool), ...argv];
  return ['pipx', 'run', '--spec', toolSpec(tool), ...argv];
}

export function runExternalTool(name, { argv = [], input = null, cwd = process.cwd(), timeout_ms = null, env = {} } = {}) {
  const tool = EXTERNAL_TOOLS[name];
  if (!tool) throw new Error(`unknown external tool: ${name}`);
  const runner = resolvePythonRunner();
  if (!runner) {
    throw new Error(`external tool ${name} needs uvx or pipx on PATH; install uv (recommended) or pipx, then run golem doctor`);
  }
  const [cmd, ...args] = buildCommand(tool, runner, argv);
  const started = Date.now();
  const res = spawnSync(cmd, args, {
    cwd,
    input,
    encoding: 'utf8',
    timeout: timeout_ms ?? tool.timeout_ms,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      NO_COLOR: '1',
      ...(runner.name === 'uvx' ? { UV_OFFLINE: '1' } : {}),
      ...env,
    },
  });
  const elapsed_ms = Date.now() - started;
  const stdout = stripAnsi(res.stdout || '');
  const stderr = stripAnsi(res.stderr || '');
  appendToolLog({ name, runner: runner.name, cmd, args, cwd, status: res.status, signal: res.signal, elapsed_ms, stdout, stderr, error: res.error?.message });
  if (res.error?.code === 'ETIMEDOUT' || res.signal) {
    throw new Error(`${name} timed out after ${elapsed_ms}ms; see ${logPath()}`);
  }
  if (res.error) throw new Error(`${name} failed to start via ${runner.name}: ${res.error.message}`);
  if (res.status !== 0) {
    const detail = (stderr || stdout || `exit ${res.status}`).trim().split('\n').slice(-8).join('\n');
    throw new Error(`${name} failed via ${runner.name}: ${detail}\nInstall/cache it with: uvx --from ${toolSpec(tool)} python -c "import aider.repomap"`);
  }
  return { stdout, stderr, elapsed_ms, runner: runner.name, package: tool.package, pinnedVersion: tool.pinnedVersion };
}

export function doctorExternalTools() {
  const runner = resolvePythonRunner();
  return Object.values(EXTERNAL_TOOLS).map((tool) => {
    if (!runner) return { name: tool.name, ok: false, runner: null, message: 'uvx/pipx not found on PATH' };
    try {
      const res = runExternalTool(tool.name, { argv: tool.healthcheck, timeout_ms: 10_000 });
      return { name: tool.name, ok: true, runner: res.runner, package: tool.package, pinnedVersion: tool.pinnedVersion, message: `${tool.package}==${tool.pinnedVersion}` };
    } catch (e) {
      return { name: tool.name, ok: false, runner: runner.name, package: tool.package, pinnedVersion: tool.pinnedVersion, message: e.message };
    }
  });
}
