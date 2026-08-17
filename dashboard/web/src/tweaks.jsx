// Sidebar appearance control — theme + accent, persisted in localStorage.
// Nocturne & Inkstone is the default; an explicit 'dark' choice is honored.
// Existing golem.tweaks.accent hex values are kept as stable palette ids and
// translated to AA-safe variants at render time.

const THEME_KEY = 'golem.tweaks.theme';
const ACCENT_KEY = 'golem.tweaks.accent';

const THEME_OPTIONS = [
  { id: 'dark', name: 'Dark', note: 'Original command center' },
  { id: 'loam', name: 'Loam & Linen', note: 'Woven ivory and olive leaf' },
  { id: 'graphite', name: 'Graphite & Moss', note: 'Lifted charcoal and moss' },
  { id: 'nocturne', name: 'Nocturne & Inkstone', note: 'Blue-stone and pale sage' },
];

const ACCENT_OPTIONS = [
  { id: '#4ade80', name: 'Leaf', dark: '#4ade80', loam: '#596b3b', graphite: '#8faa72', nocturne: '#9baa91' },
  { id: '#60a5fa', name: 'River', dark: '#60a5fa', loam: '#3f6680', graphite: '#9cbcd0', nocturne: '#9dbbd0' },
  { id: '#f59e0b', name: 'Ochre', dark: '#f59e0b', loam: '#885a1e', graphite: '#dfb56d', nocturne: '#dfb16a' },
  { id: '#c084fc', name: 'Heather', dark: '#c084fc', loam: '#72517f', graphite: '#c2a5d5', nocturne: '#c2a5d9' },
  { id: '#f472b6', name: 'Berry', dark: '#f472b6', loam: '#884f65', graphite: '#e1a1b7', nocturne: '#e0a0b8' },
  { id: '#22d3ee', name: 'Juniper', dark: '#22d3ee', loam: '#3d6f6e', graphite: '#86b7b1', nocturne: '#8eb9b6' },
];

function savedTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return THEME_OPTIONS.some((option) => option.id === value) ? value : 'nocturne';
  }
  catch { return 'nocturne'; }
}

function savedAccent() {
  try {
    const value = localStorage.getItem(ACCENT_KEY);
    return ACCENT_OPTIONS.some((option) => option.id === value) ? value : ACCENT_OPTIONS[0].id;
  } catch {
    return ACCENT_OPTIONS[0].id;
  }
}

function accentFor(id, theme) {
  const option = ACCENT_OPTIONS.find((candidate) => candidate.id === id) || ACCENT_OPTIONS[0];
  return option[theme];
}

function applyAccent(id, theme) {
  const hex = accentFor(id, theme);
  document.documentElement.style.setProperty('--accent', hex);
  document.documentElement.style.setProperty('--accent-soft', hex + '1f');
  document.documentElement.style.setProperty('--accent-border', hex + '52');
  document.documentElement.style.setProperty('--status-active', hex);
}

function AppearanceIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3a9 9 0 1 0 0 18V3Z" fill="currentColor" opacity=".92"/>
      <path d="M12 3a9 9 0 0 1 0 18V3Z" fill="none" stroke="currentColor" strokeWidth="1.6"/>
      <circle cx="12" cy="12" r="8.8" fill="none" stroke="currentColor" strokeWidth="1.4"/>
    </svg>
  );
}

function TweaksButton() {
  const [open, setOpen] = React.useState(false);
  const [theme, setTheme] = React.useState(savedTheme);
  const [accent, setAccent] = React.useState(savedAccent);
  const triggerRef = React.useRef(null);
  const panelRef = React.useRef(null);
  const restoreFocusRef = React.useRef(false);

  const close = React.useCallback((restoreFocus = false) => {
    restoreFocusRef.current = restoreFocus;
    setOpen(false);
  }, []);

  React.useEffect(() => {
    if (open || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, [open]);

  React.useEffect(() => {
    if (theme === 'dark') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch {}
    applyAccent(accent, theme);
  }, [theme, accent]);

  React.useEffect(() => {
    try { localStorage.setItem(ACCENT_KEY, accent); } catch {}
  }, [accent]);

  React.useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => panelRef.current?.querySelector('[aria-pressed="true"]')?.focus());
  }, [open]);

  // ⌘/Ctrl+, toggles the panel; Escape closes and restores trigger focus.
  React.useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault();
        if (!open && document.querySelector('.drawer.open')) return;
        if (open) close(true);
        else setOpen(true);
      } else if (open && event.key === 'Escape') {
        event.preventDefault();
        close(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, open]);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event) => {
      if (panelRef.current?.contains(event.target) || triggerRef.current?.contains(event.target)) return;
      close(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [close, open]);

  const currentAccent = ACCENT_OPTIONS.find((option) => option.id === accent) || ACCENT_OPTIONS[0];
  const currentTheme = THEME_OPTIONS.find((option) => option.id === theme) || THEME_OPTIONS[0];

  return (
    <div className={`appearance-control ${open ? 'open' : ''}`}>
      <button
        ref={triggerRef}
        className="appearance-trigger"
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label="Appearance: theme and accent"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="appearance-panel"
        title="Appearance (⌘,)"
      >
        <AppearanceIcon/>
        <span className="appearance-accent-pip" style={{ background: accentFor(accent, theme) }}/>
      </button>

      {open && (
        <div
          ref={panelRef}
          id="appearance-panel"
          className="tweaks-pop"
          role="dialog"
          aria-modal="false"
          aria-labelledby="appearance-title"
        >
          <div className="appearance-panel-head">
            <div>
              <div className="appearance-kicker">Dashboard appearance</div>
              <div id="appearance-title" className="tweaks-pop-title">Set the atmosphere</div>
            </div>
            <button className="appearance-close" type="button" onClick={() => close(true)} aria-label="Close appearance controls">×</button>
          </div>

          <div className="tweaks-pop-label">Theme</div>
          <div className="theme-choices">
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`theme-choice theme-choice-${option.id} ${theme === option.id ? 'active' : ''}`}
                aria-pressed={theme === option.id}
                onClick={() => setTheme(option.id)}
              >
                <span className="theme-choice-preview" aria-hidden="true"><i/><i/><i/></span>
                <span><strong>{option.name}</strong><small>{option.note}</small></span>
              </button>
            ))}
          </div>

          <div className="tweaks-pop-label appearance-accent-label">Accent</div>
          <div className="color-swatches" role="group" aria-label="Accent color">
            {ACCENT_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`swatch ${option.id === accent ? 'active' : ''}`}
                style={{ background: option[theme] }}
                onClick={() => setAccent(option.id)}
                aria-label={option.name}
                aria-pressed={option.id === accent}
                title={`${option.name} accent`}
              />
            ))}
          </div>

          <div className="appearance-current" aria-live="polite">
            <span className="appearance-current-dot" style={{ background: currentAccent[theme] }}/>
            {currentTheme.name} · {currentAccent.name}
          </div>
          <div className="tweaks-pop-version">
            Toggle with <span className="kbd">⌘ ,</span> <span className="appearance-platform-note">Ctrl+, on Linux/Windows</span>
          </div>
        </div>
      )}
    </div>
  );
}

window.TweaksButton = TweaksButton;
window.TweaksFab = TweaksButton;
