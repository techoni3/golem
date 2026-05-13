// subagent_type → role glyph + display label + accent color.
// Mirrors the design's ROLES map but expanded to cover every persona shipped
// in golem/substrate/agents/. Sub-agent types not in this map fall back to a
// neutral glyph so unknown agents still render.

export const ROLES = {
  TL: { label: 'TL', color: '#f59e0b', glyph: 'TL' },
  PA: { label: 'Product Architect', color: '#a78bfa', glyph: 'PA' },
  PAR: { label: 'Product Arch Reviewer', color: '#c084fc', glyph: 'PR' },
  TA: { label: 'Tech Architect', color: '#60a5fa', glyph: 'TA' },
  TAR: { label: 'Tech Arch Reviewer', color: '#7dd3fc', glyph: 'TR' },
  ENG: { label: 'Engineer', color: '#4ade80', glyph: 'EN' },
  TSW: { label: 'Test Spec Writer', color: '#a3e635', glyph: 'TS' },
  TW: { label: 'Test Writer', color: '#34d399', glyph: 'TW' },
  CR: { label: 'Code Reviewer', color: '#22d3ee', glyph: 'CR' },
  DG: { label: 'Diagnoser', color: '#fb7185', glyph: 'DG' },
  DOC: { label: 'Documentarian', color: '#fbbf24', glyph: 'DC' },
  CDO: { label: 'Cloud DevOps', color: '#f472b6', glyph: 'CD' },
  LDO: { label: 'Local DevOps', color: '#fb923c', glyph: 'LD' },
  UX: { label: 'UX Designer', color: '#e879f9', glyph: 'UX' },
  SUB: { label: 'Substrator', color: '#94a3b8', glyph: 'SB' },
  SCO: { label: 'Scout', color: '#facc15', glyph: 'SC' },
  PRO: { label: 'Prospector', color: '#fde047', glyph: 'PR' },
  SME: { label: 'Smelter', color: '#f97316', glyph: 'SM' },
  MET: { label: 'Meta', color: '#a78bfa', glyph: 'MT' },
  ORC: { label: 'Orchestrator', color: '#4ade80', glyph: 'GO' },
  UNK: { label: 'Agent', color: '#8a909c', glyph: '··' },
};

const SUBAGENT_TO_ROLE = {
  'golem-tl': 'TL',
  'golem-product-architect': 'PA',
  'golem-product-architecture-reviewer': 'PAR',
  'golem-tech-architect': 'TA',
  'golem-tech-architecture-reviewer': 'TAR',
  'golem-engineer': 'ENG',
  'golem-test-spec-writer': 'TSW',
  'golem-test-writer': 'TW',
  'golem-code-reviewer': 'CR',
  'golem-diagnoser': 'DG',
  'golem-documentarian': 'DOC',
  'golem-cloud-devops': 'CDO',
  'golem-local-devops': 'LDO',
  'golem-ux-designer': 'UX',
  'golem-substrator': 'SUB',
  'golem-scout': 'SCO',
  'golem-prospector': 'PRO',
  'golem-smelter': 'SME',
  'golem-meta': 'MET',
};

export function roleFromSubagentType(subagentType) {
  if (!subagentType) return null;
  return SUBAGENT_TO_ROLE[subagentType] ?? null;
}
