import fs from 'node:fs';
import path from 'node:path';

import { golemHome } from './golem-home.js';

export const LEGACY_WRITER_RETIRED_CODE = 'GOLEM_LEGACY_WRITER_RETIRED';
export const LEGACY_WRITER_QUIESCED_CODE = 'GOLEM_LEGACY_WRITER_QUIESCED';

export class LegacyWriterGuardError extends Error {
  constructor(code, surface, authority) {
    const remedy = code === LEGACY_WRITER_QUIESCED_CODE
      ? 'wait for cutover to finish or run `golem migrate cutover-rollback --home <GOLEM_HOME>`'
      : 'use the typed control-plane API/CLI/MCP route; rollback C4 explicitly before invoking a legacy writer';
    super(`${code}: ${surface} cannot write while authority is ${authority.stage}/${authority.write_policy}; ${remedy}`);
    this.name = 'LegacyWriterGuardError';
    this.code = code;
    this.surface = surface;
    this.authority = authority;
    this.remedy = remedy;
  }
}

export function legacyWriterAuthority({ home = golemHome() } = {}) {
  const target = path.join(path.resolve(home), 'control-plane', 'authority.json');
  try {
    const value = JSON.parse(fs.readFileSync(target, 'utf8'));
    const valid = value?.schema_version === 'golem.control-plane-authority/v1'
      && (value.stage === 'C3' || value.stage === 'C4')
      && ['legacy_open', 'quiesced', 'canonical_only'].includes(value.write_policy)
      && Number.isInteger(value.revision);
    if (!valid) {
      return Object.freeze({
        stage: 'invalid',
        write_policy: 'guarded',
        revision: -1,
        path: target,
      });
    }
    return Object.freeze({ ...value, path: target });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return Object.freeze({
        schema_version: 'golem.control-plane-authority/v1',
        stage: 'C3',
        write_policy: 'legacy_open',
        revision: 0,
        updated_at: '1970-01-01T00:00:00.000Z',
        path: target,
      });
    }
    return Object.freeze({
      stage: 'invalid',
      write_policy: 'guarded',
      revision: -1,
      path: target,
    });
  }
}

export function legacyWritesAllowed(options = {}) {
  const authority = legacyWriterAuthority(options);
  return authority.stage === 'C3' && authority.write_policy === 'legacy_open';
}

/**
 * Every retired JSON/timer writer calls this immediately before acquiring a
 * lock or touching a file. Missing state is the reversible C3 default; invalid
 * state fails closed so a corrupt pointer can never create mixed authority.
 */
export function assertLegacyWriterAllowed(surface, options = {}) {
  const authority = legacyWriterAuthority(options);
  if (authority.stage === 'C3' && authority.write_policy === 'legacy_open') return authority;
  const code = authority.write_policy === 'quiesced'
    ? LEGACY_WRITER_QUIESCED_CODE
    : LEGACY_WRITER_RETIRED_CODE;
  throw new LegacyWriterGuardError(code, surface, authority);
}
