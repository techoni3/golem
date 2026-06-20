#!/usr/bin/env node
// jsx-check — transform every dashboard/web/src/*.jsx with @babel/standalone
// using the SAME presets the browser applies (data-presets="env,react"), so a
// pass here proves the file will transform in babel-standalone at runtime.
//
// @babel/standalone is not a project dependency (it loads from a CDN in the
// browser). This script resolves it from wherever it is installed — pass the
// install dir as BABEL_STANDALONE_DIR, else it tries a sibling _babelcheck dir,
// else node_modules. Documented in the WS5a verify report.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '..', 'web', 'src');

function loadBabel() {
  const candidates = [
    process.env.BABEL_STANDALONE_DIR,
    '/tmp/_babelcheck',
    path.resolve(__dirname, '..'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      const req = createRequire(path.join(dir, 'noop.js'));
      return req('@babel/standalone');
    } catch { /* try next */ }
  }
  throw new Error('@babel/standalone not found. Set BABEL_STANDALONE_DIR to its install dir.');
}

const Babel = loadBabel();
const files = readdirSync(SRC).filter((f) => f.endsWith('.jsx')).sort();
let failed = 0;
for (const f of files) {
  const code = readFileSync(path.join(SRC, f), 'utf8');
  try {
    Babel.transform(code, { presets: ['env', 'react'], filename: f });
    console.log(`ok    ${f}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${f}\n      ${err.message.split('\n')[0]}`);
  }
}
console.log(`\n${files.length - failed}/${files.length} transformed`);
process.exit(failed ? 1 : 0);
