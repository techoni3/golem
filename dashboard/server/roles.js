import { readRoleRegistry } from '../../lib/session-role.js';

export function roleMetaMap() {
  const out = {
    UNK: { label: 'Agent', color: '#8a909c', glyph: '..' },
  };
  for (const role of readRoleRegistry()) {
    out[role.name] = {
      label: role.name,
      color: role.color,
      glyph: role.glyph,
      builtin: !!role.builtin,
    };
  }
  return out;
}

export function roleFromSubagentType(subagentType) {
  return subagentType || null;
}
