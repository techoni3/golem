// opencode adapter (TKT-0576, P4 — ADR-2/ADR-6/ADR-8). Renders substrate/ into
// the two places opencode actually reads from, which are NOT one bundle dir:
//
//   - agents  -> ~/.config/opencode/agent/<name>.md
//        opencode's global agent dir is FIXED; there is no config key to add
//        extra agent search paths (verified against a real opencode build in
//        the P4 research, not guessed). So golem agent files must physically
//        live there. Rendered via `buildAgentPlan` into `agentOutDir()`.
//
//   - skills  -> <golem-home>/renders/opencode/skills/<name>/SKILL.md
//        opencode DOES support extra skill dirs via the `skills.paths` config
//        array, so golem skills render into their own dir and that dir is
//        appended to skills.paths (see `buildConfigMerge` / `applyConfigMerge`).
//        Rendered via `buildSkillPlan` into `skillsOutDir()`.
//
// Both plans use the same engine.render() machinery (lockfile / tamper / orphan
// pruning); they get independent lockfile sections because engine keys on
// (target, outDir) and the two outDirs differ.
//
// DIALECT TRANSLATION vs COPY:
//   - Agent FRONTMATTER is translated, not copied. A Claude Code agent's
//     `tools:` + `model:` frontmatter is invalid under opencode, which uses
//     `mode` + a `permission` map (`tools:` is deprecated there). We emit
//     `description` + `mode: subagent` + (for read-only agents) `permission:
//     { edit: deny }`, and OMIT `model` so the opencode session's own default
//     model is inherited — the user runs GPT auth with zero Anthropic models
//     available, so pinning `model: opus` (the substrate value) would break.
//   - Agent BODIES and skill BODIES are copied, but run through the engine's
//     {{#if opencode}} templating so the two CC-specific dialect bits (the
//     journaling "automatic via plugin hooks" note and the Claude Code PR
//     trailer) render their opencode variant. Bodies carry no `model`/tool
//     assumptions, so nothing else needs rewriting.
//
// CONFIG MERGE is comment-preserving (jsonc-parser) and touches ONLY the two
// managed keys `mcp.golem` and `skills.paths`; the user's own keys, comments,
// and formatting survive. skills.paths is APPENDED to (idempotently), never
// overwritten. Every write is guarded: back up opencode.jsonc, write, let the
// caller validate with the real `opencode debug config`, and restore the
// backup on validation failure (the P3 lesson: trust the tool, not the schema).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import matter from 'gray-matter';
import { parse, modify, applyEdits } from 'jsonc-parser';
import { sha256, sha256File, applyTemplate } from '../engine.js';
import { renderDirFor } from '../../golem-home.js';

const HARNESS_CONTEXT = { opencode: true };

const GENERATED_NOTE = 'rendered by `golem sync --target opencode` from substrate/ — edit the source, not this file.';
function htmlComment(relSourcePath) {
  return `<!-- GENERATED: ${relSourcePath} — ${GENERATED_NOTE} -->\n`;
}

// Index right after the frontmatter's closing `---` line (+ newline), or -1 if
// there's no frontmatter. The GENERATED comment MUST go after frontmatter, not
// before it: opencode (like every frontmatter parser) only recognizes a `---`
// block at byte 0, so a leading comment silently disables the skill's name/
// description and it never loads.
function frontmatterEnd(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return -1;
  const m = text.slice(4).match(/\r?\n---\r?\n/);
  if (!m) return -1;
  return 4 + m.index + m[0].length;
}
function insertHeader(text, headerLine) {
  const fmEnd = frontmatterEnd(text);
  return fmEnd === -1 ? headerLine + text : text.slice(0, fmEnd) + headerLine + text.slice(fmEnd);
}

// --- opencode's own config locations (its XDG dir, NOT golem's) -------------
// opencode resolves ~/.config/opencode (honoring XDG_CONFIG_HOME), the same
// way it does at runtime; keep this in lockstep with opencode, not golem-home.
export function opencodeConfigDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'opencode');
}
export function agentOutDir() {
  return path.join(opencodeConfigDir(), 'agent');
}
export function projectAgentOutDir(projectRoot) {
  return path.join(projectRoot, '.opencode', 'agents');
}
export function opencodeConfigPath() {
  return path.join(opencodeConfigDir(), 'opencode.jsonc');
}
// golem skills render under the opencode render dir; this exact path is what
// gets appended to skills.paths.
export function skillsOutDir() {
  return path.join(renderDirFor('opencode'), 'skills');
}
export function rolesOutDir() {
  return path.join(renderDirFor('opencode'), 'roles');
}
export function projectSkillsOutDir(projectRoot) {
  return path.join(projectRoot, '.opencode', 'skills');
}

function listFilesRecursive(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(abs));
    else out.push(abs);
  }
  return out;
}

function scopeOfMarkdown(abs) {
  try {
    const scope = matter(fs.readFileSync(abs, 'utf8')).data?.scope;
    return scope === 'project' ? 'project' : 'global';
  } catch {
    return 'global';
  }
}

function stripScopeFrontmatter(text) {
  const end = frontmatterEnd(text);
  if (end === -1) return text;
  const head = text.slice(0, end).replace(/^scope:\s*(global|project)\s*\r?\n/gm, '');
  return head + text.slice(end);
}

function skillDirScope(skillDir) {
  return scopeOfMarkdown(path.join(skillDir, 'SKILL.md'));
}

// --- agent frontmatter dialect translation ---------------------------------

/**
 * Map a substrate agent's Claude Code `tools:` list to an opencode `permission`
 * map. The one load-bearing intent to preserve is read-only-ness: a substrate
 * agent that grants neither Write nor Edit (reviewer, researcher) must not be
 * able to edit under opencode either. We encode that as `permission: { edit:
 * deny }`. We deliberately do NOT try to deny every tool the substrate list
 * omits (e.g. webfetch/websearch) — over-restricting risks breaking an agent,
 * and edit is the security-meaningful boundary. Writers (worker) get no
 * permission block: full default access.
 */
function permissionFor(toolsStr) {
  const tools = String(toolsStr || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const canWrite = tools.includes('write') || tools.includes('edit');
  return canWrite ? null : { edit: 'deny' };
}

/** Build an opencode agent .md (frontmatter translated, body templated + header). */
function renderAgentFile(substrateRel, srcText) {
  const { data, content } = matter(stripScopeFrontmatter(srcText));
  const permission = permissionFor(data.tools);

  // Hand-build YAML for the small, fixed shape. description is emitted as a
  // JSON-quoted scalar (valid YAML flow scalar) so colons / em-dashes / quotes
  // in it can't break parsing. model is intentionally omitted (see module doc).
  const lines = ['---'];
  lines.push(`description: ${JSON.stringify(data.description ?? '')}`);
  lines.push('mode: subagent');
  if (permission) {
    lines.push('permission:');
    for (const [k, v] of Object.entries(permission)) lines.push(`  ${k}: ${v}`);
  }
  lines.push('---');
  const frontmatter = lines.join('\n') + '\n';

  const body = applyTemplate(content, HARNESS_CONTEXT);
  return frontmatter + htmlComment(substrateRel) + body;
}

/**
 * RenderItems for agent files, output flat as `<name>.md` into agentOutDir().
 * @param {object} ctx
 * @param {string} ctx.substrateRoot
 */
export function buildAgentPlan({ substrateRoot }) {
  const agentsDir = path.join(substrateRoot, 'agents');
  const items = [];
  for (const abs of listFilesRecursive(agentsDir)) {
    if (!abs.endsWith('.md')) continue;
    if (scopeOfMarkdown(abs) === 'project') continue;
    const substrateRel = path.relative(substrateRoot, abs); // agents/worker.md
    const outName = path.basename(abs); // worker.md — flat in agentOutDir
    items.push({
      key: `agent:${outName}`,
      outputRelPath: outName,
      sourceSha256: sha256File(abs),
      build: () => renderAgentFile(substrateRel, fs.readFileSync(abs, 'utf8')),
    });
  }
  return items;
}

/**
 * RenderItems for skills, output as `<name>/SKILL.md` (+ verbatim template
 * assets) into skillsOutDir(). SKILL.md bodies are templated with the opencode
 * dialect; other assets (tracker templates) are copied verbatim — they are
 * ticket-prefill content and must not be touched.
 * @param {object} ctx
 * @param {string} ctx.substrateRoot
 */
export function buildSkillPlan({ substrateRoot }) {
  const skillsDir = path.join(substrateRoot, 'skills');
  const items = [];
  for (const abs of listFilesRecursive(skillsDir)) {
    const rel = path.relative(skillsDir, abs); // e.g. gates/SKILL.md
    const skillRoot = path.join(skillsDir, rel.split(path.sep)[0]);
    if (skillDirScope(skillRoot) === 'project') continue;
    const isSkillDoc = path.basename(abs) === 'SKILL.md';
    items.push({
      key: `skill:${rel}`,
      outputRelPath: rel,
      sourceSha256: sha256File(abs),
      build: () => {
        const text = stripScopeFrontmatter(fs.readFileSync(abs, 'utf8'));
        // Header goes AFTER the frontmatter (see frontmatterEnd) so opencode
        // still parses the skill's name/description and loads it.
        return isSkillDoc
          ? insertHeader(applyTemplate(text, HARNESS_CONTEXT), htmlComment(path.join('skills', rel)))
          : text;
      },
    });
  }
  return items;
}

export function buildRolePlan({ substrateRoot }) {
  const rolesDir = path.join(substrateRoot, 'roles');
  const items = [];
  if (!fs.existsSync(rolesDir)) return items;
  for (const abs of listFilesRecursive(rolesDir)) {
    if (!abs.endsWith('.md')) continue;
    const rel = path.relative(rolesDir, abs);
    items.push({
      key: `role:${rel}`,
      outputRelPath: rel,
      sourceSha256: sha256File(abs),
      build: () => fs.readFileSync(abs, 'utf8'),
    });
  }
  return items;
}

export function buildProjectAgentPlan({ substrateRoot }) {
  const agentsDir = path.join(substrateRoot, 'agents');
  const items = [];
  if (!fs.existsSync(agentsDir)) return items;
  for (const abs of listFilesRecursive(agentsDir)) {
    if (!abs.endsWith('.md') || scopeOfMarkdown(abs) !== 'project') continue;
    const substrateRel = path.relative(substrateRoot, abs);
    const outName = path.basename(abs);
    items.push({
      key: `agent:${outName}`,
      outputRelPath: outName,
      sourceSha256: sha256File(abs),
      build: () => renderAgentFile(substrateRel, fs.readFileSync(abs, 'utf8')),
    });
  }
  return items;
}

export function buildProjectSkillPlan({ substrateRoot }) {
  const skillsDir = path.join(substrateRoot, 'skills');
  const items = [];
  if (!fs.existsSync(skillsDir)) return items;
  for (const abs of listFilesRecursive(skillsDir)) {
    const rel = path.relative(skillsDir, abs);
    const skillRoot = path.join(skillsDir, rel.split(path.sep)[0]);
    if (skillDirScope(skillRoot) !== 'project') continue;
    const isSkillDoc = path.basename(abs) === 'SKILL.md';
    items.push({
      key: `skill:${rel}`,
      outputRelPath: rel,
      sourceSha256: sha256File(abs),
      build: () => {
        const text = stripScopeFrontmatter(fs.readFileSync(abs, 'utf8'));
        return isSkillDoc
          ? insertHeader(applyTemplate(text, HARNESS_CONTEXT), htmlComment(path.join('skills', rel)))
          : text;
      },
    });
  }
  return items;
}

// --- opencode.jsonc managed-key merge --------------------------------------

/**
 * Describe the two managed keys to merge into opencode.jsonc.
 * mcp.golem points DIRECTLY at the repo's channel MCP (no copy) — opencode
 * references it by absolute path in config, so there's no install step that
 * needs a bundled copy (unlike the CC plugin). `environment` (not `env`) is the
 * McpLocalConfig schema key — verified, not guessed.
 * @param {object} ctx
 * @param {string} ctx.repoRoot
 */
export function buildConfigMerge({ repoRoot }) {
  const channelDir = path.join(repoRoot, 'mcp', 'channel');
  // The runtime shim (P5, TKT-0577) is registered as a local plugin by file
  // URL — opencode's `plugin:` array takes a config-relative path or a
  // `file://` URL, and an absolute plain path can be mis-read as an npm spec,
  // so use the URL form for the absolute checkout path.
  const shimPath = path.join(repoRoot, 'shims', 'opencode', 'index.js');
  return {
    mcpGolem: {
      type: 'local',
      command: ['node', path.join(channelDir, 'index.js')],
      environment: { NODE_PATH: path.join(channelDir, 'node_modules') },
    },
    skillsPath: skillsOutDir(),
    pluginEntry: `file://${shimPath}`,
  };
}

const DEFAULT_CONFIG = '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
const FMT = { formattingOptions: { insertSpaces: true, tabSize: 2 } };

/** Compute the merged opencode.jsonc text (comment-preserving) without writing. */
export function computeConfigText(currentText, { mcpGolem, skillsPath, pluginEntry }) {
  let next = currentText;
  next = applyEdits(next, modify(next, ['mcp', 'golem'], mcpGolem, FMT));

  // skills.paths — append golem's dir, never overwrite the user's own paths.
  let parsed = parse(next) ?? {};
  const paths = Array.isArray(parsed.skills?.paths) ? parsed.skills.paths : [];
  const mergedPaths = paths.includes(skillsPath) ? paths : [...paths, skillsPath];
  next = applyEdits(next, modify(next, ['skills', 'paths'], mergedPaths, FMT));

  // plugin[] — append the shim entry, never overwrite the user's own plugins.
  if (pluginEntry) {
    parsed = parse(next) ?? {};
    const plugins = Array.isArray(parsed.plugin) ? parsed.plugin : [];
    // opencode plugin entries can be strings or [name, opts] tuples; match on
    // the string form only.
    const has = plugins.some((p) => p === pluginEntry);
    const mergedPlugins = has ? plugins : [...plugins, pluginEntry];
    next = applyEdits(next, modify(next, ['plugin'], mergedPlugins, FMT));
  }

  return next;
}

/**
 * Merge the managed keys into opencode.jsonc on disk, guarded by backup +
 * caller-supplied validation.
 *
 * @param {object} ctx
 * @param {string} ctx.configPath                    - opencodeConfigPath()
 * @param {object} ctx.merge                         - buildConfigMerge() result
 * @param {(text:string)=>{ok:boolean,error?:string}} [ctx.validate]
 *        run against the freshly-written file (e.g. `opencode debug config`).
 *        On !ok the previous file state is restored and the write is reverted.
 * @returns {{changed:boolean, restored?:boolean, error?:string, backupPath?:string|null}}
 */
export function applyConfigMerge({ configPath, merge, validate }) {
  const existed = fs.existsSync(configPath);
  const currentText = existed ? fs.readFileSync(configPath, 'utf8') : DEFAULT_CONFIG;
  const nextText = computeConfigText(currentText, merge);

  if (existed && nextText === currentText) {
    return { changed: false, backupPath: null };
  }

  // Back up the prior state (only meaningful if the file existed).
  const backupPath = existed ? configPath + '.golem-bak' : null;
  if (existed) fs.copyFileSync(configPath, backupPath);

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, nextText);

  if (validate) {
    const res = validate(nextText);
    if (!res.ok) {
      // Restore: rewrite the old bytes, or remove the file we created.
      if (existed) fs.writeFileSync(configPath, currentText);
      else fs.rmSync(configPath, { force: true });
      if (backupPath) fs.rmSync(backupPath, { force: true });
      return { changed: false, restored: true, error: res.error, backupPath: null };
    }
  }

  // Success — the backup only needed to survive the validate window.
  if (backupPath) fs.rmSync(backupPath, { force: true });
  return { changed: true, backupPath: null };
}
