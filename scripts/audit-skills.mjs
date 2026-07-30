#!/usr/bin/env node
// audit-skills — mechanical pass over the skills pool against golem:skill-authoring.
//
// Only checks things that can be checked without judgment. It cannot run the
// three gates (trigger matrix, A/B delta, deletion test) — those need a fresh
// session and a real task. What it does catch is the class of failure that is
// invisible: a skill that looks fine and cannot route, or bundled files nothing
// links to so they are never discovered.
//
// Findings are advisory. `golem sync --check` and lib/substrate-lint.js own the
// hard gates; this is the authoring-quality companion to them.
//
// Usage: node scripts/audit-skills.mjs [skillsDir]

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';

const skillsDir = process.argv[2] ?? 'substrate/skills';
const DESC_WORD_CAP = 45;
const BODY_LINE_CAP = 500;

// Phrases the doctrine says to delete on sight: they restate model defaults and
// change nothing once loaded.
const NO_TEETH = [
  /\byou are an expert\b/i,
  /\bbest practices\b/i,
  /\bwrite clean code\b/i,
  /\bhandle errors gracefully\b/i,
  /\bas an AI\b/i,
];

// A description must say when to use it, not just what it is.
const HAS_WHEN = /\b(when|before|after|use for|use to)\b/i;
const FIRST_PERSON = /^(I |I'|We |We')|\bI help you\b/;

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
  if (!desc.trim()) findings.push('description is empty — cannot route');
  else {
    if (words > DESC_WORD_CAP) findings.push(`description ${words} words (cap ${DESC_WORD_CAP})`);
    if (!HAS_WHEN.test(desc)) findings.push('description does not say WHEN to use it');
    if (FIRST_PERSON.test(desc.trim())) findings.push('description is first person');
  }

  const bodyLines = body.trimEnd().split('\n').length;
  if (bodyLines > BODY_LINE_CAP) findings.push(`body ${bodyLines} lines (cap ${BODY_LINE_CAP})`);

  // A no-teeth phrase only counts when the skill is *using* it. Quoted or
  // emphasised occurrences are usually a doc citing the anti-pattern in order to
  // forbid it — golem:skill-authoring is entirely made of those.
  const bodyProse = body
    .replace(/```[\s\S]*?```/g, '')
    .split('\n')
    .filter((line) => !/["“'*`]/.test(line))
    .join('\n');
  for (const pattern of NO_TEETH) {
    const hit = bodyProse.match(pattern);
    if (hit) findings.push(`no-teeth phrase: "${hit[0]}"`);
  }

  // Anti-triggers: the doctrine's highest-leverage cheap addition. What matters
  // is that a competing neighbour is NAMED — "not for X, use other-skill"
  // suppresses the false positive and routes the request. A description that
  // hands work to a named sibling counts even when phrased positively
  // ("to judge whether the work is right, use golem:reviewing"), which is why
  // this is not just a search for negative wording.
  const namesSibling = [...desc.matchAll(/golem:([a-z0-9-]+)/g)].some((m) => m[1] !== name);
  const negativeWording = /when NOT to use/i.test(body)
    || /\b(not for|not needed for|do not use|never use)\b/i.test(desc)
    || /\bnot for\b/i.test(body);
  if (!namesSibling && !negativeWording) {
    findings.push('no anti-trigger — nothing says when NOT to load it, and no sibling skill is named');
  }

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
