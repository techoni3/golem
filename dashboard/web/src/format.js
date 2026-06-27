// Formatting helpers ported from data.js, but free-standing (no mock data).

(function () {
  function fmtRuntime(seconds) {
    seconds = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
    if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
    return `${s}s`;
  }

  function fmtTimeAgo(t) {
    if (!t) return '';
    const d = (Date.now() - t) / 1000;
    if (d < 0) return 'now';
    if (d < 60) return `${Math.floor(d)}s ago`;
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    return `${Math.floor(d / 86400)}d ago`;
  }

  function fmtClock(t) {
    const d = new Date(t || Date.now());
    return d.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  // Project glyph fallback if the server didn't compute one.
  function glyphFor(name) {
    const letters = String(name || '').replace(/[^a-zA-Z0-9]/g, '');
    if (!letters) return '··';
    if (letters.length === 1) return letters[0].toUpperCase().repeat(2);
    return (letters[0] + letters[1]).toUpperCase();
  }

  /**
   * Render a ticket/comment body as HTML. If the text already starts with an
   * HTML tag, return it unchanged; otherwise wrap blank-line-separated blocks
   * in <p> tags and preserve single newlines as <br/>.
   */
  function htmlBody(text) {
    if (!text) return '';
    if (/^\s*<[a-zA-Z][^>]*>/.test(text)) return text;
    return text
      .split(/\n\n+/)
      .map((p) => `<p>${p.trim().replace(/\n/g, '<br/>')}</p>`)
      .join('');
  }

  window.SubstrateFmt = { fmtRuntime, fmtTimeAgo, fmtClock, glyphFor, htmlBody };
})();
