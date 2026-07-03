// Claude Code adapter (TKT-0574, ADR-2/ADR-3). Builds the RenderItem plan
// that lib/compiler/engine.js writes into a CC plugin bundle layout:
//   skills/<name>/SKILL.md (+ assets), agents/*.md, hooks/{hooks.json,*.sh},
//   .mcp.json, .claude-plugin/plugin.json, README.md, mcp/channel/*.
//
// P2 sources carry no template markers — every text file is a verbatim copy
// of its substrate/ source plus (where it's safe — see below) a GENERATED
// header. Content is never rewritten beyond that; the parity gate depends on
// it.
//
// GENERATED-header placement was chosen by checking, not guessing, what each
// format tolerates:
//   - .md WITH YAML frontmatter (skills/SKILL.md, agents/*.md): an HTML
//     comment as the first line of the body, right after the closing `---`.
//     Frontmatter itself is untouched (keeps `name`/`description` parsing
//     unaffected); the comment is inert prose in the body either way.
//   - README.md (no frontmatter): the comment as the file's first line.
//   - shell scripts: a `#` comment line right after the shebang.
//   - tracker template assets (skills/tracker/templates/*.md): NO header —
//     the dashboard's GET /api/templates serves these verbatim as ticket
//     body prefills; a header would leak into real ticket content.
//   - JSON (hooks.json, .mcp.json): NO header — JSON has no comment syntax
//     and these files aren't covered by a schema we checked. Tamper
//     detection for them relies solely on the lockfile's output hash.
//   - plugin.json: `$comment` IS a valid key per the plugin manifest schema
//     (fetched from json.schemastore.org and confirmed — additionalProperties
//     is not forbidden and `$comment` is explicitly listed), so it carries
//     the GENERATED marker there.
//   - mcp/channel/*.js: verbatim copy, no header — these are real npm
//     package sources copied as-is, not templated artifacts.

import fs from 'node:fs';
import path from 'node:path';
import { sha256, sha256File } from '../engine.js';

const GENERATED_NOTE = 'rendered by `golem sync` from substrate/ — edit the source, not this file.';

function htmlComment(relSourcePath) {
  return `<!-- GENERATED: ${relSourcePath} — ${GENERATED_NOTE} -->\n`;
}
function shComment(relSourcePath) {
  return `# GENERATED: ${relSourcePath} — ${GENERATED_NOTE}\n`;
}

/** Insert `headerLine` as the first line of the body, right after YAML frontmatter (if present) or at the top of the file. */
function insertHeader(text, headerLine) {
  const fmEnd = frontmatterEnd(text);
  if (fmEnd === -1) return headerLine + text;
  return text.slice(0, fmEnd) + headerLine + text.slice(fmEnd);
}

/** Index right after the frontmatter's closing `---` line (+ its newline), or -1 if there's no frontmatter. */
function frontmatterEnd(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return -1;
  const m = text.slice(4).match(/\r?\n---\r?\n/);
  if (!m) return -1;
  return 4 + m.index + m[0].length;
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

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * @param {object} ctx
 * @param {string} ctx.substrateRoot - absolute path to substrate/
 * @param {string} ctx.repoRoot - absolute path to the repo root
 * @param {string} ctx.packageVersion - root package.json version, stamped into plugin.json
 * @returns {Array} RenderItems (see engine.js render())
 */
export function buildPlan({ substrateRoot, repoRoot, packageVersion }) {
  const items = [];

  // --- skills/ (SKILL.md gets a header; every other asset is verbatim) ----
  const skillsDir = path.join(substrateRoot, 'skills');
  for (const abs of listFilesRecursive(skillsDir)) {
    const rel = path.relative(substrateRoot, abs); // e.g. skills/gates/SKILL.md
    const srcSha = sha256File(abs);
    const isSkillDoc = path.basename(abs) === 'SKILL.md';
    items.push({
      key: rel,
      outputRelPath: rel,
      sourceSha256: srcSha,
      build: () => {
        const text = fs.readFileSync(abs, 'utf8');
        return isSkillDoc ? insertHeader(text, htmlComment(rel)) : text;
      },
    });
  }

  // --- agents/*.md (header after frontmatter) ------------------------------
  const agentsDir = path.join(substrateRoot, 'agents');
  for (const abs of listFilesRecursive(agentsDir)) {
    const rel = path.relative(substrateRoot, abs);
    items.push({
      key: rel,
      outputRelPath: rel,
      sourceSha256: sha256File(abs),
      build: () => insertHeader(fs.readFileSync(abs, 'utf8'), htmlComment(rel)),
    });
  }

  // --- hooks/ (hooks.json verbatim; *.sh gets a header after the shebang) --
  const hooksDir = path.join(substrateRoot, 'hooks');
  for (const abs of listFilesRecursive(hooksDir)) {
    const rel = path.relative(substrateRoot, abs); // e.g. hooks/journal-route.sh
    const isShellScript = abs.endsWith('.sh');
    items.push({
      key: rel,
      outputRelPath: rel,
      sourceSha256: sha256File(abs),
      mode: isShellScript ? 0o755 : undefined,
      build: () => {
        const text = fs.readFileSync(abs, 'utf8');
        if (!isShellScript) return text; // hooks.json — verbatim, no header
        const lines = text.split('\n');
        const shebangEnd = lines[0].startsWith('#!') ? 1 : 0;
        lines.splice(shebangEnd, 0, shComment(rel).trimEnd());
        return lines.join('\n');
      },
    });
  }

  // --- .mcp.json (verbatim) -------------------------------------------------
  const mcpJsonAbs = path.join(substrateRoot, 'mcp.json');
  items.push({
    key: 'mcp.json',
    outputRelPath: '.mcp.json',
    sourceSha256: sha256File(mcpJsonAbs),
    build: () => fs.readFileSync(mcpJsonAbs, 'utf8'),
  });

  // --- .claude-plugin/plugin.json (plugin-meta.json + package version) -----
  const metaAbs = path.join(substrateRoot, 'plugin-meta.json');
  const metaRaw = fs.readFileSync(metaAbs, 'utf8');
  items.push({
    key: 'plugin-meta.json+version',
    outputRelPath: path.join('.claude-plugin', 'plugin.json'),
    sourceSha256: sha256(metaRaw + '\n' + packageVersion),
    build: () => {
      const meta = JSON.parse(metaRaw);
      const { $schema, name, displayName, description, author, license, keywords } = meta;
      const doc = {
        $schema,
        $comment: `GENERATED: substrate/plugin-meta.json + package.json version — ${GENERATED_NOTE}`,
        name,
        displayName,
        version: packageVersion,
        description,
        author,
        license,
        keywords,
      };
      // JSON.stringify multi-lines every array; the hand-authored original
      // kept `keywords` compact. Collapse it back so the only diff vs the
      // original really is $comment + version (parity discipline).
      const pretty = JSON.stringify(doc, null, 2);
      const compact = pretty.replace(
        /"keywords": \[\n(\s*"[^"]*",?\n)+\s*\]/,
        `"keywords": [${keywords.map((k) => JSON.stringify(k)).join(', ')}]`,
      );
      return compact + '\n';
    },
  });

  // --- README.md (header as the first line — no frontmatter) ---------------
  const readmeAbs = path.join(substrateRoot, 'README.md');
  items.push({
    key: 'README.md',
    outputRelPath: 'README.md',
    sourceSha256: sha256File(readmeAbs),
    build: () => htmlComment('README.md') + '\n' + fs.readFileSync(readmeAbs, 'utf8'),
  });

  // --- mcp/channel/ (real npm package, copied as-is; node_modules handled
  // separately by syncMcpChannelDeps — not per-file lockfile-tracked) -------
  const mcpChannelDir = path.join(repoRoot, 'mcp', 'channel');
  for (const name of ['index.js', 'tracker-client.js', 'tracker-client.test.mjs', 'package.json', 'package-lock.json']) {
    const abs = path.join(mcpChannelDir, name);
    if (!fs.existsSync(abs)) continue;
    const rel = path.join('mcp', 'channel', name);
    items.push({
      key: rel,
      outputRelPath: rel,
      sourceSha256: sha256File(abs),
      build: () => fs.readFileSync(abs, 'utf8'),
    });
  }

  return items;
}

/**
 * Bulk-copy mcp/channel/node_modules into the render. Not per-file
 * lockfile-tracked (thousands of files nobody hand-edits) — see the module
 * doc. Idempotent: always mirrors the source tree.
 */
export function syncMcpChannelDeps({ repoRoot, outDir }) {
  const src = path.join(repoRoot, 'mcp', 'channel', 'node_modules');
  const dest = path.join(outDir, 'mcp', 'channel', 'node_modules');
  if (!fs.existsSync(src)) return { copied: false };
  fs.rmSync(dest, { recursive: true, force: true });
  copyDirRecursive(src, dest);
  return { copied: true, dest };
}
