// TKT-0339: specs are project-scoped. The Tracker serves both work items and
// specs (Work items | Specs toggle), specs are a sub-board in the project view,
// every ticket shows a read-only Project field, and the standalone /specs page
// is gone (redirected to /tracker?view=specs). Web-assets only — no restart.
//
// Journey (scratch spec w/ a unique body token + a scratch work-item in
// golem-1eba80; archive both in finally):
//   1. /specs redirects to the tracker specs view (pathname /tracker, ?view=specs).
//   2. Tracker default (work-items): work-item card visible, spec NOT.
//   3. Toggle Specs → spec card visible under Draft, work-item gone; URL ?view=specs.
//   4. Browser Back → work-items mode (work-item visible, spec gone).
//   5. Content search in specs mode (token → 1 flat result with <mark>).
//   6. Project view: Specs collapsible section (count ≥ 1); expand → spec card;
//      + New spec → composer with the project pre-set.
//   7. Drawer: a Project row naming the project; clicking it → project view.
//   8. Sidebar has no Specs entry. Zero pageerror.

import { acquireChrome } from './_chrome.mjs';
import { strict as assert } from 'node:assert';

const API = 'http://dashboard.golem.localhost:7420/api';
const ORIGIN = 'http://dashboard.golem.localhost:7420';
const TOKEN = `kookaburra-0339-${Date.now().toString(36)}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body) => fetch(`${API}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const patch = (p, body) => fetch(`${API}${p}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const get = (p) => fetch(`${API}${p}`).then((r) => r.json());
const poll = async (fn, pred, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const v = await fn(); if (pred(v)) return v; await wait(150); }
  return fn();
};

const SPEC_BODY = `# SMOKE-0339 scratch spec\n\nA scratch spec used to verify the tracker specs toggle + the project-view sub-board. The searchable token: ${TOKEN}. It appears once.`;

const { browser, cleanup } = await acquireChrome();
const page = browser.contexts()[0]?.pages()[0] ?? await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
const pageerrors = [];
page.on('pageerror', (e) => pageerrors.push(e.message));

let specId = null, workId = null;
const created = [];
try {
  // Resolve a REGISTERED project — the project view only exists for registered
  // projects, and golem-1eba80 (the dashboard's own repo) isn't in the registry.
  const projects = await get('/projects');
  const proj = (Array.isArray(projects) ? projects : []).find((p) => p.id && p.project_id);
  assert.ok(proj, 'found a registered project for the project-view step');
  const PROJECT = proj.project_id;
  const registryId = proj.id;

  specId = (await post('/tickets', { project_id: PROJECT, kind: 'spec', created_by: 'smoke', title: 'SMOKE-0339 spec', body: SPEC_BODY })).id; created.push(specId);
  workId = (await post('/tickets', { project_id: PROJECT, kind: 'work-item', created_by: 'smoke', title: 'SMOKE-0339 work item', body: 'A scratch work item.' })).id; created.push(workId);
  assert.ok(specId && workId, 'created scratch spec + work-item');

  // ── 1. /specs redirects to the tracker specs view ─────────────────────────
  await page.goto(`${ORIGIN}/specs`, { waitUntil: 'networkidle' });
  await wait(600);
  let redir = await page.evaluate(() => ({ pathname: location.pathname, search: location.search }));
  assert.equal(redir.pathname, '/tracker', `/specs redirected to /tracker (got ${redir.pathname})`);
  assert.ok(/view=specs/.test(redir.search), `redirect URL carries view=specs (got ${redir.search})`);

  // ── 2. Tracker default (work-items): work-item visible, spec NOT ──────────
  await page.goto(`${ORIGIN}/tracker`, { waitUntil: 'networkidle' });
  await wait(600);
  let wi = await page.evaluate(({ w, s }) => ({
    workVisible: !!document.querySelector(`.ticket[data-ticket-id="${w}"]`),
    specVisible: !!document.querySelector(`.ticket[data-ticket-id="${s}"]`),
  }), { w: workId, s: specId });
  assert.ok(wi.workVisible, 'work-item card visible on /tracker (work-items mode)');
  assert.ok(!wi.specVisible, 'spec card NOT visible on /tracker (work-items mode excludes specs)');

  // ── 3. Toggle Specs → spec card under Draft, work-item gone; URL ?view=specs ──
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('.tracker-view-btn')).find((b) => /Specs/.test(b.textContent));
    if (btn) btn.click();
  });
  await poll(() => page.evaluate((s) => !!document.querySelector(`.ticket[data-ticket-id="${s}"]`), specId), (v) => !!v, 8000);
  let sp = await page.evaluate(({ w, s }) => ({
    specDraft: !!document.querySelector(`.kanban-col[data-col="todo"] .ticket[data-ticket-id="${s}"]`),
    draftHeader: document.querySelector('.kanban-col[data-col="todo"] .kanban-col-title')?.textContent || '',
    workGone: !document.querySelector(`.ticket[data-ticket-id="${w}"]`),
  }), { w: workId, s: specId });
  assert.ok(sp.specDraft, 'spec card visible under the Draft column in specs mode');
  assert.match(sp.draftHeader, /Draft/, `Draft column header (got "${sp.draftHeader}")`);
  assert.ok(sp.workGone, 'work-item card NOT visible in specs mode');
  let specsUrl = await page.evaluate(() => location.search);
  assert.ok(/view=specs/.test(specsUrl), `URL carries view=specs after the toggle (got ${specsUrl})`);

  // ── 4. Browser Back → work-items mode ─────────────────────────────────────
  await page.goBack();
  await wait(600);
  let back = await page.evaluate(({ w, s }) => ({
    workVisible: !!document.querySelector(`.ticket[data-ticket-id="${w}"]`),
    specGone: !document.querySelector(`.ticket[data-ticket-id="${s}"]`),
  }), { w: workId, s: specId });
  assert.ok(back.workVisible, 'Back → work-item visible again (work-items mode)');
  assert.ok(back.specGone, 'Back → spec card gone');

  // ── 5. Content search in tracker specs mode ───────────────────────────────
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('.tracker-view-btn')).find((b) => /Specs/.test(b.textContent));
    if (btn) btn.click();
  });
  await wait(500);
  await page.fill('.tracker-search', TOKEN);
  await wait(750);
  let srch = await page.evaluate(() => ({
    hasList: !!document.querySelector('.specs-search-list'),
    rowCount: document.querySelectorAll('.spec-result-row').length,
    markText: document.querySelector('.spec-result-snippet mark')?.textContent || null,
  }));
  assert.ok(srch.hasList, 'content search shows the flat result list in specs mode');
  assert.equal(srch.rowCount, 1, `exactly one search result (got ${srch.rowCount})`);
  assert.ok(srch.markText && srch.markText.includes(TOKEN), `<mark> wraps the token (got "${srch.markText}")`);
  await page.fill('.tracker-search', '');
  await wait(400);

  // ── 6. Project view: Specs collapsible section ────────────────────────────
  await page.goto(`${ORIGIN}/project/${encodeURIComponent(registryId)}`, { waitUntil: 'networkidle' });
  await wait(700);
  // Find the Specs collapsible section (by title).
  let specsSection = await page.evaluate(() => {
    const heads = Array.from(document.querySelectorAll('.pv-collapse-head'));
    const h = heads.find((x) => /Specs/.test(x.querySelector('.pv-collapse-title')?.textContent || ''));
    return { found: !!h, count: h ? (h.querySelector('.pv-collapse-count')?.textContent || '') : '' };
  });
  assert.ok(specsSection.found, 'project view has a Specs collapsible section');
  assert.ok(Number(specsSection.count) >= 1, `Specs section count ≥ 1 (got ${specsSection.count})`);
  // Expand it (click the head) → the spec card appears.
  await page.evaluate(() => {
    const heads = Array.from(document.querySelectorAll('.pv-collapse-head'));
    const h = heads.find((x) => /Specs/.test(x.querySelector('.pv-collapse-title')?.textContent || ''));
    if (h) h.click();
  });
  await poll(() => page.evaluate((s) => !!document.querySelector(`.ticket[data-ticket-id="${s}"]`), specId), (v) => !!v, 8000);
  assert.ok(await page.evaluate((s) => !!document.querySelector(`.ticket[data-ticket-id="${s}"]`), specId), 'expanding the Specs section shows the spec card');
  // + New spec → composer with the project pre-set.
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('.specs-board .orch-btn.primary')).find((b) => /New spec/.test(b.textContent));
    if (btn) btn.click();
  });
  await wait(700);
  let composerProject = await page.evaluate(() => {
    const fields = Array.from(document.querySelectorAll('.ct-field'));
    const f = fields.find((fld) => fld.querySelector('.ct-label')?.textContent.trim() === 'Project');
    return f ? (f.querySelector('select.ct-input')?.value ?? null) : null;
  });
  assert.equal(composerProject, PROJECT, `+ New spec in the project view opens the composer with the project pre-set (got ${composerProject})`);
  // Close the composer.
  await page.evaluate(() => document.querySelector('.drawer-compose .drawer-close')?.click());
  await wait(400);

  // ── 7. Drawer: Project row → navigates to the project view ────────────────
  await page.goto(`${ORIGIN}/tickets/${encodeURIComponent(specId)}`, { waitUntil: 'networkidle' });
  await wait(800);
  let projRow = await page.evaluate((name) => {
    const row = document.querySelector('.td-prop-project');
    if (!row) return null;
    const chip = row.querySelector('.td-project-chip-link');
    return { hasRow: true, name: row.textContent, hasLink: !!chip, href: chip?.getAttribute('href') || '' };
  }, proj.name);
  assert.ok(projRow && projRow.hasRow, 'ticket drawer has a Project row');
  assert.ok(projRow.name.includes(proj.name), `Project row names the project "${proj.name}" (got "${projRow.name}")`);
  assert.ok(projRow.hasLink && /\/project\//.test(projRow.href), `Project row links to the project view (href "${projRow.href}")`);
  // Click the project chip → navigates to the project view.
  await page.evaluate(() => document.querySelector('.td-prop-project .td-project-chip-link')?.click());
  await wait(600);
  let navigated = await page.evaluate(() => location.pathname);
  assert.ok(navigated.startsWith('/project/'), `clicking the Project row navigates to the project view (got ${navigated})`);

  // ── 8. Sidebar has no Specs entry; zero pageerror ──────────────────────────
  let sidebar = await page.evaluate(() => Array.from(document.querySelectorAll('.sidebar-link')).map((a) => a.textContent.trim()));
  assert.ok(!sidebar.some((t) => /^Specs$/.test(t)), `sidebar has no Specs entry (got ${sidebar.join(', ')})`);
  assert.equal(pageerrors.length, 0, `no pageerror events (got ${pageerrors.length}: ${pageerrors.join(' | ')})`);

  console.log(JSON.stringify({ ok: true, specId, workId, redirect: redir.pathname, specsCount: specsSection.count, composerProject, navigated }, null, 2));
} finally {
  for (const id of created) { try { await patch(`/tickets/${encodeURIComponent(id)}`, { state: 'archived' }); } catch {} }
  await cleanup();
}