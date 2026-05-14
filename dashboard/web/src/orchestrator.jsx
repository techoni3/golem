// Orchestrator rail — persistent top-of-page strip showing every live CEO
// session as a chip. Each chip is clickable → opens the CeoChatDrawer for
// that session.
//
// v3: this rail is no longer single-CEO. The v3 registry surface
// (`orchestrator.sessions[]`) drives a row of session chips. Below the chips
// the rail still shows the headline journey memo + the aggregate gate count.
//
// Single-CEO case: the chip strip collapses to one row; clicking opens the
// drawer for that session and behaviour is identical to v2.
// Zero-CEO case:   the rail shows a "boot a CEO" hint; chat drawer disabled.
// Multi-CEO case:  each chip routes briefs / halts / gates to its session.

const { useCallback } = React;

function openCeoDrawer(sessionId) {
  window.dispatchEvent(new CustomEvent('open-ceo-drawer', { detail: { sessionId: sessionId ?? null } }));
}

function OrchestratorRail() {
  useStore();
  const orch = window.Store.getOrchestrator();
  const sessions = window.Store.getSessions();
  const memo = orch?.headlineMemo;
  const counts = orch?.gateCounts ?? { awaiting: 0, total: 0 };

  const onMemoClick = useCallback(() => {
    // No specific session → drawer falls back to the first available one.
    openCeoDrawer(sessions[0]?.session_id ?? null);
  }, [sessions]);

  return (
    <div className="orch-rail orch-rail-v3">
      <div className="orch-sessions">
        {sessions.length === 0 && (
          <div className="orch-session-empty">
            <span className="orch-dot offline"/>
            <span className="orch-status-label">No CEO live</span>
            <span className="orch-session-hint">
              boot with <span className="mono">golem session start --project &lt;id&gt;</span>
            </span>
          </div>
        )}
        {sessions.map((s) => <SessionChip key={s.session_id} session={s}/>)}
      </div>

      <div className="orch-meta-row" onClick={onMemoClick} title={memo ? 'Open CEO chat' : 'Open CEO chat'}>
        <div className="orch-memo">
          {memo ? (
            <>
              <div className="orch-memo-title" title={memo.path}>
                <span className="orch-memo-workspace">{memo.workspace_name}</span>
                <span className="sep">·</span>
                <span className="mono">{memo.name}</span>
              </div>
              <div className="orch-memo-summary" title={memo.summary}>
                {memo.summary || <span style={{ color: 'var(--text-4)' }}>(memo body empty)</span>}
              </div>
            </>
          ) : (
            <div className="orch-memo-empty">
              {sessions.length > 0 ? 'no journey memo yet — click a CEO chip to push a brief' : 'no CEO session live'}
            </div>
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
      </div>
    </div>
  );
}

function SessionChip({ session }) {
  const onClick = useCallback((e) => {
    e.stopPropagation();
    openCeoDrawer(session.session_id);
  }, [session.session_id]);

  const claim = session.claimed_project;
  const channel = session.channel_port;
  const statusClass = channel ? 'live' : 'idle';
  const statusLabel = channel ? 'Live' : 'No channel';

  return (
    <button
      className={`orch-session-chip ${claim ? 'claimed' : 'unbound'}`}
      onClick={onClick}
      title={
        `session ${session.session_id}\n` +
        `pid ${session.pid}\n` +
        (claim ? `claim ${claim}` : 'unbound — no project claimed') +
        (channel ? `\nchannel http://${session.channel_host}:${channel}` : '\nno channel registered (briefs cannot be delivered)')
      }
    >
      <span className={`orch-dot ${statusClass}`}/>
      <span className="orch-session-claim">
        {claim ? <span className="mono">{claim}</span> : <span className="orch-session-unbound">&lt;unbound&gt;</span>}
      </span>
      <span className="orch-session-id mono">{session.session_id.slice(0, 8)}</span>
      <span className="orch-session-status">{statusLabel}</span>
    </button>
  );
}

window.OrchestratorRail = OrchestratorRail;
window.openCeoDrawer = openCeoDrawer;
