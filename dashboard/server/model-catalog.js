// Pi model catalog bridge for the dashboard editor.
//
// Pi intentionally exposes a fixed-width, human-readable table instead of a
// JSON mode. Keep parsing here, away from the route and UI, so the column
// offsets remain covered by a small deterministic test. Catalog failures are
// editor-only: callers can keep using the last-good cache or an empty catalog.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { profilesPath } from '../../lib/model-profiles.js';

const CATALOG_VERSION = 1;
const CATALOG_TIMEOUT_MS = 15_000;
const CATALOG_MAX_BUFFER = 4 * 1024 * 1024;
const HEADER_FIELDS = ['provider', 'model', 'context', 'max-out', 'thinking', 'images'];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function catalogShape(value) {
  if (!isRecord(value) || !Array.isArray(value.providers) || !isRecord(value.modelsByProvider)) {
    throw new Error('model catalog must contain providers[] and modelsByProvider{}');
  }
  const providers = [];
  const seenProviders = new Set();
  for (const provider of value.providers) {
    if (typeof provider !== 'string' || !provider.trim()) continue;
    const normalized = provider.trim();
    if (seenProviders.has(normalized)) continue;
    seenProviders.add(normalized);
    providers.push(normalized);
  }
  const modelsByProvider = {};
  for (const provider of providers) {
    const rows = Array.isArray(value.modelsByProvider[provider]) ? value.modelsByProvider[provider] : [];
    const seenModels = new Set();
    modelsByProvider[provider] = rows
      .filter((model) => typeof model === 'string' && model.trim())
      .map((model) => model.trim())
      .filter((model) => {
        if (seenModels.has(model)) return false;
        seenModels.add(model);
        return true;
      });
  }
  return { providers, modelsByProvider };
}

/**
 * Parse Pi's fixed-width table using the header's column offsets.
 *
 * A whitespace split is not safe here: model ids may contain spaces in future
 * Pi releases, and the visible column widths are the contract we have today.
 */
export function parsePiModelCatalog(output) {
  const lines = String(output ?? '').split(/\r?\n/).filter((line) => line.trim());
  const headerIndex = lines.findIndex((line) => HEADER_FIELDS.every((field) => line.indexOf(field) >= 0));
  if (headerIndex < 0) throw new Error('Pi model catalog header not found');
  const header = lines[headerIndex];
  const offsets = HEADER_FIELDS.map((field) => header.indexOf(field));
  if (offsets.some((offset, index) => offset < 0 || (index > 0 && offset <= offsets[index - 1]))) {
    throw new Error('Pi model catalog header columns are not ordered');
  }

  const providers = [];
  const modelsByProvider = {};
  const seenProviders = new Set();
  const seenModels = new Map();
  for (const line of lines.slice(headerIndex + 1)) {
    const fields = offsets.map((start, index) => line.slice(start, offsets[index + 1] ?? line.length).trim());
    const [provider, model] = fields;
    if (!provider || !model || provider === 'provider' || model === 'model') continue;
    if (!seenProviders.has(provider)) {
      seenProviders.add(provider);
      providers.push(provider);
      modelsByProvider[provider] = [];
      seenModels.set(provider, new Set());
    }
    const modelSet = seenModels.get(provider);
    if (modelSet.has(model)) continue;
    modelSet.add(model);
    modelsByProvider[provider].push(model);
  }
  return catalogShape({ providers, modelsByProvider });
}

/** Shell the real Pi binary in offline mode. Throws on an unusable response. */
export function readPiModelCatalog({ executable = 'pi', env = process.env } = {}) {
  const result = spawnSync(executable, ['--list-models'], {
    env: { ...env, PI_OFFLINE: '1' },
    encoding: 'utf8',
    timeout: CATALOG_TIMEOUT_MS,
    maxBuffer: CATALOG_MAX_BUFFER,
  });
  if (result.error) throw new Error(`could not run ${executable} --list-models: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || `exit ${result.status}`).trim();
    throw new Error(`${executable} --list-models failed: ${detail}`);
  }
  return parsePiModelCatalog(result.stdout);
}

export const CATALOG_CACHE_TTL_MS = 60 * 1000;

export function isCatalogCacheExpired(cached, now = Date.now(), ttlMs = CATALOG_CACHE_TTL_MS) {
  if (!cached || !cached.fetched_at) return true;
  const parsed = Date.parse(cached.fetched_at);
  if (!Number.isFinite(parsed)) return true;
  return now - parsed > ttlMs;
}

export function modelCatalogCachePath() {
  return path.join(path.dirname(profilesPath()), 'model-catalog.json');
}

function atomicWriteJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, target);
}

export function readModelCatalogCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(modelCatalogCachePath(), 'utf8'));
    const catalog = catalogShape(parsed?.catalog ?? parsed);
    return {
      catalog,
      fetched_at: parsed?.fetched_at ?? null,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return null;
  }
}

export function writeModelCatalogCache(catalog, fetchedAt = new Date().toISOString()) {
  const normalized = catalogShape(catalog);
  atomicWriteJson(modelCatalogCachePath(), {
    version: CATALOG_VERSION,
    fetched_at: fetchedAt,
    catalog: normalized,
  });
  return { catalog: normalized, fetched_at: fetchedAt };
}

export function normalizeModelCatalog(value) {
  return catalogShape(value);
}

export { CATALOG_VERSION };
