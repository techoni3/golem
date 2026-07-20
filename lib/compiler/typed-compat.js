// Compatibility facade for the still-public `golem sync` entrypoints. Render
// ownership lives in the typed compiler; this module only translates legacy
// adapter plans and preserves the historical summary shape for callers.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  compileRender,
  inspectRender,
  lockForManifest,
  manifestFromLegacyPlan,
} from '../../packages/compiler/dist/index.js';
import { readLockfile, writeLockfile } from './engine.js';

function manifestFor({ target, items, packageVersion }) {
  return manifestFromLegacyPlan({
    // Compatibility targets include independently-rendered instruction slices;
    // their stable legacy name is metadata and does not widen the public typed
    // target union used by new callers.
    target,
    sourceRoot: 'legacy-adapter-plan',
    version: packageVersion ?? '0.0.0',
    items,
  });
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function ensureTrailingNewline(value) {
  return value.endsWith('\n') ? value : `${value}\n`;
}

function framedBlock(value, region) {
  return `${region.begin}\n${ensureTrailingNewline(value)}${region.end}\n`;
}

function parseManaged(contents, region) {
  if (contents.split(region.begin).length !== 2 || contents.split(region.end).length !== 2) return null;
  const begin = contents.indexOf(region.begin) + region.begin.length;
  const start = contents.startsWith('\n', begin) ? begin + 1 : begin;
  const end = contents.indexOf(region.end, start);
  return end < start ? null : contents.slice(start, end);
}

function currentFileHash(outDir, file) {
  const output = path.join(outDir, file.outputPath);
  try {
    const contents = fs.readFileSync(output, 'utf8');
    if (!file.managedRegion) return sha256(contents);
    const inner = parseManaged(contents, file.managedRegion);
    return inner === null ? null : sha256(framedBlock(inner, file.managedRegion));
  } catch {
    return null;
  }
}

/** Typed compiler-backed implementation of the legacy sync renderer. */
export function render({ target, outDir, items, packageVersion, force = false }) {
  const manifest = manifestFor({ target, items, packageVersion });
  const receipt = compileRender(manifest, { outputDir: outDir, force });
  if (receipt.status === 'refused') {
    return {
      written: [],
      unchanged: [],
      pruned: [],
      tampered: [{ key: receipt.refusal.outputPath, outputRelPath: receipt.refusal.outputPath, reason: receipt.refusal.code }],
    };
  }
  return {
    written: receipt.written,
    unchanged: [],
    pruned: [],
    tampered: [],
  };
}

/** Typed compiler-backed check used by all production sync/check paths. */
export function checkDrift({ target, outDir, items, packageVersion = '0.0.0' }) {
  const manifest = manifestFor({ target, items, packageVersion });
  const expected = lockForManifest(manifest);
  const actual = inspectRender(outDir);
  const drifted = [];
  if (!actual) {
    for (const file of expected.files) drifted.push({ key: file.outputPath, reason: 'new' });
    return { clean: false, drifted, orphaned: [] };
  }
  for (const file of actual.files) {
    const diskHash = currentFileHash(outDir, file);
    if (diskHash !== file.sha256) drifted.push({ key: file.outputPath, reason: 'tampered' });
  }
  const expectedByPath = new Map(expected.files.map((file) => [file.outputPath, file]));
  const actualPaths = new Set(actual.files.map((file) => file.outputPath));
  for (const file of expected.files) {
    const existing = actual.files.find((candidate) => candidate.outputPath === file.outputPath);
    if (!existing || existing.sha256 !== file.sha256) drifted.push({ key: file.outputPath, reason: existing ? 'changed' : 'new' });
  }
  const orphaned = actual.files
    .filter((file) => !expectedByPath.has(file.outputPath))
    .map((file) => ({ key: file.outputPath }));
  return { clean: drifted.length === 0 && orphaned.length === 0 && actual.manifestSha256 === expected.manifestSha256 && actualPaths.size === expectedByPath.size, drifted, orphaned };
}

// Dashboard status still reads the pre-cutover aggregate lock for historical
// presentation only. It is not used to select bytes or decide a typed render.
export { readLockfile, writeLockfile };
