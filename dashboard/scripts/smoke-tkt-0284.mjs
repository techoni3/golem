// TKT-0284: specs management v1 — specs board (separation by view), content
// search, spec→task children. Journey smoke: REST-creates a scratch spec
// (with a unique body token) + two tasks parented to it + one plain work-
// item, then drives the UI headlessly to verify:
//   1. separation — scratch spec on /specs Draft, NOT on /tracker
//      (tasks); plain task on /tracker, NOT on the specs view.
//   2. bounded board — overflowing spec columns scroll independently.
//   3. column relabel — PATCH spec → in_progress → card under "Refining".
//   4. content search — token → flat list with <mark> snippet; click → drawer;
//      clear → board; gibberish → empty state.
//   5. spec drawer Work-items panel — both children listed; + Work item opens
//      the composer with Kind=task; clicking a child navigates.
//   6. + New spec → composer with Kind=spec.
//   7. API contract — /api/tickets/search returns 1 row with snippet+offsets;
//      /api/tickets?excludeKind=spec has no spec rows.
// Archives all scratch tickets in finally.

import { acquireChrome } from './_chrome.mjs';
import { strict as assert } from 'node:assert';

const API = 'http://dashboard.golem.localhost:7420/api';
const ORIGIN = 'http://dashboard.golem.localhost:7420';
const PROJECT = 'golem-1eba80';
// Per-run unique token so prior failed runs' archived scratch specs (same
// static string in their bodies) don't match this run's content search — the
// search has no state filter, so archived specs would otherwise collide.
const TOKEN = `xylophone-spec-token-0284-${Date.now().toString(36)}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (path, body) => fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const patch = (path, body) => fetch(`${API}${path}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const get = (path) => fetch(`${API}${path}`).then((r) => r.json());

const SPEC_BODY = `# Scratch spec for TKT-0284 smoke

This is a multi-paragraph spec body used to exercise content search on the
Specs page. The unique token below lets the smoke assert exactly one match.

## Context

Some intro paragraphs. The quick brown fox jumps over the lazy dog. Specs
are persistent, doc-like entities that go through iterative refinements.

## Token

Here is the searchable token: ${TOKEN}. It appears once in the body so the
content search returns exactly one row with a snippet wrapping it in a mark.

## More content

A trailing paragraph so the token is not at the very end of the body either.`;

// Read a create-drawer field's select value by its label text (the composer
// labels the kind select "Type"). Returns null if the field/menu isn't found.
const ctFieldSelectValue = (labelText) => `(() => {
  const fields = Array.from(document.querySelectorAll('.ct-field'));
  const f = fields.find((fld) => {
    const lab = fld.querySelector('.ct-label');
    return lab && lab.textContent.trim() === ${JSON.stringify(labelText)};
  });
  return f ? (f.querySelector('select.ct-input')?.value ?? null) : null;
})()`;

const { browser, cleanup } = await acquireChrome();
const page = browser.contexts()[0]?.pages()[0] ?? await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
const pageerrors = [];
page.on('pageerror', (e) => pageerrors.push(e.message));

let specId = null, childA = null, childADisplay = null, childB = null, childBDisplay = null, plain = null;
const created = [];
try {
  // ── Scratch tickets ───────────────────────────────────────────────────────
  const specRes = await post('/tickets', { project_id: PROJECT, kind: 'spec', created_by: 'smoke', title: 'SMOKE-0284 scratch spec', body: SPEC_BODY });
  specId = specRes.id;
  created.push(specId);
  const childARes = await post('/tickets', { project_id: PROJECT, kind: 'task', created_by: 'smoke', title: 'SMOKE-0284 child A', parent_id: specId, body: 'First task under the scratch spec.' }); childA = childARes.id;
  childADisplay = childARes.display_id || childA;
  created.push(childA);
  const childBRes = await post('/tickets', { project_id: PROJECT, kind: 'task', created_by: 'smoke', title: 'SMOKE-0284 child B', parent_id: specId, body: 'Second task under the scratch spec.' }); childB = childBRes.id;
  childBDisplay = childBRes.display_id || childB;
  created.push(childB);
  plain = (await post('/tickets', { project_id: PROJECT, kind: 'task', created_by: 'smoke', title: 'SMOKE-0284 plain task', body: 'A plain task with no parent.' })).id;
  created.push(plain);
  assert.ok(specId && childA && childB && plain, 'created scratch spec + 2 children + 1 plain');

  // ── 1. Separation: spec on /specs Draft, not on /tracker; plain on /tracker ──
  await page.goto(`${ORIGIN}/specs`, { waitUntil: 'networkidle' });
  await wait(600);
  let sep = await page.evaluate((id) => {
    const draftCard = document.querySelector(`.kanban-col[data-col="todo"] .ticket[data-ticket-id="${id}"]`);
    const draftHeader = document.querySelector('.kanban-col[data-col="todo"] .kanban-col-title')?.textContent || '';
    return { onSpecsDraft: !!draftCard, draftHeader };
  }, specId);
  assert.ok(sep.onSpecsDraft, 'scratch spec renders on /specs in the Draft column');
  assert.match(sep.draftHeader, /Draft/, `Draft column header labeled "Draft" (got "${sep.draftHeader}")`);

  // Clone cards in-browser only to force overflow without creating tracker data.
  // The board must remain within the page while the column list becomes the
  // scroll container.
  const bounded = await page.evaluate((id) => {
    const pageEl = document.querySelector('.page.specs-page');
    const kanban = document.querySelector('.specs-board .kanban');
    const column = document.querySelector('.kanban-col[data-col="todo"]');
    const list = column?.querySelector('.kanban-list');
    const card = list?.querySelector(`.ticket[data-ticket-id="${id}"]`);
    if (!pageEl || !kanban || !column || !list || !card) return null;
    for (let i = 0; i < 40; i += 1) {
      const clone = card.cloneNode(true);
      clone.dataset.ticketId = `layout-clone-${i}`;
      list.appendChild(clone);
    }
    const pageRect = pageEl.getBoundingClientRect();
    const boardRect = kanban.getBoundingClientRect();
    const listStyle = getComputedStyle(list);
    return {
      overflowY: listStyle.overflowY,
      scrollHeight: list.scrollHeight,
      clientHeight: list.clientHeight,
      boardWithinPage: boardRect.bottom <= pageRect.bottom + 1,
      columnFillsBoard: column.clientHeight <= kanban.clientHeight
        && kanban.clientHeight - column.clientHeight <= 8,
    };
  }, specId);
  assert.ok(bounded, 'specs board layout elements are present');
  assert.equal(bounded.overflowY, 'auto', 'spec column list owns vertical scrolling');
  assert.ok(bounded.scrollHeight > bounded.clientHeight, 'overflowing spec column has scrollable content');
  assert.ok(bounded.boardWithinPage, 'specs board remains bounded by the page viewport');
  assert.ok(bounded.columnFillsBoard, 'spec column fills the bounded board height');

  await page.setViewportSize({ width: 1000, height: 900 });
  const narrow = await page.evaluate(() => {
    const kanban = document.querySelector('.specs-board .kanban');
    if (!kanban) return null;
    const style = getComputedStyle(kanban);
    kanban.scrollLeft = kanban.scrollWidth;
    return {
      overflowX: style.overflowX,
      hasHorizontalOverflow: kanban.scrollWidth > kanban.clientWidth,
      reachedLaterColumns: kanban.scrollLeft > 0,
    };
  });
  assert.ok(narrow, 'narrow specs board is present');
  assert.equal(narrow.overflowX, 'auto', 'narrow specs board exposes horizontal scrolling');
  assert.ok(narrow.hasHorizontalOverflow, 'narrow specs board overflows horizontally');
  assert.ok(narrow.reachedLaterColumns, 'horizontal scrolling reaches later spec columns');
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto(`${ORIGIN}/tracker`, { waitUntil: 'networkidle' });
  await wait(600);
  let trk = await page.evaluate(({ id, pid }) => ({
    specOnTracker: !!document.querySelector(`.ticket[data-ticket-id="${id}"]`),
    plainOnTracker: !!document.querySelector(`.ticket[data-ticket-id="${pid}"]`),
  }), { id: specId, pid: plain });
  assert.ok(!trk.specOnTracker, 'scratch spec is NOT on /tracker (excluded by exclude_kind=spec)');
  assert.ok(trk.plainOnTracker, 'plain task IS on /tracker');

  // ── 2. Column relabel: PATCH spec → in_progress → "Refining" ───────────────
  await patch(`/tickets/${encodeURIComponent(specId)}`, { state: 'in_progress', actor: 'smoke' });
  await page.goto(`${ORIGIN}/specs`, { waitUntil: 'networkidle' });
  await wait(600);
  let relabel = await page.evaluate((id) => ({
    inRefining: !!document.querySelector(`.kanban-col[data-col="in_progress"] .ticket[data-ticket-id="${id}"]`),
    header: document.querySelector('.kanban-col[data-col="in_progress"] .kanban-col-title')?.textContent || '',
    stillDraft: !!document.querySelector(`.kanban-col[data-col="todo"] .ticket[data-ticket-id="${id}"]`),
  }), specId);
  assert.ok(relabel.inRefining, 'spec moved to the in_progress column');
  assert.match(relabel.header, /Refining/, `in_progress column labeled "Refining" (got "${relabel.header}")`);
  assert.ok(!relabel.stillDraft, 'spec no longer in the Draft column');

  // ── 3. Content search ─────────────────────────────────────────────────────
  await page.goto(`${ORIGIN}/specs`, { waitUntil: 'networkidle' });
  await wait(400);
  await page.fill('.tracker-search', TOKEN);
  await wait(750); // 250ms debounce + fetch + render
  let srch = await page.evaluate(() => ({
    hasList: !!document.querySelector('.specs-search-list'),
    rowCount: document.querySelectorAll('.spec-result-row').length,
    markText: document.querySelector('.spec-result-snippet mark')?.textContent || null,
    boardHidden: !document.querySelector('.tracker-kanban'),
  }));
  assert.ok(srch.hasList, 'search-mode flat list rendered (columns hidden)');
  assert.equal(srch.rowCount, 1, `exactly one search result (got ${srch.rowCount})`);
  assert.ok(srch.markText && srch.markText.includes(TOKEN), `<mark> wraps the token (got "${srch.markText}")`);
  assert.ok(srch.boardHidden, 'board columns hidden while search is active');

  // click the row → drawer opens on the spec
  await page.evaluate(() => document.querySelector('.spec-result-row').click());
  await wait(500);
  let drawerOpen = await page.evaluate(() => ({
    open: !!document.querySelector('.drawer-ticket'),
    id: document.querySelector('.drawer-ticket .td-id')?.textContent || '',
  }));
  assert.ok(drawerOpen.open, 'ticket drawer opened on row click');
  assert.equal(drawerOpen.id, specRes.display_id || specId, `drawer shows the spec (got ${drawerOpen.id})`);
  await page.evaluate(() => document.querySelector('.drawer-ticket .drawer-close')?.click());
  await wait(400);

  // clear the search → board restores
  await page.fill('.tracker-search', '');
  await wait(500);
  assert.ok(
    await page.evaluate(() => !!document.querySelector('.tracker-kanban') && !document.querySelector('.specs-search-list')),
    'clearing the search restores the board columns',
  );

  // gibberish → empty state
  await page.fill('.tracker-search', 'zzzz-no-such-spec-zzzz-0284');
  await wait(750);
  let empty = await page.evaluate(() => document.querySelector('.specs-search-empty')?.textContent || '');
  assert.match(empty, /No specs match/, `gibberish shows the empty state (got "${empty}")`);
  await page.fill('.tracker-search', '');
  await wait(400);

  // ── 4. Spec drawer Work-items panel ──────────────────────────────────────
  // Human-facing links use display ids (GOL-123), not only the canonical
  // storage id (TKT-0123). The standalone page must resolve either form so
  // its + Work item composer remains reachable from shared/spec links.
  await page.goto(`${ORIGIN}/tickets/${encodeURIComponent(specRes.display_id || specId)}`, { waitUntil: 'networkidle' });
  await wait(700);
  // Poll for the children to render (live from the store snapshot).
  let panel = null;
  for (let i = 0; i < 24; i++) {
    panel = await page.evaluate(({ ca, cb }) => ({
      hasPanel: !!document.querySelector('.td-children'),
      rowCount: document.querySelectorAll('.td-child-row').length,
      ids: Array.from(document.querySelectorAll('.td-child-row')).map((r) => r.querySelector('.td-child-id')?.textContent || ''),
      pills: Array.from(document.querySelectorAll('.td-child-row')).map((r) => !!r.querySelector('.pill')),
    }), { ca: childA, cb: childB });
    if (panel.rowCount === 2) break;
    await wait(200);
  }
  assert.ok(panel.hasPanel, 'spec drawer renders the Work items panel');
  assert.equal(panel.rowCount, 2, `Work items panel lists both children (got ${panel.rowCount})`);
  assert.deepEqual(panel.ids.sort(), [childADisplay, childBDisplay].sort(), `child ids match (got ${panel.ids.join(', ')})`);
  assert.ok(panel.pills.every(Boolean), 'each child row has a state pill');

  // + Work item → composer with Kind=task
  await page.evaluate(() => document.querySelector('.td-children-add')?.click());
  await wait(600);
  let composerKind = await page.evaluate(ctFieldSelectValue('Type'));
  assert.equal(composerKind, 'task', `+ Work item opens composer with Kind=task (got ${composerKind})`);
  await page.evaluate(() => document.querySelector('.drawer-compose .drawer-close')?.click());
  await wait(500);

  // click a child row → opens that ticket as an overlay drawer
  await page.goto(`${ORIGIN}/tickets/${encodeURIComponent(specRes.display_id || specId)}`, { waitUntil: 'networkidle' });
  await wait(600);
  await page.evaluate(() => document.querySelectorAll('.td-child-row')[0]?.click());
  await wait(600);
  let childDrawer = await page.evaluate(() => ({
    open: !!document.querySelector('.drawer-ticket'),
    id: document.querySelector('.drawer-ticket .td-id')?.textContent || '',
  }));
  assert.ok(childDrawer.open, 'clicking a child opens the child ticket drawer');
  assert.equal(childDrawer.id, childARes.display_id || childA, `child drawer shows child A (got ${childDrawer.id})`);

  // ── 5. + New spec → composer with Kind=spec ──────────────────────────────
  await page.goto(`${ORIGIN}/specs`, { waitUntil: 'networkidle' });
  await wait(400);
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('.specs-board .orch-btn.primary'))
      .find((b) => /New spec/.test(b.textContent));
    if (btn) btn.click();
  });
  await wait(600);
  let newSpecKind = await page.evaluate(ctFieldSelectValue('Type'));
  assert.equal(newSpecKind, 'spec', `+ New spec opens composer with Kind=spec (got ${newSpecKind})`);

  // ── 6. API contract ───────────────────────────────────────────────────────
  let searchApi = await get(`/tickets/search?project=${PROJECT}&kind=spec&q=${encodeURIComponent(TOKEN)}`);
  assert.ok(Array.isArray(searchApi) && searchApi.length === 1, `API search returns exactly 1 row (got ${Array.isArray(searchApi) ? searchApi.length : 'not array'})`);
  assert.equal(searchApi[0].id, specId, 'API search row is the scratch spec');
  assert.ok(searchApi[0].snippet && searchApi[0].snippet.length > 0, 'API search row has a snippet');
  assert.ok(searchApi[0].match_start >= 0 && searchApi[0].match_len > 0, 'API search row has body match offsets');

  let listApi = await get(`/tickets?project=${PROJECT}&excludeKind=spec`);
  assert.ok(Array.isArray(listApi), 'excludeKind list is an array');
  assert.ok(listApi.every((t) => t.kind !== 'spec'), 'no spec-kind rows in excludeKind=spec list');
  assert.ok(listApi.some((t) => t.id === plain), 'plain task present in excludeKind=spec list');
  assert.ok(!listApi.some((t) => t.id === specId), 'scratch spec absent from excludeKind=spec list');

  // ── 7. Zero pageerror ─────────────────────────────────────────────────────
  assert.equal(pageerrors.length, 0, `no pageerror events (got ${pageerrors.length}: ${pageerrors.join(' | ')})`);

  console.log(JSON.stringify({
    ok: true,
    specId,
    children: [childA, childB],
    plain,
    searchSnippetLen: searchApi[0].snippet.length,
    searchOffsets: { start: searchApi[0].match_start, len: searchApi[0].match_len },
  }, null, 2));
} finally {
  for (const id of created) {
    try { await patch(`/tickets/${encodeURIComponent(id)}`, { state: 'archived' }); } catch {}
  }
  await cleanup();
}
