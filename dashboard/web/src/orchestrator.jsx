// Orchestrator rail — persistent top-of-page ticker tape showing the CEO
// session state, the most-recent journey memo, and open gate counts. The
// rail itself is non-modal — click anywhere on it (or the "New brief" /
// gate action buttons) to open the CEO chat drawer on the right.
//
// All actual interaction (briefs, halts, gate verdicts, chat with the CEO)
// lives in CeoChatDrawer — see drawer-ceo.jsx.

const { useCallback } = React;

function openCeoDrawer() {
  window.dispatchEvent(new CustomEvent('open-ceo-drawer'));
}

function OrchestratorRail() {
  useStore();
  const orch = window.Store.getOrchestrator();
  const ceo = orch?.ceo;
  const memo = orch?.headlineMemo;
  const counts = orch?.gateCounts ?? { awaiting: 0, total: 0 };

  let statusLabel, statusClass;
  if (!ceo) { statusLabel = 'No session'; statusClass = 'offline'; }
  else if (ceo.live) { statusLabel = 'Live'; statusClass = 'live'; }
  else { statusLabel = `Idle · ${fmtAge(ceo.age_ms)}`; statusClass = 'idle'; }

  const onRailClick = useCallback(() => openCeoDrawer(), []);
  const stop = (e) => e.stopPropagation();

  return (
    <div
      className="orch-rail clickable"
      onClick={onRailClick}
      title="Open CEO chat"
    >
      <div className="orch-status">
        <span className={`orch-dot ${statusClass}`}/>
        <div className="orch-status-text">
          <div className="orch-status-label">CEO · {statusLabel}</div>
          <div className="orch-status-sub">
            {ceo
              ? <>session <span className="mono">{ceo.session_id.slice(0, 8)}</span></>
              : <span style={{ color: 'var(--text-4)' }}>boot with <span className="mono">golem session</span> to start one</span>}
          </div>
        </div>
      </div>

      <div className="orch-memo">
        {memo ? (
          <>
            <div className="orch-memo-title" title={memo.path}>
              <span className="orch-memo-workspace">{memo.workspace_name}</span>
              <span className="sep">·</span>
              <span className="mono">{memo.name}</span>
            </div>
            <div className="orch-memo-summary" title={memo.summary}>{memo.summary || <span style={{color:'var(--text-4)'}}>(memo body empty)</span>}</div>
          </>
        ) : (
          <div className="orch-memo-empty">no journey memo yet — click to push a brief</div>
        )}
      </div>

      <div className="orch-gates">
        <div className={`orch-gates-count ${counts.awaiting > 0 ? 'has-awaiting' : ''}`}>
          <span className="big">{counts.awaiting}</span>
          <span className="small">awaiting</span>
        </div>
        {counts.total > counts.awaiting && (
          <div className="orch-gates-secondary">{counts.total - counts.awaiting} closed</div>
        )}
      </div>

      <div className="orch-actions" onClick={stop}>
        <button className="orch-btn primary" onClick={openCeoDrawer} title="Open the CEO chat to send a brief">
          Open chat
        </button>
      </div>
    </div>
  );
}

function fmtAge(ms) {
  if (ms == null) return '?';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

window.OrchestratorRail = OrchestratorRail;
window.openCeoDrawer = openCeoDrawer;
