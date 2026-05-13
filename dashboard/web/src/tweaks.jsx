// Slim tweaks panel — accent color picker. Persists to localStorage.
//
// Rendered inline inside the sidebar footer (no longer a floating FAB) so it
// doesn't overlap the CEO drawer's send button or the dashboard content.
// Toggle with the inline gear icon or with ⌘,/Ctrl+,. Escape dismisses.

const ACCENT_OPTIONS = ['#4ade80', '#60a5fa', '#f59e0b', '#c084fc', '#f472b6', '#22d3ee'];

function applyAccent(hex) {
  document.documentElement.style.setProperty('--accent', hex);
  document.documentElement.style.setProperty('--accent-soft', hex + '1f');
  document.documentElement.style.setProperty('--accent-border', hex + '52');
  document.documentElement.style.setProperty('--status-active', hex);
}

function TweaksButton() {
  const [open, setOpen] = React.useState(false);
  const [accent, setAccent] = React.useState(() => {
    return localStorage.getItem('golem.tweaks.accent') || ACCENT_OPTIONS[0];
  });

  React.useEffect(() => {
    applyAccent(accent);
    localStorage.setItem('golem.tweaks.accent', accent);
  }, [accent]);

  // ⌘/Ctrl+, toggles; Escape closes.
  React.useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (open && e.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Click-outside dismiss.
  React.useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      const pop = document.querySelector('.tweaks-pop');
      const btn = document.querySelector('.tweaks-button-inline');
      if (pop && (pop.contains(e.target) || (btn && btn.contains(e.target)))) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <>
      <button
        className="tweaks-button-inline"
        onClick={() => setOpen((o) => !o)}
        title="Tweaks (⌘,)"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="8" cy="8" r="2"/>
          <path d="M8 1V3M8 13V15M1 8H3M13 8H15M3 3L4.5 4.5M11.5 11.5L13 13M3 13L4.5 11.5M11.5 4.5L13 3"/>
        </svg>
      </button>
      {open && (
        <div className="tweaks-pop" onMouseDown={(e) => e.stopPropagation()}>
          <div className="tweaks-pop-title">Tweaks</div>
          <div className="tweaks-pop-label">Accent</div>
          <div className="color-swatches">
            {ACCENT_OPTIONS.map((c) => (
              <button
                key={c}
                className={`swatch ${c === accent ? 'active' : ''}`}
                style={{ background: c }}
                onClick={() => setAccent(c)}
                title={c}
              />
            ))}
          </div>
          <div className="tweaks-pop-version">
            Golem Substrate Admin · v0.1.0<br/>
            Toggle with <span className="kbd">⌘ ,</span> (Ctrl+, on linux/win)
          </div>
        </div>
      )}
    </>
  );
}

window.TweaksButton = TweaksButton;
// Back-compat alias for any code still referencing the old name.
window.TweaksFab = TweaksButton;
