// Pure helpers shared across the server.

export function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function shortId(s, n = 8) {
  if (!s) return '';
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, n);
}

// Cheap stable hash → palette colour for projects without an explicit color.
const PROJECT_PALETTE = [
  '#4ade80', '#60a5fa', '#f59e0b', '#c084fc', '#f472b6',
  '#22d3ee', '#a3e635', '#fb7185', '#fbbf24', '#34d399',
];

export function colorFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return PROJECT_PALETTE[h % PROJECT_PALETTE.length];
}

export function glyphFor(name) {
  // 2-char glyph from name. Strip non-letters, take first two letters; uppercase.
  const letters = String(name).replace(/[^a-zA-Z0-9]/g, '');
  if (letters.length === 0) return '··';
  if (letters.length === 1) return letters[0].toUpperCase().repeat(2);
  return (letters[0] + letters[1]).toUpperCase();
}

// Coerce a hook event ts (ISO string) → epoch ms. Falls back to Date.now().
export function tsMs(s) {
  if (!s) return Date.now();
  const v = Date.parse(s);
  return Number.isFinite(v) ? v : Date.now();
}

export function clampList(list, max) {
  if (list.length <= max) return list;
  return list.slice(list.length - max);
}

export async function fileExists(p) {
  try {
    const fs = await import('node:fs/promises');
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
