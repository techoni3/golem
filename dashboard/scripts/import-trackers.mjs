#!/usr/bin/env node
// Legacy tracker importer — one-shot, idempotent migration from the markdown
// trackers (tracker/<state>/*.md) into the new SQLite tracker DB.
//
// Scans registered projects, parses each ticket's frontmatter+body with
// gray-matter, maps the old state-dir / category onto the new state / kind,
// preserves the original id as an `orig:<id>` label, and stamps source_ref to
// the absolute file path. Re-running is safe: any file whose source_ref is
// already present is skipped.
//
//   node dashboard/scripts/import-trackers.mjs            # --all (default)
//   node dashboard/scripts/import-trackers.mjs --project sudoku
//   node dashboard/scripts/import-trackers.mjs --dry-run
//
// Project resolution order:
//   1. ~/.config/golem/projects.json (the registry the rest of the app uses)
//   2. fallback scan of GOLEM_PROJECTS_ROOT / golem-projects/* for dirs that
//      have a tracker/ subdir but aren't in the registry.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { openTrackerDb } from '../server/tracker-db.js';
import { projectsJsonPath } from '../../lib/golem-home.js';

const require = createRequire(import.meta.url);
const matter = require('gray-matter');

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Default golem-projects root, mirroring CONFIG.projectsRoot in config.js.
function projectsRoot() {
  return (
    process.env.GOLEM_PROJECTS_ROOT ??
    path.resolve(HERE, '..', '..', 'golem-projects')
  );
}

// Old state-dir → new state.
const STATE_MAP = {
  triage: 'todo',
  open: 'todo',
  'in-progress': 'in_progress',
  review: 'review',
  blocked: 'blocked',
  done: 'done',
};

// Old category → new kind.
const KIND_MAP = {
  feature: 'work-item',
  fix: 'fix',
  infra: 'work-item',
  docs: 'spec',
  spike: 'spec',
};
function kindForCategory(category) {
  if (!category) return 'work-item';
  return KIND_MAP[String(category).toLowerCase()] ?? 'work-item';
}

function parseArgs(argv) {
  const opts = { all: true, project: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') opts.all = true;
    else if (a === '--dry-run' || a === '--dryrun') opts.dryRun = true;
    else if (a === '--project') {
      opts.project = argv[++i] ?? null;
      opts.all = false;
    } else if (a.startsWith('--project=')) {
      opts.project = a.slice('--project='.length);
      opts.all = false;
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

// Load the project registry. Returns [] if missing/unparseable.
function loadRegistry() {
  const file = projectsJsonPath();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  try {
    const json = JSON.parse(raw);
    return Array.isArray(json.projects) ? json.projects : [];
  } catch (err) {
    console.error(`[import] failed to parse ${file}: ${err.message}`);
    return [];
  }
}

function hasTrackerDir(projectPath) {
  try {
    return fs.statSync(path.join(projectPath, 'tracker')).isDirectory();
  } catch {
    return false;
  }
}

// Build the list of {id, name, path} to import. Registry first; then any
// golem-projects/* dir with a tracker/ that the registry didn't already cover.
function resolveProjects() {
  const registry = loadRegistry();
  const byPath = new Map();
  const out = [];
  for (const p of registry) {
    if (!p.path || !p.id) continue;
    const abs = path.resolve(p.path);
    byPath.set(abs, true);
    if (hasTrackerDir(abs)) {
      out.push({ id: p.id, name: p.name ?? p.id, path: abs });
    }
  }
  // Fallback scan.
  const root = projectsRoot();
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const abs = path.resolve(root, e.name);
    if (byPath.has(abs)) continue; // already from registry
    if (hasTrackerDir(abs)) {
      out.push({ id: e.name, name: e.name, path: abs });
    }
  }
  return out;
}

// Collect ticket files for a project as {file, stateDir}.
function collectTicketFiles(projectPath) {
  const trackerDir = path.join(projectPath, 'tracker');
  const found = [];
  for (const stateDir of Object.keys(STATE_MAP)) {
    const dir = path.join(trackerDir, stateDir);
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      if (name.toLowerCase() === 'readme.md' || name.toLowerCase() === 'index.md') continue;
      found.push({ file: path.join(dir, name), stateDir });
    }
  }
  return found;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const allProjects = resolveProjects();
  const projects = opts.project
    ? allProjects.filter((p) => p.id === opts.project || p.name === opts.project)
    : allProjects;

  if (opts.project && projects.length === 0) {
    console.error(`[import] no registered project (with a tracker/) matched '${opts.project}'`);
    console.error(`[import] known: ${allProjects.map((p) => p.id).join(', ') || '(none)'}`);
    process.exit(1);
  }

  const db = opts.dryRun ? null : openTrackerDb();
  const dbPath = opts.dryRun ? '(dry-run, no DB opened)' : db.raw().name;

  // Pre-load the set of source_refs already imported (idempotency).
  const existingRefs = new Set();
  if (db) {
    for (const row of db.raw().prepare('SELECT source_ref FROM tickets WHERE source_ref IS NOT NULL').all()) {
      existingRefs.add(row.source_ref);
    }
  }

  let imported = 0;
  let skipped = 0;
  let errored = 0;

  console.log(`[import] mode=${opts.dryRun ? 'dry-run' : 'write'} db=${dbPath}`);
  console.log(`[import] projects: ${projects.map((p) => p.id).join(', ') || '(none)'}`);

  for (const project of projects) {
    const files = collectTicketFiles(project.path);
    if (files.length === 0) continue;
    console.log(`\n[import] ${project.id} — ${files.length} ticket file(s)`);
    for (const { file, stateDir } of files) {
      const sourceRef = path.resolve(file);

      // Idempotency: skip already-imported source files (only meaningful in
      // write mode — dry-run can't consult an in-DB record so it lists all).
      if (existingRefs.has(sourceRef)) {
        skipped++;
        continue;
      }

      let raw;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch (err) {
        console.error(`  [skip] unreadable ${sourceRef}: ${err.message}`);
        errored++;
        continue;
      }
      let parsed;
      try {
        parsed = matter(raw);
      } catch (err) {
        console.error(`  [skip] unparseable frontmatter ${sourceRef}: ${err.message}`);
        errored++;
        continue;
      }
      const fm = parsed.data ?? {};
      const origId = fm.id != null ? String(fm.id) : path.basename(file, '.md');
      const title = String(fm.title ?? origId);
      const body = parsed.content ?? '';
      const state = STATE_MAP[stateDir] ?? 'todo';
      const kind = kindForCategory(fm.category);

      // Preserve original labels plus the orig:<id> marker.
      const labels = Array.isArray(fm.labels) ? fm.labels.map(String) : [];
      labels.push(`orig:${origId}`);

      if (opts.dryRun) {
        console.log(`  [would import] ${origId} → kind=${kind} state=${state} :: ${title}`);
        imported++;
        continue;
      }

      try {
        const t = db.createTicket({
          project_id: project.id,
          kind,
          title,
          body,
          state,
          priority: fm.priority ? String(fm.priority) : null,
          labels,
          assignee: fm.assignee ? String(fm.assignee) : null,
          created_by: 'human',
          source_ref: sourceRef,
        });
        existingRefs.add(sourceRef);
        imported++;
        console.log(`  [import] ${origId} → ${t.id} (${kind}/${state})`);
      } catch (err) {
        console.error(`  [error] ${sourceRef}: ${err.message}`);
        errored++;
      }
    }
  }

  if (db) db.close();

  console.log(`\n[import] done — imported ${imported}, skipped ${skipped}${errored ? `, errored ${errored}` : ''}`);
  if (errored) process.exit(1);
}

main();
