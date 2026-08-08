#!/usr/bin/env node
// audit-skills — structural pass over the skills pool.
//
// Runtime quality belongs to the human. This command checks only metadata and
// bundled-file structure that can be confirmed without evaluating a skill.
//
// Usage: node scripts/audit-skills.mjs [skillsDir]

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';

const skillsDir = process.argv[2] ?? 'substrate/skills';
// A description must say what the skill does and when it applies.
const HAS_WHEN = /\b(when|before|after|use for|use to)\b/i;

const rows = [];
for (const name of readdirSync(skillsDir).sort()) {
  const dir = join(skillsDir, name);
  if (!statSync(dir).isDirectory()) continue;
  const doc = join(dir, 'SKILL.md');
  if (!existsSync(doc)) { rows.push({ name, findings: ['no SKILL.md'] }); continue; }

  const raw = readFileSync(doc, 'utf8');
  const findings = [];
  let data = {};
  let body = raw;
  try { ({ data, content: body } = matter(raw)); } catch (error) {
    rows.push({ name, findings: [`frontmatter does not parse: ${String(error.message).split('\n')[0]}`] });
    continue;
  }

  const desc = String(data.description ?? '');
  const words = desc.trim().split(/\s+/).filter(Boolean).length;

  if (data.name !== name) findings.push(`frontmatter name "${data.name ?? ''}" != directory "${name}"`);
  if (!desc.trim()) findings.push('description is empty');
  else {
    if (!HAS_WHEN.test(desc)) findings.push('description does not say WHEN to use it');
  }

  const bodyLines = body.trimEnd().split('\n').length;

  // Bundled files nothing links to are never discovered — except runtime assets
  // that a service reads rather than the agent. skills/tracker/templates/* are
  // served verbatim by the dashboard's GET /api/templates as ticket-body
  // prefills, so they are correctly unlinked from SKILL.md.
  const RUNTIME_ASSETS = new Set(['tracker/templates']);
  for (const sub of ['references', 'scripts', 'examples', 'templates', 'assets']) {
    if (RUNTIME_ASSETS.has(`${name}/${sub}`)) continue;
    const subDir = join(dir, sub);
    if (!existsSync(subDir)) continue;
    for (const file of readdirSync(subDir)) {
      if (!body.includes(`${sub}/${file}`)) findings.push(`${sub}/${file} is bundled but never linked from SKILL.md`);
    }
    // Reference depth must stay one level: a spoke may not link another spoke.
    for (const file of readdirSync(subDir).filter((f) => f.endsWith('.md'))) {
      const spoke = readFileSync(join(subDir, file), 'utf8');
      const onward = [...spoke.matchAll(/\]\((?!https?:|#)([^)]+\.md)\)/g)].map((m) => m[1]);
      const deeper = onward.filter((target) => !target.startsWith('..') && target !== file
        && !readdirSync(subDir).includes(target.replace(/^\.\//, '')) === false);
      if (deeper.length && sub === 'references') {
        // spoke -> sibling spoke is tolerated; spoke -> a third level is not
        const third = onward.filter((t) => t.split('/').length > 1);
        if (third.length) findings.push(`${sub}/${file} links a second level deep: ${third.join(', ')}`);
      }
    }
  }

  rows.push({ name, words, bodyLines, findings });
}

const clean = rows.filter((r) => !r.findings.length);
const dirty = rows.filter((r) => r.findings.length);

console.log(`skills: ${rows.length}   clean: ${clean.length}   with findings: ${dirty.length}`);
console.log('');
for (const row of dirty) {
  console.log(`${row.name}  (desc ${row.words ?? '?'}w, body ${row.bodyLines ?? '?'}L)`);
  for (const finding of row.findings) console.log(`   - ${finding}`);
}
if (clean.length) {
  console.log('');
  console.log(`clean: ${clean.map((r) => r.name).join(', ')}`);
}
process.exit(dirty.length ? 1 : 0);
