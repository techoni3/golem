#!/usr/bin/env node
import { upsertSessionFact } from './session-facts.js';

try {
  const input = JSON.parse(process.argv[2] || '{}');
  upsertSessionFact(input);
} catch (error) {
  process.stderr.write(`[golem-session-fact] ${error.message}\n`);
  process.exitCode = 1;
}
