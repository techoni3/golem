// Codex Tier-B adapter. Ordinary Codex CLI has lifecycle hooks and MCP but no
// documented API for injecting an out-of-band turn, so this bundle deliberately
// advertises pull/next-turn delivery only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyTemplate, sha256, sha256File } from '../engine.js';

const CONTEXT = { codex: true };

// Same controlled-block contract the cc adapter uses for ~/.claude/CLAUDE.md:
// golem owns the region between the markers, the human owns everything else in
// the file, and re-rendering replaces only the block. Codex reads this file as
// its global instructions — confirmed by probe, and the error path for it lives
// in the binary's `codex-home/src/instructions/mod.rs`.
const INSTRUCTIONS_BEGIN = '<!-- golem:instructions:begin -->';
const INSTRUCTIONS_END = '<!-- golem:instructions:end -->';

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = path.join(dir, entry.name);
    return entry.isDirectory() ? files(abs) : [abs];
  });
}

function item(key, outputRelPath, source, build = () => fs.readFileSync(source)) {
  return { key, outputRelPath, sourceSha256: sha256File(source), build };
}

export function buildPlan({ substrateRoot, repoRoot, packageVersion }) {
  const root = 'plugins/golem';
  const out = [];
  for (const abs of files(path.join(substrateRoot, 'skills'))) {
    const rel = path.relative(path.join(substrateRoot, 'skills'), abs);
    out.push(item(`skill:${rel}`, `${root}/skills/${rel}`, abs, () =>
      path.basename(abs) === 'SKILL.md'
        ? applyTemplate(fs.readFileSync(abs, 'utf8'), CONTEXT)
        : fs.readFileSync(abs)));
  }
  const hook = path.join(repoRoot, 'shims', 'codex', 'hook.mjs');
  out.push(item('hook:hook.mjs', `${root}/hooks/hook.mjs`, hook));
  for (const rel of ['golem-home.js', 'project-id.js', 'session-facts.js', 'session-registry.js', 'session-role.js']) {
    const abs = path.join(repoRoot, 'lib', rel);
    out.push(item(`lib:${rel}`, `${root}/lib/${rel}`, abs));
  }
  const channelRoot = path.join(repoRoot, 'mcp', 'channel');
  for (const abs of files(channelRoot).filter((file) => !file.includes(`${path.sep}node_modules${path.sep}`))) {
    const rel = path.relative(channelRoot, abs);
    out.push(item(`mcp:${rel}`, `${root}/mcp/channel/${rel}`, abs));
  }
  const manifest = {
    name: 'golem', version: packageVersion,
    description: 'Golem tracker and Tier B Codex lifecycle integration',
    license: 'MIT', skills: './skills/', mcpServers: './.mcp.json', hooks: './hooks/hooks.json',
  };
  const hooks = Object.fromEntries([
    ['SessionStart', 'session-start'], ['UserPromptSubmit', 'user-prompt'],
    ['PreToolUse', 'tool-pre'], ['PostToolUse', 'tool-post'],
    ['PreCompact', 'pre-compact'], ['PostCompact', 'post-compact'],
    ['SubagentStop', 'subagent-stop'], ['Stop', 'stop'],
  ].map(([event, normalized]) => [event, [{ hooks: [{ type: 'command', command: `node \"\${PLUGIN_ROOT}/hooks/hook.mjs\" ${normalized}` }] }]]));
  const mcp = { golem: { command: 'node', args: ['mcp/channel/index.js'], cwd: '.' } };
  const capabilities = {
    schema: 1, harness: 'codex', tier: 'B', lifecycle: true, mcp: true, subagents: true,
    delivery: ['pull'], push_delivery: false,
    limitation: 'Ordinary Codex CLI exposes no documented out-of-band turn injection or queued-message pickup API; work must be pulled with Golem MCP tools.',
  };
  const marketplace = { name: 'golem-workspace', interface: { displayName: 'Golem Workspace' }, plugins: [{ name: 'golem', source: { source: 'local', path: './plugins/golem' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] };
  for (const [key, rel, value] of [
    ['manifest', `${root}/.codex-plugin/plugin.json`, manifest], ['hooks', `${root}/hooks/hooks.json`, { hooks }],
    ['mcp-config', `${root}/.mcp.json`, mcp], ['capabilities', `${root}/capabilities.json`, capabilities],
    ['marketplace', '.agents/plugins/marketplace.json', marketplace],
  ]) out.push({ key, outputRelPath: rel, sourceSha256: sha256(JSON.stringify(value)), build: () => `${JSON.stringify(value, null, 2)}\n` });
  return out;
}

/** CODEX_HOME, where Codex reads its global AGENTS.md. Env override wins so an
 * isolated harness run cannot write into the real one. */
export function instructionOutDir() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** The golem-owned instruction block inside Codex's global AGENTS.md. Rendered
 * separately from the plugin bundle because it lands in CODEX_HOME, not in the
 * marketplace render root. */
export function buildInstructionPlan({ substrateRoot }) {
  const abs = path.join(substrateRoot, 'instructions', 'AGENTS.md');
  if (!fs.existsSync(abs)) return [];
  return [{
    key: 'instructions:AGENTS.md',
    outputRelPath: 'AGENTS.md',
    sourceSha256: sha256File(abs),
    type: 'block',
    beginMarker: INSTRUCTIONS_BEGIN,
    endMarker: INSTRUCTIONS_END,
    build: () => applyTemplate(fs.readFileSync(abs, 'utf8'), CONTEXT),
  }];
}
