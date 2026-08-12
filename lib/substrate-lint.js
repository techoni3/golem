import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import matter from 'gray-matter';
import { BUILTIN_ROLES, ROLE_MIGRATIONS } from './session-role.js';

const REF_RE = /\bgolem:([a-z][a-z0-9-]*)\b/g;
// Role cards carry the name and a skill pointer only (GOL-143 D13). Missions live in
// instructions/AGENTS.md § Roles; role methods and detailed boundaries live in role skills.
// There is no per-card protocol to enforce here.
const REQUIRED_ROLE_FIELDS = ['Load'];

function golemHome() {
  if (process.env.GOLEM_HOME) return process.env.GOLEM_HOME;
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, 'golem');
  return path.join(os.homedir(), '.golem');
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function listFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(abs));
    else out.push(abs);
  }
  return out;
}

function lineOf(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function frontmatterDescription(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return { value: '', line: 1 };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') break;
    const m = lines[i].match(/^description:\s*(.*)$/);
    if (m) return { value: m[1].trim().replace(/^['"]|['"]$/g, ''), line: i + 1 };
  }
  return { value: '', line: 1 };
}

// Frontmatter that does not parse is the worst failure available: the harness
// drops the file at discovery time and reports nothing, so a skill looks
// installed and is never loadable. `golem:standalone` shipped that way through
// four renders because a plain YAML scalar cannot contain ": " and the check
// here was a regex, which cannot see it. Parse for real.
function frontmatterParseError(text) {
  if (!text.startsWith('---')) return null; // no frontmatter is a separate check
  try {
    matter(text);
    return null;
  } catch (error) {
    return String(error?.message || error).split('\n')[0];
  }
}

function roleRegistryNames(home = golemHome()) {
  const names = new Set(BUILTIN_ROLES.map((r) => r.name));
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(home, 'roles', 'index.json'), 'utf8'));
    for (const role of parsed.roles || []) {
      // A retired name still sitting in the on-disk registry is not a lint
      // failure — it is an install that has not been read through
      // readRoleRegistry() yet, which is what prunes it. Without this skip,
      // every existing install fails `npm run check` immediately after a role
      // merge lands, and the file does not self-heal from the CLI.
      // hasOwn, not `in`/truthy: ROLE_MIGRATIONS is a plain frozen object, so a
      // role legitimately named `constructor` or `valueof` would otherwise hit
      // Object.prototype and be silently skipped.
      if (role?.name && !Object.hasOwn(ROLE_MIGRATIONS, role.name)) names.add(String(role.name));
    }
  } catch {
    // No overlay index is fine; builtins are the floor.
  }
  return names;
}

function rel(substrateRoot, abs) {
  return path.relative(substrateRoot, abs).split(path.sep).join('/');
}

function addIssue(issues, abs, line, message, fix, substrateRoot) {
  issues.push({ file: rel(substrateRoot, abs), line, message, fix });
}

/**
 * The set of MCP tool names an agent may legitimately grant, built from the
 * declared servers in `substrate/mcp.json`, the plugin name in
 * `substrate/plugin-meta.json`, and the tool names the channel server actually
 * registers. Returns null when any of those cannot be read, so a fixture
 * substrate without a channel is not failed for it.
 *
 * Claude Code namespaces plugin-provided MCP tools as
 * `mcp__plugin_<plugin>_<server>__<tool>`.
 */
function declaredMcpToolNames(substrateRoot) {
  try {
    const servers = Object.keys(JSON.parse(fs.readFileSync(path.join(substrateRoot, 'mcp.json'), 'utf8')).mcpServers || {});
    const plugin = JSON.parse(fs.readFileSync(path.join(substrateRoot, 'plugin-meta.json'), 'utf8'))?.name;
    const channel = fs.readFileSync(path.join(substrateRoot, '..', 'mcp', 'channel', 'index.js'), 'utf8');
    if (!servers.length || !plugin) return null;
    const tools = [...channel.matchAll(/^\s*name: '([a-z][a-z0-9_]*)',$/gm)].map((m) => m[1]);
    if (!tools.length) return null;
    const names = new Set();
    for (const server of servers) for (const tool of tools) names.add(`mcp__plugin_${plugin}_${server}__${tool}`);
    return names;
  } catch {
    return null;
  }
}

export function lintSubstrate({ substrateRoot, home = golemHome() } = {}) {
  if (!substrateRoot) throw new Error('lintSubstrate requires substrateRoot');
  const issues = [];
  const warnings = [];
  const skillsDir = path.join(substrateRoot, 'skills');
  const rolesDir = path.join(substrateRoot, 'roles');
  const agentsDir = path.join(substrateRoot, 'agents');
  const instructionsDir = path.join(substrateRoot, 'instructions');

  const skillNames = new Set();
  const skillDocs = listFiles(skillsDir).filter((p) => path.basename(p) === 'SKILL.md');
  for (const abs of skillDocs) {
    const name = path.basename(path.dirname(abs));
    skillNames.add(name);
    const skillText = fs.readFileSync(abs, 'utf8');
    const parseError = frontmatterParseError(skillText);
    const { value: desc, line: descLine } = frontmatterDescription(skillText);
    if (parseError) {
      addIssue(issues, abs, descLine, `skill ${name} frontmatter does not parse: ${parseError}`, 'Fix the YAML. A plain scalar cannot contain ": " — replace the colon with an em dash or quote the whole value.', substrateRoot);
    } else if (!desc || !String(desc).trim()) {
      addIssue(issues, abs, descLine, `skill ${name} is missing frontmatter description`, 'Add a concise description to the YAML frontmatter.', substrateRoot);
    } else if (wordCount(desc) > 45) {
      addIssue(issues, abs, descLine, `skill ${name} description is ${wordCount(desc)} words; limit is 45`, 'Shorten the description to <=45 words.', substrateRoot);
    }
  }

  // Agent cards route delegation by the same description matching, so the same
  // silent-drop applies to them.
  const mcpToolNames = declaredMcpToolNames(substrateRoot);
  for (const abs of listFiles(agentsDir).filter((p) => p.endsWith('.md'))) {
    const text = fs.readFileSync(abs, 'utf8');
    const agentName = path.basename(abs, '.md');
    const parseError = frontmatterParseError(text);
    if (parseError) {
      addIssue(issues, abs, 1, `agent ${agentName} frontmatter does not parse: ${parseError}`, 'Fix the YAML. A plain scalar cannot contain ": " — replace the colon with an em dash or quote the whole value.', substrateRoot);
      continue;
    }
    // An MCP grant that does not resolve is the worst kind of wrong: it renders,
    // it syncs clean, and the agent simply comes up without the tool. Nothing
    // else in the pipeline checks these strings.
    if (mcpToolNames === null) continue;
    const toolsLine = text.split('\n').findIndex((l) => l.startsWith('tools:'));
    if (toolsLine === -1) continue;
    for (const entry of text.split('\n')[toolsLine].slice('tools:'.length).split(',').map((s) => s.trim())) {
      if (!entry.startsWith('mcp__')) continue;
      if (!mcpToolNames.has(entry)) {
        addIssue(issues, abs, toolsLine + 1, `agent ${agentName} grants unknown MCP tool ${entry}`,
          'Name must be mcp__plugin_<plugin>_<server>__<tool> and resolve against substrate/mcp.json plus the channel tool list.', substrateRoot);
      }
    }
  }

  const registeredRoles = roleRegistryNames(home);
  const cardRoles = new Set(listFiles(rolesDir).filter((p) => p.endsWith('.md')).map((p) => path.basename(p, '.md')));
  for (const role of registeredRoles) {
    const card = path.join(rolesDir, `${role}.md`);
    if (!isFile(card)) {
      addIssue(issues, card, 1, `registered role ${role} has no substrate role card`, `Add substrate/roles/${role}.md or remove the role from ~/.golem/roles/index.json.`, substrateRoot);
    }
  }
  for (const role of cardRoles) {
    const card = path.join(rolesDir, `${role}.md`);
    if (!registeredRoles.has(role)) {
      addIssue(issues, card, 1, `role card ${role}.md is not registered`, `Add ${role} to the role registry or remove the card.`, substrateRoot);
    }
  }

  for (const abs of listFiles(rolesDir).filter((p) => p.endsWith('.md'))) {
    const text = fs.readFileSync(abs, 'utf8');
    const lines = text.trimEnd().split(/\r?\n/);
    if (lines.length > 12) {
      addIssue(issues, abs, 1, `role card has ${lines.length} lines; limit is 12`, 'Condense the role card to the compact template.', substrateRoot);
    }
    const fieldLines = new Map();
    for (const field of REQUIRED_ROLE_FIELDS) {
      const idx = lines.findIndex((l) => l.startsWith(`${field}:`));
      if (idx === -1) {
        addIssue(issues, abs, 1, `role card missing required field ${field}`, `Add a ${field}: line.`, substrateRoot);
      } else {
        fieldLines.set(field, { line: idx + 1, value: lines[idx].slice(`${field}:`.length).trim() });
        if (field === 'Load' && !fieldLines.get(field).value) {
          addIssue(issues, abs, idx + 1, 'role card Load field is empty', 'List at least one golem:<skill> reference.', substrateRoot);
        }
      }
    }
  }

  // Skill docs are included here, not just in the orphan scan: most routing now lives in
  // skill-to-skill pointers, so an unresolvable golem: reference inside a skill must fail.
  const failRefFiles = [rolesDir, agentsDir, instructionsDir].flatMap(listFiles)
    .filter((p) => /\.(md|txt)$/.test(p))
    .concat(skillDocs);
  const orphanRefFiles = failRefFiles;
  const referenced = new Set();
  for (const abs of orphanRefFiles) {
    const text = fs.readFileSync(abs, 'utf8');
    for (const match of text.matchAll(REF_RE)) referenced.add(match[1]);
  }
  for (const abs of failRefFiles) {
    const text = fs.readFileSync(abs, 'utf8');
    for (const match of text.matchAll(REF_RE)) {
      const name = match[1];
      if (!skillNames.has(name)) {
        addIssue(issues, abs, lineOf(text, match.index), `golem:${name} does not resolve to substrate/skills/${name}/SKILL.md`, `Create substrate/skills/${name}/SKILL.md or fix the reference.`, substrateRoot);
      }
    }
  }
  for (const name of [...skillNames].sort()) {
    if (!referenced.has(name)) warnings.push({ file: `skills/${name}/SKILL.md`, line: 1, message: `skill ${name} is not referenced by roles, agents, instructions, or skills`, fix: 'Usually OK for event-triggered skills; otherwise add a live reference or remove the skill.' });
  }

  return { ok: issues.length === 0, issues, warnings };
}

export function formatLintResult(result) {
  const lines = [];
  if (result.issues?.length) {
    lines.push('substrate lint failed:');
    for (const issue of result.issues) lines.push(`  FAIL ${issue.file}:${issue.line} — ${issue.message}. Fix: ${issue.fix}`);
  }
  if (result.warnings?.length) {
    if (lines.length) lines.push('');
    lines.push('substrate lint warnings:');
    for (const warning of result.warnings) lines.push(`  WARN ${warning.file}:${warning.line} — ${warning.message}. ${warning.fix}`);
  }
  if (!lines.length) lines.push('substrate lint OK');
  return lines.join('\n');
}
