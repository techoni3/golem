import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectIdFor } from '../lib/project-id.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-codex-'));
const home = path.join(temp, 'home');
const state = path.join(temp, 'state');
const env = { ...process.env, HOME: home, GOLEM_HOME: state, XDG_CONFIG_HOME: path.join(temp, 'xdg') };
async function mcpInitialize(transport, plugin) {
  const childEnv = { ...env, ...(transport.env ?? {}) };
  for (const key of ['GOLEM_CEO_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'OPENCODE_SESSION_ID', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'PI_SESSION_ID']) delete childEnv[key];
  const child = spawn(transport.command, transport.args, { cwd: path.resolve(plugin, transport.cwd), env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const replies = [];
  let errors = '';
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { errors += chunk; });
  child.stdout.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) if (line.trim()) replies.push(JSON.parse(line));
  });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'golem-test', version: '1' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !replies.some((reply) => reply.id === 2)) await new Promise((resolve) => setTimeout(resolve, 25));
  child.stdin.end();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1000))]);
  if (child.exitCode === null) child.kill();
  assert.ok(replies.find((reply) => reply.id === 1)?.result?.serverInfo, `bundled MCP initializes: ${JSON.stringify(replies)} stderr=${errors}`);
  assert.ok(replies.find((reply) => reply.id === 2)?.result?.tools?.some((tool) => tool.name === 'ticket_list'), `bundled MCP lists tracker tools: ${JSON.stringify(replies)}`);
}
try {
  execFileSync(process.execPath, [path.join(repo, 'cli/golem.js'), 'sync', '--target', 'codex'], { cwd: repo, env });
  assert.equal(fs.existsSync(path.join(home, '.codex')), false, 'render must not mutate user Codex state');
  const root = path.join(state, 'renders', 'codex');
  const plugin = path.join(root, 'plugins', 'golem');
  assert.ok(fs.existsSync(path.join(plugin, 'lib', 'session-registry.js')), 'Codex render includes the registry helper');
  assert.ok(fs.existsSync(path.join(plugin, 'lib', 'project-id.js')), 'Codex render includes the shared project identity contract');
  const caps = JSON.parse(fs.readFileSync(path.join(plugin, 'capabilities.json')));
  assert.deepEqual(caps.delivery, ['pull']);
  assert.equal(caps.push_delivery, false);
  const hooks = JSON.parse(fs.readFileSync(path.join(plugin, 'hooks/hooks.json'))).hooks;
  assert.deepEqual(Object.keys(hooks), ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreCompact', 'PostCompact', 'SubagentStop', 'Stop']);
  const mcp = JSON.parse(fs.readFileSync(path.join(plugin, '.mcp.json')));
  assert.deepEqual(mcp.golem, { command: 'node', args: ['mcp/channel/index.js'], cwd: '.' });
  assert.doesNotMatch(JSON.stringify(mcp), /PLUGIN_ROOT/);
  await mcpInitialize(mcp.golem, plugin);
  const projectRoot = path.join(temp, 'codex-project');
  const nestedCwd = path.join(projectRoot, 'packages', 'app');
  fs.mkdirSync(nestedCwd, { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.git'));
  const payload = { session_id: 'codex-test', cwd: nestedCwd, hook_event_name: 'SessionStart', source: 'resume', model: 'test' };
  execFileSync(process.execPath, [path.join(plugin, 'hooks/hook.mjs'), 'session-start'], { env, input: JSON.stringify(payload) });
  const fact = JSON.parse(fs.readFileSync(path.join(state, 'session-facts.json'))).facts[0];
  assert.equal(fact.canonical_id, 'codex-test');
  assert.equal(fact.model, 'test', 'documented Codex hook model is published at fact top level for native cards');
  assert.deepEqual(fact.delivery, { mode: 'pull', push: false });
  const projectId = projectIdFor(projectRoot);
  const projectsFile = path.join(state, 'projects.json');
  const sessionsFile = path.join(state, 'sessions.json');
  const projects = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
  assert.equal(projects.projects.length, 1, 'SessionStart registers one project');
  assert.deepEqual(projects.projects[0] && {
    id: projects.projects[0].id,
    name: projects.projects[0].name,
    path: projects.projects[0].path,
    kind: projects.projects[0].kind,
    registered_by: projects.projects[0].registered_by,
  }, {
    id: projectId,
    name: 'codex-project',
    path: projectRoot,
    kind: 'auto',
    registered_by: 'hook',
  }, 'SessionStart registers the resolved project root with hook-owned metadata');
  const firstSeen = projects.projects[0].first_seen;
  const sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
  assert.equal(sessions.sessions.length, 1, 'SessionStart registers one session');
  assert.deepEqual(sessions.sessions[0] && {
    session_id: sessions.sessions[0].session_id,
    project_id: sessions.sessions[0].project_id,
    project_path: sessions.sessions[0].project_path,
    harness: sessions.sessions[0].harness,
    model: sessions.sessions[0].model,
  }, {
    session_id: 'codex-test',
    project_id: projectId,
    project_path: projectRoot,
    harness: 'codex',
    model: 'test',
  }, 'SessionStart links the Codex session to the same resolved project');
  const staleTimestamp = '2000-01-01T00:00:00.000Z';
  projects.projects[0] = {
    ...projects.projects[0],
    name: 'Manual name',
    kind: 'manual',
    registered_by: 'manual',
    last_seen: staleTimestamp,
  };
  fs.writeFileSync(projectsFile, `${JSON.stringify(projects, null, 2)}\n`);
  sessions.sessions[0] = { ...sessions.sessions[0], last_seen_at: staleTimestamp };
  fs.writeFileSync(sessionsFile, `${JSON.stringify(sessions, null, 2)}\n`);
  execFileSync(process.execPath, [path.join(plugin, 'hooks/hook.mjs'), 'session-start'], { env, input: JSON.stringify({ ...payload, model: 'updated-model' }) });
  const updatedProjects = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
  assert.deepEqual(updatedProjects.projects[0] && {
    name: updatedProjects.projects[0].name,
    kind: updatedProjects.projects[0].kind,
    registered_by: updatedProjects.projects[0].registered_by,
    first_seen: updatedProjects.projects[0].first_seen,
  }, {
    name: 'Manual name',
    kind: 'manual',
    registered_by: 'manual',
    first_seen: firstSeen,
  }, 'repeat registration preserves manual project metadata');
  assert.ok(Date.parse(updatedProjects.projects[0].last_seen) > Date.parse(staleTimestamp), 'repeat registration refreshes the project timestamp');
  const updatedSessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
  assert.equal(updatedSessions.sessions.length, 1, 'repeat registration updates rather than duplicates the session');
  assert.equal(updatedSessions.sessions[0].model, 'updated-model');
  assert.ok(Date.parse(updatedSessions.sessions[0].last_seen_at) > Date.parse(staleTimestamp), 'repeat registration refreshes the session timestamp');
  const unregisteredRoot = path.join(temp, 'unregistered-codex-project');
  const unregisteredCwd = path.join(unregisteredRoot, 'nested');
  fs.mkdirSync(unregisteredCwd, { recursive: true });
  fs.mkdirSync(path.join(unregisteredRoot, '.git'));
  execFileSync(process.execPath, [path.join(plugin, 'hooks/hook.mjs'), 'user-prompt'], { env, input: JSON.stringify({ ...payload, session_id: 'codex-non-start', cwd: unregisteredCwd, hook_event_name: 'UserPromptSubmit' }) });
  assert.equal(JSON.parse(fs.readFileSync(projectsFile, 'utf8')).projects.length, 1, 'non-SessionStart hooks do not register projects');
  assert.equal(JSON.parse(fs.readFileSync(sessionsFile, 'utf8')).sessions.length, 1, 'non-SessionStart hooks do not register sessions');
  execFileSync(process.execPath, [path.join(plugin, 'hooks/hook.mjs'), 'subagent-stop'], { env, input: JSON.stringify({ ...payload, hook_event_name: 'SubagentStop', agent_id: 'child' }) });
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'session-facts.json'))).facts.find((row) => row.canonical_id === 'codex-test').status, 'active', 'SubagentStop preserves parent status');
  const xdgOnly = { ...env, GOLEM_HOME: '' };
  execFileSync(process.execPath, [path.join(plugin, 'hooks/hook.mjs'), 'session-start'], { env: xdgOnly, input: JSON.stringify({ ...payload, session_id: 'xdg-test' }) });
  assert.ok(fs.existsSync(path.join(env.XDG_CONFIG_HOME, 'golem', 'session-facts.json')), 'shared XDG golemHome resolution is used');
  assert.ok(fs.existsSync(path.join(env.XDG_CONFIG_HOME, 'golem', 'projects.json')), 'Codex registration uses the shared XDG golemHome resolution');
  const native = spawnSync('codex', ['--version'], { env, encoding: 'utf8' });
  if (native.status === 0) {
    const added = spawnSync('codex', ['plugin', 'marketplace', 'add', root], { env, encoding: 'utf8' });
    assert.equal(added.status, 0, `native marketplace validation failed: ${added.stderr || added.stdout}`);
    const installed = spawnSync('codex', ['plugin', 'add', 'golem@golem-workspace', '--json'], { env, encoding: 'utf8' });
    assert.equal(installed.status, 0, `native plugin install/enable failed: ${installed.stderr || installed.stdout}`);
    assert.match(installed.stdout, /golem/);
    const listed = spawnSync('codex', ['plugin', 'marketplace', 'list'], { env, encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /golem-workspace|golem-codex-/);
    console.log(`codex native present: ${native.stdout.trim()}; plugin installed/enabled`);
  } else console.log('codex native absent: structural journey only');
  console.log('codex temp-home journey passed; emitted identity-free MCP initialized and tools/list called');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
