import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('usage: generate.mjs <openapi.json> <output.ts>');

const toolRoot = dirname(fileURLToPath(import.meta.url));
const cli = join(toolRoot, 'node_modules', 'openapi-typescript', 'bin', 'cli.js');
const exit = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [cli, input, '-o', output], { stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve({ code, signal }));
});
if (exit.code !== 0) {
  throw new Error(`openapi-typescript exited ${exit.code ?? 1}${exit.signal ? ` (${exit.signal})` : ''}`);
}
