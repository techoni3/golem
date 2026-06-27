// TdAnnotate — html-report-style annotation layer for tracker ticket bodies.
// Renders the ticket body as HTML and mounts a Google-Docs-style comment rail.

const TA_AUTHORS = {
  you:        { label: 'You',         color: '#f5a623' },
  claude_opus:{ label: 'Claude Opus', color: '#b394ff' },
  gemini35:   { label: 'Gemini 3.5',  color: '#5b8cff' },
  kimi_k27:   { label: 'Kimi K2.7',   color: '#ff6f9c' },
  minimax_m3: { label: 'MiniMax M3',  color: '#2dd4a7' },
};

const TA_TAGS = {
  confirmed: { label: 'Confirmed', icon: '✓', color: '#3ddc97' },
  partial:   { label: 'Partial',   icon: '◐', color: '#f5a623' },
  disputed:  { label: 'Disputed',  icon: '✗', color: '#fb6f92' },
  fix:       { label: 'Fix',       icon: '✎', color: '#43c6f0' },
  risk:      { label: 'Risk',      icon: '⚠', color: '#ff9e3d' },
  question:  { label: 'Question',  icon: '?', color: '#c08bff' },
  note:      { label: 'Note',      icon: '•', color: '#9aa4bb' },
};
const TA_TAG_ORDER = ['confirmed', 'partial', 'disputed', 'fix', 'risk', 'question', 'note'];

const CTX = 42;

function authorMeta(a) { return TA_AUTHORS[a] || { label: a, color: '#9aa4bb' }; }
function tagMeta(t) { return TA_TAGS[t] || TA_TAGS.note; }

function bodyHtml(text) {
  if (window.SubstrateFmt?.htmlBody) return window.SubstrateFmt.htmlBody(text);
  if (!text) return '';
  if (/^\s*<[a-zA-Z][^>]*>/.test(text)) return text;
  return text.split(/\n\n+/).map((p) => `<p>${p.trim().replace(/\n/g, '<br/>')}</p>`).join('');
}

function hexA(hex, a) {
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function uid() { return 'a' + Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36); }
function nowISO() { return new Date().toISOString(); }
function shortTime(iso) { try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } }

function applyAuthorVars(node, author) {
  const c = authorMeta(author).color;
  node.style.setProperty('--_ac', c);
  node.style.setProperty('--_ac-soft', hexA(c, 0.12));
  node.style.setProperty('--_ac-mid', hexA(c, 0.28));
  node.style.setProperty('--_ac-bd', hexA(c, 0.5));
}

// ---- text index + anchoring ---------------------------------------------
function textNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
      const p = n.parentNode;
      if (!p) return NodeFilter.FILTER_REJECT;
      const tag = p.nodeName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
      if (p.closest && p.closest('#anno-rail,#anno-pill,#anno-fab')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  let pos = 0, n;
  while ((n = walker.nextNode())) {
    const len = n.nodeValue.length;
    nodes.push({ node: n, start: pos, end: pos + len });
    pos += len;
  }
  return { nodes, text: nodes.map((x) => x.node.nodeValue).join('') };
}
function rangeFromOffsets(idx, start, end) {
  const r = document.createRange(); let placedStart = false;
  for (const seg of idx.nodes) {
    if (!placedStart && start >= seg.start && start <= seg.end) { r.setStart(seg.node, start - seg.start); placedStart = true; }
    if (end >= seg.start && end <= seg.end) { r.setEnd(seg.node, end - seg.start); break; }
  }
  return placedStart ? r : null;
}
function offsetsFromRange(idx, range) {
  let start = -1, end = -1;
  for (const seg of idx.nodes) {
    if (seg.node === range.startContainer) start = seg.start + range.startOffset;
    if (seg.node === range.endContainer) end = seg.start + range.endOffset;
  }
  if (start < 0 || end < 0 || end <= start) return null;
  return { start, end };
}
function commonPrefix(a, b) { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; }
function commonSuffix(a, b) { let i = 0; while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++; return i; }
function locate(text, ann) {
  const { quote, prefix, suffix } = ann;
  if (!quote) return null;
  const pre = prefix || '', suf = suffix || '';
  const sig = pre + quote + suf;
  let i = text.indexOf(sig);
  if (i >= 0) return { start: i + pre.length, end: i + pre.length + quote.length };
  const hits = []; let from = 0, k;
  while ((k = text.indexOf(quote, from)) >= 0) { hits.push(k); from = k + 1; if (hits.length > 200) break; }
  if (!hits.length) return null;
  if (hits.length === 1) return { start: hits[0], end: hits[0] + quote.length };
  let best = hits[0], bestScore = -1;
  for (const h of hits) {
    const hpre = text.slice(Math.max(0, h - pre.length), h);
    const hsuf = text.slice(h + quote.length, h + quote.length + suf.length);
    const score = commonSuffix(hpre, pre) + commonPrefix(hsuf, suf);
    if (score > bestScore) { bestScore = score; best = h; }
  }
  return { start: best, end: best + quote.length };
}
function wrapOffsets(root, start, end, ann) {
  const idx = textNodes(root);
  const targets = [];
  for (const seg of idx.nodes) {
    if (seg.end <= start || seg.start >= end) continue;
    targets.push({ node: seg.node, ls: Math.max(0, start - seg.start), le: Math.min(seg.node.nodeValue.length, end - seg.start) });
  }
  const tm = tagMeta(ann.tag);
  for (let t = targets.length - 1; t >= 0; t--) {
    let node = targets[t].node;
    const { ls, le } = targets[t];
    if (le < node.nodeValue.length) node.splitText(le);
    if (ls > 0) node = node.splitText(ls);
    const mk = document.createElement('mark');
    mk.className = 'anno';
    mk.dataset.id = ann.id;
    mk.dataset.author = ann.author;
    mk.dataset.tag = ann.tag || 'note';
    mk.title = `${tm.label} · ${authorMeta(ann.author).label}`;
    if (ann.status === 'resolved') mk.classList.add('resolved');
    applyAuthorVars(mk, ann.author);
    if (t === targets.length - 1) {
      mk.classList.add('anno-tail');
      mk.style.setProperty('--_tic', '"' + tm.icon + '"');
      mk.style.setProperty('--_tcol', tm.color);
    }
    node.parentNode.insertBefore(mk, node);
    mk.appendChild(node);
  }
  return targets.length > 0;
}
function clearMarks(root, id) {
  root.querySelectorAll(`mark.anno[data-id="${id}"]`).forEach((mk) => {
    const parent = mk.parentNode;
    while (mk.firstChild) parent.insertBefore(mk.firstChild, mk);
    parent.removeChild(mk);
    parent.normalize();
  });
}
function nearestSection(range) {
  let node = range.commonAncestorContainer;
  if (node.nodeType === 3) node = node.parentNode;
  const sec = node.closest ? node.closest('section[id], section') : null;
  if (sec) {
    const h = sec.querySelector('h1,h2,h3');
    return { id: sec.id || '', title: h ? h.textContent.trim().slice(0, 80) : '' };
  }
  return { id: '', title: '' };
}

// ---- React component ----------------------------------------------------
function TdAnnotate({ html, comments, currentAuthor = 'you', onCreate, onUpdate, onReply }) {
  const rootRef = React.useRef(null);
  const railRef = React.useRef(null);
  const [annotations, setAnnotations] = React.useState(comments || []);
  const [activeId, setActiveId] = React.useState(null);
  const [showResolved, setShowResolved] = React.useState(true);
  const [railOpen, setRailOpen] = React.useState(false);
  const [saveState, setSaveState] = React.useState('');
  const [pendingComposer, setPendingComposer] = React.useState(null);
  const pendingRangeRef = React.useRef(null);

  React.useEffect(() => { setAnnotations(comments || []); }, [comments]);

  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.querySelectorAll('mark.anno').forEach((m) => { const p = m.parentNode; while (m.firstChild) p.insertBefore(m.firstChild, m); p.removeChild(m); });
    root.normalize();
    const idx0 = textNodes(root);
    for (const ann of annotations) {
      if (ann.status === 'deleted') continue;
      const loc = locate(idx0.text, ann);
      ann._orphan = !loc;
      if (loc) wrapOffsets(root, loc.start, loc.end, ann);
    }
  }, [annotations, html]);

  const docOrder = React.useCallback(() => {
    const root = rootRef.current;
    const order = new Map(); let i = 0;
    if (root) root.querySelectorAll('mark.anno').forEach((m) => { if (!order.has(m.dataset.id)) order.set(m.dataset.id, i++); });
    return (annotations || []).filter((a) => a.status !== 'deleted').slice().sort((a, b) => (order.has(a.id) ? order.get(a.id) : 1e9) - (order.has(b.id) ? order.get(b.id) : 1e9));
  }, [annotations]);

  const flashSaved = React.useCallback(() => {
    setSaveState('saving');
    setTimeout(() => setSaveState('saved'), 200);
    setTimeout(() => setSaveState((s) => (s === 'saved' ? '' : s)), 1600);
  }, []);

  const createComment = React.useCallback((input) => {
    const ann = { id: uid(), ...input, status: input.status || 'open', replies: input.replies || [], created_at: nowISO(), updated_at: nowISO() };
    setAnnotations((prev) => [ann, ...prev]);
    flashSaved();
    if (onCreate) onCreate(ann);
    return ann;
  }, [onCreate, flashSaved]);

  const updateComment = React.useCallback((id, patch) => {
    setAnnotations((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch, updated_at: nowISO() } : a)));
    flashSaved();
    if (onUpdate) onUpdate(id, patch);
  }, [onUpdate, flashSaved]);

  const addReply = React.useCallback((parentId, text, author) => {
    const reply = { author, text, ts: nowISO() };
    setAnnotations((prev) => prev.map((a) => a.id === parentId ? { ...a, replies: [...(a.replies || []), reply], updated_at: nowISO() } : a));
    flashSaved();
    if (onReply) onReply(parentId, reply);
  }, [onReply, flashSaved]);

  const deleteComment = React.useCallback((id) => {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
    flashSaved();
    if (onUpdate) onUpdate(id, { status: 'deleted' });
  }, [onUpdate, flashSaved]);

  const focusAnnotation = React.useCallback((id, fromMark) => {
    setActiveId(id);
    setRailOpen(true);
    const root = rootRef.current;
    if (root) root.querySelectorAll('mark.anno').forEach((m) => m.classList.toggle('is-active', m.dataset.id === id));
    setTimeout(() => {
      const card = railRef.current?.querySelector(`.anno-card[data-id="${id}"]`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      if (!fromMark) {
        const mk = root?.querySelector(`mark.anno[data-id="${id}"]`);
        if (mk) mk.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 50);
  }, []);

  const startNewComment = React.useCallback(() => {
    const range = pendingRangeRef.current;
    if (!range) return;
    const root = rootRef.current;
    const idx = textNodes(root);
    const offs = offsetsFromRange(idx, range);
    const pill = document.getElementById('anno-pill');
    if (pill) pill.style.display = 'none';
    window.getSelection().removeAllRanges();
    if (!offs) return;
    const quote = idx.text.slice(offs.start, offs.end);
    const prefix = idx.text.slice(Math.max(0, offs.start - CTX), offs.start);
    const suffix = idx.text.slice(offs.end, offs.end + CTX);
    const section = nearestSection(range);
    setRailOpen(true);
    setPendingComposer({ quote, prefix, suffix, section });
  }, []);

  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    function onSelect() {
      const sel = window.getSelection();
      const pill = document.getElementById('anno-pill');
      const wrap = root;
      if (!pill) return;
      if (!sel || sel.isCollapsed || !sel.rangeCount) { pill.style.display = 'none'; return; }
      const range = sel.getRangeAt(0);
      if (range.collapsed || !range.toString().trim()) { pill.style.display = 'none'; return; }
      if (!wrap.contains(range.commonAncestorContainer)) { pill.style.display = 'none'; return; }
      pendingRangeRef.current = range.cloneRange();
      // TKT-0108: the pill is portaled to the drawer root with `position:
      // fixed`. Express coords in viewport space (`getBoundingClientRect()`
      // returns viewport-relative), and keep the pill clamped inside the
      // drawer's content area so it doesn't escape the right edge when the
      // rail is open. The previous math was wrap-relative and broke once the
      // pill moved out of the scrolling wrap.
      const rangeRect = range.getBoundingClientRect();
      const drawerEl = document.querySelector('.drawer-ticket');
      const drawerRect = drawerEl ? drawerEl.getBoundingClientRect() : wrap.getBoundingClientRect();
      const pillWidth = pill.offsetWidth || 90;
      let desiredX = rangeRect.left + rangeRect.width / 2;
      let desiredY = rangeRect.top;
      const minX = drawerRect.left + pillWidth / 2 + 4;
      const maxX = drawerRect.right - pillWidth / 2 - 4;
      const x = Math.max(minX, Math.min(maxX, desiredX));
      pill.style.left = `${x}px`;
      pill.style.top = `${desiredY}px`;
      pill.style.display = 'flex';
    }

    function onKey(e) {
      const t = e.target;
      const typing = t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable;
      if (e.key === 'Escape') {
        document.getElementById('anno-rail')?.classList.remove('open');
        const pill = document.getElementById('anno-pill'); if (pill) pill.style.display = 'none';
        return;
      }
      if (!typing && (e.key === 'c' || e.key === 'C')) {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.rangeCount) {
          const range = sel.getRangeAt(0);
          if (root.contains(range.commonAncestorContainer) && range.toString().trim()) {
            e.preventDefault();
            pendingRangeRef.current = range.cloneRange();
            startNewComment();
          }
        }
      }
    }

    document.addEventListener('mouseup', onSelect);
    // TKT-0108: instead of hiding the pill on scroll, re-run the positioning
    // math against the still-cached pendingRangeRef. The pill is portaled to
    // the drawer and positioned with `position: fixed`, so its coordinates
    // need to track the selection's new viewport position when the body
    // scrolls underneath.
    document.addEventListener('scroll', () => {
      const p = document.getElementById('anno-pill');
      const r = pendingRangeRef.current;
      if (!p || p.style.display !== 'flex' || !r) return;
      const rangeRect = r.getBoundingClientRect();
      const drawerEl = document.querySelector('.drawer-ticket');
      const drawerRect = drawerEl ? drawerEl.getBoundingClientRect() : null;
      if (!drawerRect) return;
      const pillWidth = p.offsetWidth || 90;
      let desiredX = rangeRect.left + rangeRect.width / 2;
      const minX = drawerRect.left + pillWidth / 2 + 4;
      const maxX = drawerRect.right - pillWidth / 2 - 4;
      p.style.left = `${Math.max(minX, Math.min(maxX, desiredX))}px`;
      p.style.top = `${rangeRect.top}px`;
    }, { passive: true });
    document.addEventListener('mousedown', (e) => { const p = document.getElementById('anno-pill'); if (p && p.style.display === 'flex' && !p.contains(e.target)) p.style.display = 'none'; });
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mouseup', onSelect);
      document.removeEventListener('keydown', onKey);
    };
  }, [startNewComment]);

  const openCount = annotations.filter((a) => a.status === 'open').length;
  const resolvedCount = annotations.filter((a) => a.status === 'resolved').length;
  const visible = docOrder().filter((a) => showResolved || a.status !== 'resolved');
  const [plainComposer, setPlainComposer] = React.useState(false);

  // TKT-0108: hoist rail + FAB out of the scrollable body via a portal to the
  // drawer root. Otherwise both scroll with the body, which the user
  // complained about ("comments drawer and FAB are not sticky"). The pill
  // also tracks text-selection, so it goes through the same portal — its
  // positioning math is rewritten below to use viewport coordinates and
  // `position: fixed` (the previous math was wrap-relative and broke on
  // body scroll; the existing code only hid the pill on scroll as a
  // workaround).
  const drawerHost = typeof document !== 'undefined'
    ? document.querySelector('.drawer-ticket')
    : null;
  const railAndFab = drawerHost ? ReactDOM.createPortal(
    <>
      <div id="anno-pill" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); startNewComment(); }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        Comment
      </div>

      <div id="anno-rail" ref={railRef} className={railOpen ? 'open' : ''}>
        <div className="rail-head">
          <div>
            <div className="t">Comments</div>
            <div className="meta">{openCount} open · {resolvedCount} resolved</div>
          </div>
          <div className="rail-tools">
            <button className="rail-btn" onClick={() => { setRailOpen(true); setPlainComposer(true); }}>+ New</button>
            <button className={`rail-btn ${showResolved ? 'on' : ''}`} onClick={() => setShowResolved((v) => !v)}>
              {showResolved ? 'Hide resolved' : 'Show resolved'}
            </button>
            <button className="rail-btn" onClick={() => setRailOpen(false)}>Close</button>
          </div>
        </div>
        <div id="anno-list">
          {plainComposer && (
            <AnnoComposer
              currentAuthor={currentAuthor}
              onSend={(text, author, tag) => { createComment({ author, body: text, tag }); setPlainComposer(false); }}
              onCancel={() => setPlainComposer(false)}
            />
          )}
          {pendingComposer && (
            <AnnoComposer
              quote={pendingComposer.quote}
              currentAuthor={currentAuthor}
              onSend={(text, author, tag) => {
                createComment({
                  author, body: text,
                  quote: pendingComposer.quote,
                  prefix: pendingComposer.prefix,
                  suffix: pendingComposer.suffix,
                  section: pendingComposer.section.title,
                  section_id: pendingComposer.section.id,
                  tag,
                });
                setPendingComposer(null);
              }}
              onCancel={() => setPendingComposer(null)}
            />
          )}
          {visible.length === 0 ? (
            <div className="empty">No comments yet.<br/>Select any text, or click + New.</div>
          ) : visible.map((ann) => (
            <CommentCard
              key={ann.id}
              ann={ann}
              active={ann.id === activeId}
              currentAuthor={currentAuthor}
              onFocus={() => focusAnnotation(ann.id)}
              onResolve={() => updateComment(ann.id, { status: ann.status === 'resolved' ? 'open' : 'resolved' })}
              onDelete={() => deleteComment(ann.id)}
              onReply={(text, author) => addReply(ann.id, text, author)}
              onTagChange={(tag) => updateComment(ann.id, { tag })}
            />
          ))}
        </div>
      </div>

      <div id="anno-fab" onClick={() => setRailOpen((v) => !v)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <span className="n">{openCount}</span> <span className="lbl">{openCount === 1 ? 'comment' : 'comments'}</span>
      </div>

      <div id="anno-save" className={saveState ? `show ${saveState}` : ''}>
        {saveState === 'saving' ? 'saving…' : saveState === 'saved' ? 'saved ✓' : saveState === 'err' ? 'save failed' : ''}
      </div>
    </>,
    drawerHost,
  ) : null;

  return (
    <div className={`td-annotate-wrap ${railOpen ? 'rail-open' : ''}`}>
      <div ref={rootRef} className="td-html-body" dangerouslySetInnerHTML={{ __html: html || '' }}/>
      {railAndFab}
    </div>
  );
}

function CommentCard({ ann, active, currentAuthor, onFocus, onResolve, onDelete, onReply, onTagChange }) {
  const [replying, setReplying] = React.useState(false);
  const [showTagPicker, setShowTagPicker] = React.useState(false);
  const c = authorMeta(ann.author);
  const tm = tagMeta(ann.tag);

  return (
    <div
      className={`anno-card ${active ? 'is-active' : ''} ${ann.status === 'resolved' ? 'resolved' : ''} ${ann._orphan ? 'orphan' : ''}`}
      data-id={ann.id}
      style={{ '--_ac': c.color, '--_ac-soft': hexA(c.color, 0.1), '--_ac-bd': hexA(c.color, 0.5) }}
      onClick={onFocus}
    >
      <div className="ch">
        <span className="anno-tag clickable" onClick={(e) => { e.stopPropagation(); setShowTagPicker((v) => !v); }} style={{ '--_tc': tm.color, '--_tc-soft': hexA(tm.color, 0.14), '--_tc-bd': hexA(tm.color, 0.5) }}>
          <span className="ti">{tm.icon}</span>{tm.label}
        </span>
        <span className="anno-chip" style={{ '--_ac': c.color, '--_ac-soft': hexA(c.color, 0.1), '--_ac-bd': hexA(c.color, 0.5) }}>{esc(c.label)}</span>
        <span className="when">{shortTime(ann.created_at)}</span>
      </div>
      {showTagPicker && <TagChipRow inline current={ann.tag} onPick={(tag) => { onTagChange(tag); setShowTagPicker(false); }}/>}
      {ann.quote && <div className="quote">{esc(ann.quote)}</div>}
      <div className="body" dangerouslySetInnerHTML={{ __html: bodyHtml(ann.body) }}/>
      {(ann.replies || []).map((rep, i) => (
        <div className="reply" key={i}>
          <div className="ch">
            <span className="anno-chip" style={{ '--_ac': authorMeta(rep.author).color, '--_ac-soft': hexA(authorMeta(rep.author).color, 0.1), '--_ac-bd': hexA(authorMeta(rep.author).color, 0.5) }}>{esc(authorMeta(rep.author).label)}</span>
            <span className="when">{shortTime(rep.ts)}</span>
          </div>
          <div className="body" dangerouslySetInnerHTML={{ __html: bodyHtml(rep.text) }}/>
        </div>
      ))}
      {replying && <AnnoComposer hideTag currentAuthor={currentAuthor} onSend={(text, author) => { onReply(text, author); setReplying(false); }} onCancel={() => setReplying(false)}/>}
      <div className="acts">
        <button onClick={(e) => { e.stopPropagation(); setReplying(true); }}>Reply</button>
        <button onClick={(e) => { e.stopPropagation(); onResolve(); }}>{ann.status === 'resolved' ? 'Reopen' : 'Resolve'}</button>
        <button className="danger" onClick={(e) => { e.stopPropagation(); onDelete(); }}>Delete</button>
      </div>
    </div>
  );
}

function TagChipRow({ inline, current, onPick }) {
  const [sel, setSel] = React.useState(current || 'note');
  return (
    <div className={`anno-tagrow ${inline ? 'inline' : ''}`}>
      {TA_TAG_ORDER.map((t) => {
        const m = tagMeta(t);
        return (
          <button
            key={t}
            className={`anno-tagchip ${sel === t ? 'on' : ''}`}
            style={{ '--_tc': m.color, '--_tc-soft': hexA(m.color, 0.14), '--_tc-bd': hexA(m.color, 0.5) }}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setSel(t); if (onPick) onPick(t); }}
          >
            <span className="ti">{m.icon}</span>{m.label}
          </button>
        );
      })}
    </div>
  );
}

function AnnoComposer({ quote, hideTag, currentAuthor, onSend, onCancel }) {
  const [text, setText] = React.useState('');
  const [author, setAuthor] = React.useState(currentAuthor);
  const [tag, setTag] = React.useState('note');
  const taRef = React.useRef(null);
  React.useEffect(() => { taRef.current?.focus(); }, []);

  const fire = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t, author, tag);
  };

  return (
    <div className="anno-composer">
      {quote && <div className="quote">{esc(quote)}</div>}
      <textarea ref={taRef} value={text} onChange={(e) => setText(e.target.value)} placeholder="Comment…"
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); fire(); } else if (e.key === 'Escape') { e.preventDefault(); onCancel && onCancel(); } }}/>
      <div className="row">
        {!hideTag && <TagChipRow current={tag} onPick={setTag}/>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
          <select value={author} onChange={(e) => setAuthor(e.target.value)}>
            {Object.entries(TA_AUTHORS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <button className="cancel" onClick={onCancel}>esc</button>
          <button className="send" onClick={fire} disabled={!text.trim()}>Comment</button>
        </div>
      </div>
      <div className="hint">Enter to send · Shift+Enter newline · Esc cancel</div>
    </div>
  );
}

window.TdAnnotate = TdAnnotate;
