// Browser journey for the document table of contents. It exercises the
// standalone ticket page and the URL-driven ticket drawer using one scratch
// ticket, so no real board data is changed.

import assert from 'node:assert/strict';
import { acquireChrome } from './_chrome.mjs';
import { archiveTicket, createScratchTicket } from './_scratch.mjs';

const ORIGIN = process.env.GOLEM_SMOKE_ORIGIN || 'http://dashboard.golem.localhost:7420';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const body = [
  '# SMOKE-toc fixture',
  '',
  'The document contents are long enough to provide a real scroll journey.',
  '',
  '## First section',
  '',
  'First section context. This filler makes the document scrollable in the browser journey.',
  '',
  '### Nested first section',
  '',
  'Nested first section context. More document content follows so the active section can change.',
  '',
  'First section detail line one.',
  '',
  'First section detail line two.',
  '',
  'First section detail line three.',
  '',
  'First section detail line four.',
  '',
  'First section detail line five.',
  '',
  '## Second section',
  '',
  'Second section context. This is the destination for the first TOC navigation check.',
  '',
  '### Nested second section',
  '',
  'Nested second section context.',
  '',
  'Second section detail line one.',
  '',
  'Second section detail line two.',
  '',
  'Second section detail line three.',
  '',
  'Second section detail line four.',
  '',
  'Second section detail line five.',
  '',
  '## Third section',
  '',
  'Third section context.',
  '',
  '### Nested third section',
  '',
  'Nested third section context.',
  '',
  'Third section detail line one.',
  '',
  'Third section detail line two.',
  '',
  'Third section detail line three.',
  '',
  'Third section detail line four.',
  '',
  'Third section detail line five.',
  '',
  'Trailing document detail line one.',
  '',
  'Trailing document detail line two.',
  '',
  'Trailing document detail line three.',
  '',
  'Trailing document detail line four.',
  '',
  'Trailing document detail line five.',
  '',
  'Trailing document detail line six.',
  '',
  'Trailing document detail line seven.',
  '',
  'Trailing document detail line eight.',
].join('\n');

const ticket = await createScratchTicket({ title: 'toc fixture', body });
let chrome;

async function waitForToc(page) {
  await page.waitForSelector('.td-md');
  await page.waitForSelector('.td-toc-panel, .td-toc-handle');
  await wait(120);
}

async function tocState(page) {
  return page.evaluate(() => ({
    headings: [...document.querySelectorAll('.td-md h1,.td-md h2,.td-md h3')].map((heading) => ({
      id: heading.id,
      text: heading.textContent.trim(),
    })),
    links: [...document.querySelectorAll('.td-toc-link')].map((link) => ({
      href: link.getAttribute('href'),
      text: link.textContent.trim(),
      active: link.getAttribute('aria-current') === 'location',
    })),
    panel: document.querySelector('.td-toc-panel')?.className || '',
    handle: document.querySelector('.td-toc-handle')?.className || '',
    railOpen: !!document.querySelector('.td-main.td-toc-rail-open'),
    scrollTop: document.querySelector('.td-scroll')?.scrollTop || 0,
  }));
}

try {
  chrome = await acquireChrome();
  const page = chrome.browser.contexts()[0]?.pages()[0] ?? await chrome.browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.setViewportSize({ width: 2200, height: 1200 });
  await page.goto(`${ORIGIN}/tickets/${encodeURIComponent(ticket.id)}`, { waitUntil: 'networkidle' });
  await waitForToc(page);

  let state = await tocState(page);
  assert.equal(state.headings[0]?.text, 'SMOKE-toc fixture', 'document title heading remains in the document');
  assert.ok(state.headings.every((heading) => heading.id), 'all headings receive stable ids');
  assert.ok(state.links.length >= 6, 'TOC contains the rendered section headings');
  assert.ok(!state.links.some((link) => link.text === 'SMOKE-toc fixture'), 'document title heading is omitted from TOC');
  assert.ok(state.links.some((link) => link.text === 'Nested second section'), 'TOC preserves nested heading hierarchy');
  assert.match(state.panel, /td-toc-panel/, 'page opens the TOC rail by default');
  assert.match(state.panel, /is-rail/, 'TOC is a left rail, not a title overlay');
  assert.ok(state.railOpen, 'open TOC reserves the left rail');
  assert.ok(state.links.some((link) => link.active), 'TOC marks the initial active section');

  const second = page.locator('.td-toc-link').filter({ hasText: 'Second section' }).first();
  await second.click();
  await wait(450);
  state = await tocState(page);
  assert.ok(state.links.some((link) => link.active && /second section$/i.test(link.text)), 'clicking a TOC link updates the active section');
  assert.ok(state.scrollTop > 0, 'clicking a TOC link scrolls the document container');

  await page.locator('.td-toc-handle').click();
  await wait(100);
  state = await tocState(page);
  assert.equal(state.panel, '', 'collapsing the rail hides the panel');
  assert.match(state.handle, /is-collapsed/, 'collapsed rail leaves a chevron handle');
  assert.equal(state.railOpen, false, 'collapsed rail releases the reserved column');

  await page.reload({ waitUntil: 'networkidle' });
  await waitForToc(page);
  state = await tocState(page);
  assert.equal(state.panel, '', 'hidden preference survives a reload');
  await page.locator('.td-toc-handle').click();
  await wait(100);
  assert.match((await tocState(page)).panel, /is-rail/, 'chevron restores the left rail');

  await page.setViewportSize({ width: 720, height: 900 });
  await wait(250);
  state = await tocState(page);
  assert.match(state.panel, /is-rail/, 'narrow layout keeps the left TOC rail');
  await page.locator('.td-toc-panel .td-toc-link').filter({ hasText: 'Third section' }).first().click();
  await wait(100);
  state = await tocState(page);
  assert.match(state.panel, /is-rail/, 'navigating from the rail leaves the TOC open');

  await page.goto(`${ORIGIN}/?ticket=${encodeURIComponent(ticket.id)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.drawer-ticket .td-md');
  await page.waitForSelector('.drawer-ticket .td-toc-panel, .drawer-ticket .td-toc-handle');
  await wait(150);
  const drawerState = await page.evaluate(() => {
    const panel = document.querySelector('.drawer-ticket .td-toc-panel');
    const handle = document.querySelector('.drawer-ticket .td-toc-handle');
    const main = document.querySelector('.drawer-ticket .td-main');
    if (!panel || !main) {
      return {
        hasPanel: !!panel,
        hasHandle: !!handle,
        links: document.querySelectorAll('.drawer-ticket .td-toc-link').length,
      };
    }
    const panelRect = panel.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    return {
      hasPanel: true,
      hasHandle: !!handle,
      links: document.querySelectorAll('.drawer-ticket .td-toc-link').length,
      panelLeft: panelRect.left,
      mainLeft: mainRect.left,
      mainPaddingLeft: parseFloat(getComputedStyle(main).paddingLeft) || 0,
    };
  });
  assert.ok(drawerState.hasPanel, 'ticket drawer opens the TOC rail by default');
  assert.ok(drawerState.links >= 6, 'ticket drawer TOC has the same heading source');
  assert.ok(Math.abs(drawerState.panelLeft - drawerState.mainLeft) <= 2, 'drawer TOC sticks to the left of the document column');
  assert.ok(drawerState.mainPaddingLeft >= 200, 'open drawer TOC reserves its column width');

  const drawerBeforeScroll = await page.evaluate(() => {
    const drawer = document.querySelector('.drawer-ticket');
    const scroll = document.querySelector('.drawer-ticket .td-scroll');
    const toc = document.querySelector('.drawer-ticket .td-toc-panel');
    const main = document.querySelector('.drawer-ticket .td-main');
    const body = document.querySelector('.drawer-ticket .td-md');
    const drawerRect = drawer.getBoundingClientRect();
    const tocRect = toc.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    return {
      position: getComputedStyle(drawer).position,
      panelClass: toc.className,
      mainPaddingLeft: parseFloat(getComputedStyle(main).paddingLeft) || 0,
      viewport: { width: innerWidth, height: innerHeight },
      drawer: { left: drawerRect.left, top: drawerRect.top, right: drawerRect.right, bottom: drawerRect.bottom, width: drawerRect.width, height: drawerRect.height },
      main: { left: mainRect.left, width: mainRect.width },
      body: { left: bodyRect.left, width: bodyRect.width },
      toc: { top: tocRect.top, left: tocRect.left, right: tocRect.right },
      scroll: { top: scroll.scrollTop, height: scroll.clientHeight, fullHeight: scroll.scrollHeight },
      documentScrollTop: document.scrollingElement?.scrollTop || 0,
    };
  });
  assert.match(drawerBeforeScroll.panelClass, /is-rail/, 'drawer TOC stays a left rail');
  assert.ok(drawerBeforeScroll.mainPaddingLeft >= 200, 'open drawer TOC reserves its column width');
  assert.ok(drawerBeforeScroll.body.left >= drawerBeforeScroll.main.left + 200, 'ticket body moves beside the TOC rail');
  assert.equal(drawerBeforeScroll.position, 'fixed', 'ticket drawer keeps the shared fixed positioning');
  assert.ok(drawerBeforeScroll.drawer.left >= -1 && drawerBeforeScroll.drawer.right <= drawerBeforeScroll.viewport.width + 1, 'ticket drawer stays within the viewport width');
  assert.ok(drawerBeforeScroll.drawer.top >= -1 && drawerBeforeScroll.drawer.bottom <= drawerBeforeScroll.viewport.height + 1, 'ticket drawer stays within the viewport height');
  assert.ok(drawerBeforeScroll.scroll.fullHeight > drawerBeforeScroll.scroll.height, 'ticket body has its own scroll range');

  await page.locator('.drawer-ticket .td-scroll').evaluate((element) => { element.scrollTop = Math.min(320, element.scrollHeight); });
  await wait(100);
  const drawerAfterScroll = await page.evaluate(() => {
    const drawer = document.querySelector('.drawer-ticket');
    const scroll = document.querySelector('.drawer-ticket .td-scroll');
    const toc = document.querySelector('.drawer-ticket .td-toc-panel');
    const drawerRect = drawer.getBoundingClientRect();
    const tocRect = toc.getBoundingClientRect();
    return {
      drawer: { left: drawerRect.left, top: drawerRect.top, right: drawerRect.right, bottom: drawerRect.bottom, width: drawerRect.width, height: drawerRect.height },
      toc: { top: tocRect.top, left: tocRect.left, right: tocRect.right },
      scrollTop: scroll.scrollTop,
      documentScrollTop: document.scrollingElement?.scrollTop || 0,
    };
  });
  assert.ok(drawerAfterScroll.scrollTop > 0, 'scrolling the ticket body changes the body scroll position');
  assert.equal(drawerAfterScroll.documentScrollTop, 0, 'the document itself does not become the scroll surface');
  assert.deepEqual(drawerAfterScroll.drawer, drawerBeforeScroll.drawer, 'drawer geometry stays fixed while the body scrolls');
  assert.deepEqual(drawerAfterScroll.toc, drawerBeforeScroll.toc, 'TOC stays persistent while the body scrolls');

  assert.deepEqual(pageErrors, [], `no page errors (got ${pageErrors.join(' | ')})`);
  console.log(JSON.stringify({
    ok: true,
    ticket: ticket.id,
    page: { links: state.links.length, narrow: true },
    drawer: drawerState,
  }, null, 2));
} finally {
  try { await archiveTicket(ticket.id); } catch {}
  if (chrome) await chrome.cleanup();
}
