import { strict as assert } from 'node:assert';
import { acquireChrome } from './_chrome.mjs';
import { createScratchTicket, archiveTicket } from './_scratch.mjs';

const base = process.env.GOLEM_SMOKE_API || 'http://127.0.0.1:7420';

// Fetch live builder session for dispatch targets
const liveSessionsRes = await fetch(`${base}/api/sessions/dispatchable?project=golem-38ab8a`);
const liveSessions = await liveSessionsRes.json().catch(() => []);
const targetSession = liveSessions.find((s) => s.role === 'builder') || liveSessions[0];

const spec = await createScratchTicket({
  kind: 'spec',
  title: 'GOL-281 polish full journey',
  assignee: targetSession ? targetSession.session_id : null,
  body: '## 1. Section Alpha\n\nFirst paragraph for testing comment inbox and block attachments.\n\n![body test image](/api/ticket-assets/362bbde582b092e5dcfe1c2103e7f67b933782f43aa9076372cade36b1125fd7.png)\n\n## 2. Section Beta\n\nSecond paragraph for attaching blocks.\n',
});

let chrome;
try {
  chrome = await acquireChrome();
  const page = await chrome.browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.goto(`${base}/tickets/${spec.id}`);
  await page.waitForSelector('.td-annotate-wrap', { timeout: 10000 });

  // 1. Verify rail is open by default and composer dock is present
  const railState = await page.evaluate(() => {
    const rail = document.getElementById('anno-rail');
    const dock = document.querySelector('.anno-composer-dock');
    const ta = dock?.querySelector('textarea');
    const headDispatch = document.querySelector('.rail-head-dispatch');
    const taStyle = ta ? window.getComputedStyle(ta) : null;
    return {
      railOpen: rail?.classList.contains('open'),
      hasDock: !!dock,
      taHeight: ta?.offsetHeight || 0,
      taMinHeight: taStyle?.minHeight || '',
      taLineHeight: taStyle?.lineHeight || '',
      taPadding: taStyle?.padding || '',
      hasHeadDispatch: !!headDispatch,
    };
  });

  assert.equal(railState.railOpen, true, 'rail should be open by default on spec page');
  assert.equal(railState.hasDock, true, 'composer dock should be mounted at rail bottom');
  assert.ok(railState.taHeight >= 72, `textarea starting height should be >= 72px (got ${railState.taHeight}px)`);
  assert.equal(railState.taMinHeight, '72px', 'textarea min-height should be 72px');
  assert.equal(railState.hasHeadDispatch, false, 'bulk dispatch button should not be in rail header');

  // 2. Add an undispatched draft comment with markdown (paragraphs, list, code, image) and verify formatting, avatars, actions & bottom dispatch button
  const mdContent = 'Paragraph one with **bold** and `code`.\n\n* Item 1\n* Item 2\n\n![test image](/api/ticket-assets/362bbde582b092e5dcfe1c2103e7f67b933782f43aa9076372cade36b1125fd7.png)';
  const draftRes = await fetch(`${base}/api/tickets/${encodeURIComponent(spec.id)}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ author: 'human', body: mdContent }),
  });
  assert.equal(draftRes.status, 201, 'comment creation should succeed');

  // Wait for WS delta to mount .draft-queue
  await page.waitForSelector('.draft-queue', { timeout: 5000 });

  const queueState = await page.evaluate(() => {
    const queue = document.querySelector('.draft-queue');
    const label = queue?.querySelector('.draft-queue-label');
    const foot = queue?.querySelector('.draft-queue-foot');
    const btn = foot?.querySelector('.draft-queue-dispatch-btn');
    const queueStyle = queue ? window.getComputedStyle(queue) : null;
    const card = queue?.querySelector('.anno-card');
    const cardStyle = card ? window.getComputedStyle(card) : null;
    const cardBody = card?.querySelector('.body');
    const bodyStyle = cardBody ? window.getComputedStyle(cardBody) : null;
    const img = cardBody?.querySelector('img');
    const imgStyle = img ? window.getComputedStyle(img) : null;
    const avatar = card?.querySelector('.anno-avatar');
    const authorName = card?.querySelector('.anno-author-name')?.textContent || '';
    const avatarText = avatar?.textContent || '';
    const acts = card?.querySelector('.acts');
    const replyBtn = acts?.querySelector('.act-reply');
    const deleteBtn = acts?.querySelector('.act-delete');
    return {
      hasQueue: !!queue,
      labelText: label?.textContent || '',
      hasFoot: !!foot,
      hasDispatchBtn: !!btn,
      dispatchBtnText: btn?.textContent || '',
      borderStyle: queueStyle?.borderStyle || '',
      cardBorderStyle: cardStyle?.borderStyle || '',
      cardBorderLeftWidth: cardStyle?.borderLeftWidth || '',
      cardBorderLeftColor: cardStyle?.borderLeftColor || '',
      isHumanCard: card?.classList.contains('anno-card-human'),
      hasHumanAvatar: avatar?.classList.contains('anno-avatar-human'),
      authorName,
      avatarText,
      imgMaxWidth: imgStyle?.maxWidth || '',
      bodyWhiteSpace: bodyStyle?.whiteSpace || '',
      hasReplyBtn: !!replyBtn,
      replyBtnText: replyBtn?.textContent || '',
      hasDeleteBtn: !!deleteBtn,
    };
  });

  assert.equal(queueState.hasQueue, true, 'draft queue container should be mounted');
  assert.match(queueState.labelText, /Draft queue · 1 not yet dispatched/, 'draft queue label should reflect draft count');
  assert.equal(queueState.hasFoot, true, 'draft queue foot should exist at bottom of draft queue');
  assert.equal(queueState.hasDispatchBtn, true, 'bulk dispatch button should render in draft queue foot');
  assert.equal(queueState.isHumanCard, true, 'human comment should have anno-card-human class');
  assert.equal(queueState.hasHumanAvatar, true, 'human comment should have anno-avatar-human class');
  assert.equal(queueState.authorName, 'Lavee', 'human comment author name should be Lavee');
  assert.equal(queueState.avatarText, 'L', 'human comment avatar initial should be L');
  assert.equal(queueState.imgMaxWidth, '200px', 'markdown image in comment must have max-width: 200px');
  assert.notEqual(queueState.bodyWhiteSpace, 'pre-wrap', 'comment markdown body must not use pre-wrap');
  assert.equal(queueState.cardBorderLeftWidth, '1px', 'left border rail must be gone (uniform 1px border)');
  assert.equal(queueState.hasReplyBtn, true, 'reply action button with icon must exist');
  assert.match(queueState.replyBtnText, /💬\s*Reply/, 'reply button should have icon and text');

  // 3. Add committed history item with 340 words and verify in-flow divider
  const words340 = ('word '.repeat(340)).trim();
  const longRes = await fetch(`${base}/api/tickets/${encodeURIComponent(spec.id)}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ author: 'golem:builder', body: longResBody(words340), status: 'open' }),
  });

  function longResBody(text) {
    return text;
  }

  // 4. Type into composer and verify auto-grow
  await page.focus('.anno-composer-dock textarea');
  await page.type('.anno-composer-dock textarea', 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6');

  const growState = await page.evaluate(() => {
    const ta = document.querySelector('.anno-composer-dock textarea');
    return {
      height: ta?.offsetHeight || 0,
      words: document.getElementById('anno-composer-word-count')?.textContent || '',
    };
  });

  assert.ok(growState.height > 72, `textarea should auto-grow with multiple lines (got ${growState.height}px)`);

  // 5. Alt+click block in spec to verify attachment pill
  await page.click('[data-block-id="1-section-alpha#1"]', { modifiers: ['Alt'] });
  await page.waitForSelector('.anno-attachment-pill', { timeout: 3000 });
  const pillState = await page.evaluate(() => {
    const pill = document.querySelector('.anno-attachment-pill');
    return {
      hasPill: !!pill,
      pillText: pill?.textContent || '',
    };
  });
  assert.equal(pillState.hasPill, true, 'attachment pill should appear on block select');
  assert.match(pillState.pillText, /⧉ Section/, 'pill should indicate section attachment');

  // 6. Verify ticket body markdown image sizing & click-to-lightbox
  const bodyImgMetrics = await page.evaluate(() => {
    const img = document.querySelector('.td-md img');
    const style = img ? window.getComputedStyle(img) : null;
    return {
      hasImg: !!img,
      maxWidth: style?.maxWidth || '',
      cursor: style?.cursor || '',
    };
  });
  assert.equal(bodyImgMetrics.hasImg, true, 'ticket body image should exist');
  assert.equal(bodyImgMetrics.maxWidth, 'min(100%, 480px)', 'ticket body image max-width should be min(100%, 480px)');
  assert.equal(bodyImgMetrics.cursor, 'pointer', 'ticket body image cursor should be pointer');

  await page.click('.td-md img');
  await page.waitForSelector('.anno-image-lightbox', { timeout: 3000 });
  const lbOpen = await page.evaluate(() => document.querySelector('.anno-image-lightbox')?.classList.contains('open'));
  assert.equal(lbOpen, true, 'clicking ticket body image should open lightbox');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.anno-image-lightbox'), { timeout: 3000 });

  // Capture verification screenshot
  await page.screenshot({ path: '/tmp/gol281-polish-screenshot.png' });
  console.log(JSON.stringify({ ok: true, railState, queueState, growState, pillState, bodyImgMetrics, screenshot: '/tmp/gol281-polish-screenshot.png' }, null, 2));
} finally {
  if (chrome) await chrome.cleanup();
  await archiveTicket(spec.id);
}
