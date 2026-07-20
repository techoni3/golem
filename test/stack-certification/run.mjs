import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureSource = join(currentDirectory, '..', 'fixtures', 'stack-certification');
const rowIds = [
  'typescript-7-reference-build',
  'typescript-6-fallback-build',
  'native-sqlite-wal-fk-restart',
  'fastify-zod-openapi-client',
  'fastify-websocket-resume',
  'vite-react-static-asset',
  'mcp-v1-isolated-render',
  'biome-check',
  'compiled-node-test'
];
const wantsJson = process.argv.includes('--json');
const keepTemporaryFiles = process.argv.includes('--keep');
export const INSTALL_TIMEOUT_MS = 180_000;
export const INSTALL_KILL_GRACE_MS = 5_000;
const outputLimit = 12_000;
let activeTemporaryRoot = null;
const activeChildren = new Set();
const esmRequireBridge = "import { createRequire as __golemCreateRequire } from 'node:module'; const require = __golemCreateRequire(import.meta.url);";

function appendTail(current, chunk) {
  const next = current + chunk;
  return next.length > outputLimit ? next.slice(-outputLimit) : next;
}

function terminateProcessGroup(child, signal) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function command(commandName, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(commandName, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    activeChildren.add(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timeoutTimer;
    let forceTimer;
    let finished = false;
    const startedAt = Date.now();
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceTimer);
      activeChildren.delete(child);
      resolve({
        command: [commandName, ...args].join(' '),
        stdout,
        stderr,
        elapsed_ms: Date.now() - startedAt,
        timed_out: timedOut,
        timeout_ms: options.timeoutMs ?? null,
        kill_grace_ms: options.killGraceMs ?? null,
        ...result,
      });
    };
    child.stdout.on('data', (chunk) => { stdout = appendTail(stdout, String(chunk)); });
    child.stderr.on('data', (chunk) => { stderr = appendTail(stderr, String(chunk)); });
    child.on('error', (error) => finish({ code: 1, signal: null, spawn_error: error.message }));
    child.on('close', (code, signal) => {
      finish({ code, signal, spawn_error: null });
    });
    if (options.timeoutMs) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminateProcessGroup(child, 'SIGTERM');
        forceTimer = setTimeout(() => terminateProcessGroup(child, 'SIGKILL'), options.killGraceMs ?? INSTALL_KILL_GRACE_MS);
      }, options.timeoutMs);
    }
  });
}

function summarizeFailure(error) {
  const message = error?.stack || error?.message || String(error);
  return message.replaceAll(/\s+/g, ' ').slice(0, 1000);
}

class CommandFailure extends Error {
  constructor(result) {
    super(`${result.command} exited ${result.code}${result.signal ? ` (${result.signal})` : ''}: ${result.stderr || result.stdout || result.spawn_error || 'no output'}`);
    this.details = {
      command: result.command,
      code: result.code,
      signal: result.signal,
      timed_out: result.timed_out,
      timeout_ms: result.timeout_ms,
      kill_grace_ms: result.kill_grace_ms,
      elapsed_ms: result.elapsed_ms,
      output_tail: (result.stderr || result.stdout || result.spawn_error || '').slice(-2_000),
    };
  }
}

function nodeIsTarget(nodeVersion) {
  const [major, minor] = nodeVersion.split('.').map(Number);
  return major === 24 && minor >= 18;
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function npmVersion() {
  const result = await command(process.env.STACK_CERTIFICATION_NPM_COMMAND || 'npm', ['--version']);
  if (result.code !== 0) throw new Error(`npm --version failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function emptyResult(npm) {
  return {
    schema_version: 1,
    overall: 'FAIL',
    platform: { os: process.platform, arch: process.arch },
    toolchain: { node: process.version, npm },
    target: {
      node: '>=24.18.0 <25',
      npm: '11.16.0',
      fixture: '@golem/stack-certification-fixture@0.0.0'
    },
    rows: [],
    platform_matrix: []
  };
}

function addGateFailures(result, reason) {
  for (const id of rowIds) result.rows.push({ id, status: 'FAIL', evidence: reason });
}

function updatePlatformMatrix(result) {
  const currentId = `${process.platform}-${process.arch}`;
  for (const architecture of ['arm64', 'x64']) {
    const id = `darwin-${architecture}`;
    result.platform_matrix.push({
      os: 'darwin',
      arch: architecture,
      status: id === currentId ? result.overall : 'UNMET',
      evidence: id === currentId
        ? `current platform result: ${result.overall}`
        : 'not executed on this architecture; release C4 gate remains required'
    });
  }
}

async function row(result, id, run) {
  try {
    const evidence = await run();
    result.rows.push({ id, status: 'PASS', evidence: typeof evidence === 'string' ? evidence : JSON.stringify(evidence), details: typeof evidence === 'object' ? evidence : undefined });
  } catch (error) {
    result.rows.push({ id, status: 'FAIL', evidence: summarizeFailure(error), details: error.details });
  }
}

function requireSuccess(result) {
  if (result.code !== 0) {
    throw new CommandFailure(result);
  }
  return result;
}

async function installFixture(fixtureRoot, env) {
  const npmCommand = process.env.STACK_CERTIFICATION_NPM_COMMAND || 'npm';
  const timeoutMs = Number(process.env.STACK_CERTIFICATION_TEST_INSTALL_TIMEOUT_MS || INSTALL_TIMEOUT_MS);
  const killGraceMs = Number(process.env.STACK_CERTIFICATION_TEST_KILL_GRACE_MS || INSTALL_KILL_GRACE_MS);
  const result = await command(npmCommand, ['install', '--no-audit', '--no-fund', '--install-strategy=nested'], {
    cwd: fixtureRoot,
    env: {
      ...env,
      // A clean cache must either resolve promptly or leave useful, bounded
      // evidence. The outer deadline remains the authority for all installs.
      npm_config_fetch_retries: '0',
      npm_config_fetch_timeout: '10000',
      npm_config_fetch_retry_mintimeout: '1000',
      npm_config_fetch_retry_maxtimeout: '1000',
      npm_config_fetch_retry_factor: '1',
      npm_config_ignore_scripts: 'false',
      npm_config_loglevel: 'verbose',
    },
    timeoutMs,
    killGraceMs,
  });
  return requireSuccess(result);
}

async function certifyDependencyTopology(fixtureRoot, env) {
  const rootCompiler = join(fixtureRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  const toolRoot = join(fixtureRoot, 'tools', 'openapi-codegen');
  const toolCompiler = join(toolRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  const generator = join(toolRoot, 'node_modules', 'openapi-typescript', 'bin', 'cli.js');
  assert(await exists(rootCompiler), 'root TypeScript compiler is missing');
  assert(await exists(toolCompiler), 'private codegen TypeScript compiler is missing');
  assert(await exists(generator), 'private codegen generator is missing');
  assert(!(await exists(join(fixtureRoot, 'node_modules', 'openapi-typescript'))), 'generator was hoisted into application dependencies');
  const root = requireSuccess(await command(process.execPath, [rootCompiler, '--version'], { cwd: fixtureRoot, env }));
  const tool = requireSuccess(await command(process.execPath, [toolCompiler, '--version'], { cwd: fixtureRoot, env }));
  const generatorVersion = requireSuccess(await command(process.execPath, [generator, '--version'], { cwd: fixtureRoot, env }));
  const tree = requireSuccess(await command('npm', ['ls', 'typescript', 'openapi-typescript', '--all'], { cwd: fixtureRoot, env }));
  assert.match(root.stdout, /Version 7\.0\.2/);
  assert.match(tool.stdout, /Version 5\.9\.3/);
  assert.match(generatorVersion.stdout, /v?7\.13\.0/);
  assert.doesNotMatch(`${tree.stdout}\n${tree.stderr}`, /invalid|peer dep missing/i);
  return {
    root_typescript: root.stdout.trim(),
    codegen_typescript: tool.stdout.trim(),
    openapi_typescript: generatorVersion.stdout.trim(),
    peer_tree: 'clean',
  };
}

async function certifyTypeScript(fixtureRoot, env, binary, force = false) {
  const args = [join(fixtureRoot, 'node_modules', binary, 'bin', 'tsc'), '-b'];
  if (force) args.push('--force');
  requireSuccess(await command(process.execPath, args, { cwd: fixtureRoot, env }));
  for (const filePath of [
    join(fixtureRoot, 'packages', 'contracts', 'dist', 'index.js'),
    join(fixtureRoot, 'packages', 'contracts', 'dist', 'index.d.ts'),
    join(fixtureRoot, 'packages', 'contracts', 'dist', 'index.js.map'),
    join(fixtureRoot, 'packages', 'app', 'dist', 'index.js'),
    join(fixtureRoot, 'packages', 'app', 'dist', 'index.d.ts')
  ]) assert(await exists(filePath), `TypeScript build omitted ${filePath}`);
  const runtime = requireSuccess(await command(process.execPath, ['runtime/verify-exports.mjs'], { cwd: fixtureRoot, env }));
  return { compiler: binary, runtime: runtime.stdout.trim() };
}

async function certifyNativeSqlite(fixtureRoot, temporaryRoot, env) {
  const databasePath = join(temporaryRoot, 'data', 'certification.sqlite');
  await mkdir(dirname(databasePath), { recursive: true });
  const result = requireSuccess(await command(process.execPath, ['--input-type=module', '--eval', `
    import { certifyNativeSqlite, verifyNativeSqliteRestart } from './runtime/native-sqlite.mjs';
    const first = certifyNativeSqlite(${JSON.stringify(databasePath)});
    const second = verifyNativeSqliteRestart(${JSON.stringify(databasePath)});
    process.stdout.write(JSON.stringify({ first, second }));
  `], { cwd: fixtureRoot, env }));
  return JSON.parse(result.stdout);
}

async function certifyContracts(fixtureRoot, temporaryRoot, env) {
  const generatedRoot = join(fixtureRoot, 'generated-contract');
  await mkdir(generatedRoot, { recursive: true });
  const result = requireSuccess(await command(process.execPath, ['--input-type=module', '--eval', `
    import { certifyContractBoundary } from './runtime/contract-server.mjs';
    const result = await certifyContractBoundary({ fixtureRoot: process.cwd(), generatedRoot: ${JSON.stringify(generatedRoot)}, env: process.env });
    process.stdout.write(JSON.stringify(result));
  `], { cwd: fixtureRoot, env }));
  return JSON.parse(result.stdout);
}

async function certifyWebsocket(fixtureRoot, temporaryRoot, env) {
  const generatedRoot = join(fixtureRoot, 'generated-websocket');
  await mkdir(generatedRoot, { recursive: true });
  const result = requireSuccess(await command(process.execPath, ['--input-type=module', '--eval', `
    import { certifyContractBoundary } from './runtime/contract-server.mjs';
    const result = await certifyContractBoundary({ fixtureRoot: process.cwd(), generatedRoot: ${JSON.stringify(generatedRoot)}, env: process.env });
    process.stdout.write(JSON.stringify({ websocket: result.websocket }));
  `], { cwd: fixtureRoot, env }));
  return JSON.parse(result.stdout);
}

async function certifyVite(fixtureRoot, env) {
  requireSuccess(await command(process.execPath, [
    join(fixtureRoot, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.config.mjs'
  ], { cwd: join(fixtureRoot, 'web'), env }));
  const distRoot = join(fixtureRoot, 'generated', 'vite-dist');
  const result = requireSuccess(await command(process.execPath, ['--input-type=module', '--eval', `
    import { certifyStaticAsset } from '../runtime/static-asset.mjs';
    const result = await certifyStaticAsset(${JSON.stringify(distRoot)});
    process.stdout.write(JSON.stringify(result));
  `], { cwd: join(fixtureRoot, 'web'), env }));
  return JSON.parse(result.stdout);
}

async function certifyMcpRender(fixtureRoot, temporaryRoot, env) {
  const renderRoot = join(temporaryRoot, 'isolated-mcp-render');
  await mkdir(renderRoot, { recursive: true });
  const esbuild = join(fixtureRoot, 'node_modules', 'esbuild', 'bin', 'esbuild');
  for (const [source, output] of [['mcp-server.mjs', 'server.mjs'], ['mcp-client.mjs', 'client.mjs']]) {
    requireSuccess(await command(esbuild, [
      join(fixtureRoot, 'runtime', source), '--bundle', '--format=esm', '--platform=node', '--target=node24', `--banner:js=${esmRequireBridge}`, `--outfile=${join(renderRoot, output)}`
    ], { cwd: fixtureRoot, env }));
  }
  assert(!(await exists(join(renderRoot, 'node_modules'))), 'render unexpectedly contains node_modules');
  assert(!(await exists(join(temporaryRoot, 'node_modules'))), 'render parent unexpectedly contains node_modules');
  const clientBundle = await readFile(join(renderRoot, 'client.mjs'), 'utf8');
  const serverBundle = await readFile(join(renderRoot, 'server.mjs'), 'utf8');
  assert(!clientBundle.includes(fixtureRoot) && !serverBundle.includes(fixtureRoot), 'render bundle leaked fixture source path');
  assert(clientBundle.includes('__golemCreateRequire') && serverBundle.includes('__golemCreateRequire'), 'render bundle omitted its ESM require bridge');
  const childEnv = { ...env, NODE_PATH: '' };
  const result = requireSuccess(await command(process.execPath, ['client.mjs', 'server.mjs'], { cwd: renderRoot, env: childEnv }));
  return JSON.parse(result.stdout);
}

async function certifyBiome(fixtureRoot, env) {
  const result = requireSuccess(await command(process.execPath, [
    join(fixtureRoot, 'node_modules', '@biomejs', 'biome', 'bin', 'biome'), 'check', '--formatter-enabled=false', '.'
  ], { cwd: fixtureRoot, env }));
  return result.stdout.trim() || 'biome check completed';
}

async function certifyNodeTest(fixtureRoot, env) {
  const result = requireSuccess(await command(process.execPath, ['--test', 'test/compiled.test.mjs'], { cwd: fixtureRoot, env }));
  assert.match(result.stdout, /pass 1/);
  return 'node --test compiled contract: pass 1';
}

function render(result) {
  if (wantsJson) return JSON.stringify(result);
  const lines = [
    `Golem stack certification: ${result.overall}`,
    `platform: ${result.platform.os}/${result.platform.arch}; Node ${result.toolchain.node}; npm ${result.toolchain.npm}`,
    `target: Node ${result.target.node}; npm ${result.target.npm}`
  ];
  for (const item of result.rows) lines.push(`${item.status.padEnd(4)} ${item.id} — ${item.evidence}`);
  for (const item of result.platform_matrix) lines.push(`${item.status.padEnd(5)} ${item.os}/${item.arch} — ${item.evidence}`);
  return lines.join('\n');
}

async function cleanupAfterSignal(signal) {
  for (const child of activeChildren) terminateProcessGroup(child, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, INSTALL_KILL_GRACE_MS));
  for (const child of activeChildren) terminateProcessGroup(child, 'SIGKILL');
  if (activeTemporaryRoot && !keepTemporaryFiles) {
    await rm(activeTemporaryRoot, { recursive: true, force: true });
    activeTemporaryRoot = null;
  }
  process.exit(signal === 'SIGINT' ? 130 : 143);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void cleanupAfterSignal(signal); });
}

async function main() {
  const npm = await npmVersion();
  const result = emptyResult(npm);
  const savedGolemHome = process.env.GOLEM_HOME;
  const gateReason = `requires Node >=24.18.0 <25 and npm 11.16.0; found Node ${process.version} and npm ${npm}`;
  if (!nodeIsTarget(process.versions.node) || npm !== '11.16.0') {
    addGateFailures(result, gateReason);
    updatePlatformMatrix(result);
    return result;
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'golem-stack-certification-'));
  const fixtureRoot = join(temporaryRoot, 'fixture');
  const temporaryHome = join(temporaryRoot, 'home');
  const temporaryGolemHome = join(temporaryRoot, 'golem-home');
  const temporaryXdg = join(temporaryRoot, 'xdg');
  const npmCache = join(temporaryRoot, 'npm-cache');
  const env = {
    ...process.env,
    HOME: temporaryHome,
    GOLEM_HOME: temporaryGolemHome,
    XDG_CONFIG_HOME: temporaryXdg,
    XDG_CACHE_HOME: temporaryXdg,
    npm_config_cache: npmCache,
    npm_config_userconfig: join(temporaryRoot, 'npmrc'),
    NO_UPDATE_NOTIFIER: '1'
  };
  activeTemporaryRoot = temporaryRoot;
  try {
    await Promise.all([mkdir(temporaryHome, { recursive: true }), mkdir(temporaryGolemHome, { recursive: true }), mkdir(temporaryXdg, { recursive: true })]);
    await cp(fixtureSource, fixtureRoot, { recursive: true });
    const install = await installFixture(fixtureRoot, env);
    assert.equal(process.env.GOLEM_HOME, savedGolemHome, 'probe mutated the caller GOLEM_HOME');
    await row(result, 'typescript-7-reference-build', async () => ({
      install: { elapsed_ms: install.elapsed_ms, timeout_ms: INSTALL_TIMEOUT_MS, timed_out: install.timed_out },
      topology: await certifyDependencyTopology(fixtureRoot, env),
      build: await certifyTypeScript(fixtureRoot, env, 'typescript'),
    }));
    await row(result, 'typescript-6-fallback-build', () => certifyTypeScript(fixtureRoot, env, 'typescript-6', true));
    await row(result, 'native-sqlite-wal-fk-restart', () => certifyNativeSqlite(fixtureRoot, temporaryRoot, env));
    await row(result, 'fastify-zod-openapi-client', () => certifyContracts(fixtureRoot, temporaryRoot, env));
    await row(result, 'fastify-websocket-resume', () => certifyWebsocket(fixtureRoot, temporaryRoot, env));
    await row(result, 'vite-react-static-asset', () => certifyVite(fixtureRoot, env));
    await row(result, 'mcp-v1-isolated-render', () => certifyMcpRender(fixtureRoot, temporaryRoot, env));
    await row(result, 'biome-check', () => certifyBiome(fixtureRoot, env));
    await row(result, 'compiled-node-test', () => certifyNodeTest(fixtureRoot, env));
  } catch (error) {
    const evidence = `fixture installation or setup failed: ${summarizeFailure(error)}`;
    const completed = new Set(result.rows.map((item) => item.id));
    for (const id of rowIds) if (!completed.has(id)) result.rows.push({ id, status: 'FAIL', evidence, details: error.details });
  } finally {
    if (!keepTemporaryFiles) await rm(temporaryRoot, { recursive: true, force: true });
    activeTemporaryRoot = null;
  }
  result.overall = result.rows.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL';
  updatePlatformMatrix(result);
  return result;
}

try {
  const result = await main();
  process.stdout.write(`${render(result)}\n`);
  if (result.overall !== 'PASS') process.exitCode = 1;
} catch (error) {
  const result = emptyResult('unavailable');
  addGateFailures(result, `probe failure: ${summarizeFailure(error)}`);
  updatePlatformMatrix(result);
  process.stdout.write(`${render(result)}\n`);
  process.exitCode = 1;
}
