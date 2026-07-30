#!/usr/bin/env node
// measure-turns — what the human actually has to read.
//
// Reports the per-TURN distribution of visible assistant output: everything
// emitted between one human message and the next. Per-message stats badly
// understate this, because one turn can emit dozens of interstitial texts
// around tool calls — which is the real source of over-long turns in this repo
// (median block is ~31 words; the p90 turn emits ~30 blocks).
//
// This exists so the response contract in substrate/instructions/AGENTS.md is
// checkable rather than a matter of opinion. Run it before and after changing
// that section: if the p75 does not move, the change did nothing.
//
// Read-only. Excludes thinking blocks, tool_use/tool_result, meta rows, and
// sidechain (subagent) output — none of which the human reads.
//
// Usage:
//   node scripts/measure-turns.mjs [transcriptDir]
//   npm run measure:turns
//
// transcriptDir defaults to this project's Claude Code transcript directory.
// Point it at another project's directory to compare.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

// Claude Code encodes the project path into the transcript directory name by
// replacing every path separator and dot with a hyphen.
function defaultTranscriptDir() {
  const encoded = resolve(process.cwd()).replace(/[/.]/g, '-');
  return join(homedir(), '.claude', 'projects', encoded);
}

const transcriptDir = process.argv[2] ?? defaultTranscriptDir();
if (!existsSync(transcriptDir)) {
  console.error(`no transcript directory at ${transcriptDir}`);
  console.error('pass one explicitly: node scripts/measure-turns.mjs <dir>');
  process.exit(2);
}

// A real human turn is human-authored: not a tool_result carrier, not a
// system-injected reminder, not subagent traffic.
function isHumanTurn(row) {
  if (row.type !== 'user' || row.isMeta || row.isSidechain) return false;
  const content = row.message?.content;
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((block) => block?.type === 'text' && (block.text ?? '').trim())
    && !content.some((block) => block?.type === 'tool_result');
}

function visibleText(row) {
  const content = row.message?.content;
  if (!Array.isArray(content)) return '';
  return content.filter((block) => block?.type === 'text').map((block) => block.text ?? '').join('');
}

const files = readdirSync(transcriptDir)
  .filter((name) => name.endsWith('.jsonl'))
  .map((name) => ({ name, path: join(transcriptDir, name) }));

const turns = [];
for (const { name, path: file } of files) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch { continue; }
  let current = null;
  const flush = () => { if (current && current.words > 0) turns.push(current); };
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.isSidechain) continue;
    if (isHumanTurn(row)) {
      flush();
      current = { session: name.slice(0, 8), words: 0, lines: 0, blocks: 0 };
      continue;
    }
    if (row.type !== 'assistant' || !current) continue;
    const text = visibleText(row).trim();
    if (!text) continue;
    current.words += text.split(/\s+/).length;
    current.lines += text.split('\n').length;
    current.blocks += 1;
  }
  flush();
}

if (!turns.length) {
  console.error(`no turns with a visible reply found in ${transcriptDir}`);
  process.exit(1);
}

const WPM = 200; // careful reading of technical prose
const CEILING_MIN = 3; // the standing budget in AGENTS.md § Response Contract
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const MARKS = [0.5, 0.75, 0.9, 0.95, 0.99];

const words = turns.map((t) => t.words).sort((a, b) => a - b);
const lines = turns.map((t) => t.lines).sort((a, b) => a - b);
const blocks = turns.map((t) => t.blocks).sort((a, b) => a - b);

console.log(`transcripts: ${files.length}   turns with a reply: ${turns.length}`);
console.log(`source: ${transcriptDir}`);
console.log('');
console.log(`${''.padEnd(14)}${MARKS.map((p) => `p${p * 100}`.padStart(7)).join('')}${'max'.padStart(7)}`);
for (const [label, series] of [['words/turn', words], ['lines/turn', lines], ['blocks/turn', blocks]]) {
  const cells = MARKS.map((p) => String(percentile(series, p)).padStart(7)).join('');
  console.log(`${label.padEnd(14)}${cells}${String(series.at(-1)).padStart(7)}`);
}

console.log('');
console.log(`reading time at ${WPM} wpm (budget: ${CEILING_MIN} min):`);
for (const p of MARKS) {
  const w = percentile(words, p);
  const minutes = w / WPM;
  console.log(`  p${String(p * 100).padEnd(3)} ${String(w).padStart(6)} words  ${minutes.toFixed(1)} min`
    + (minutes > CEILING_MIN ? '   OVER' : ''));
}

const overBudget = words.filter((w) => w > WPM * CEILING_MIN).length;
console.log('');
console.log(`over budget: ${overBudget}/${turns.length} turns `
  + `(${((overBudget / turns.length) * 100).toFixed(0)}%) exceed ${WPM * CEILING_MIN} words`);
