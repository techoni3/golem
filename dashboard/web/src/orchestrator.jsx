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

// Memos older than this are no longer surfaced in the rail — a stale handoff
// from a past journey shouldn't masquerade as the current headline.
const MEMO_FRESH_MS = 7 * 24 * 60 * 60 * 1000;

function OrchestratorRail() {
  useStore();
  const orch = window.Store.getOrchestrator();
  // v4: control flows over per-session channels (channels.json), not the v3
  // sessions.json registry. The channel count is the real "is anything live?".
  const channels = window.Store.getChannels();
  const sessions = window.Store.getSessions(); // v3 CEO chips (usually empty in v4)
  const counts = orch?.gateCounts ?? { awaiting: 0, total: 0 };

  // Demote the journey memo: only surface it while it's fresh (<7d). A months-
  // old handoff memo is history, not the current headline.
  const rawMemo = orch?.headlineMemo;
  const memoFresh = rawMemo && rawMemo.mtime && (Date.now() - rawMemo.mtime) < MEMO_FRESH_MS;
  const memo = memoFresh ? rawMemo : null;

  const channelCount = channels.length;

  const onMemoClick = useCallback(() => {
    openCeoDrawer(channels[0]?.session_id ?? sessions[0]?.session_id ?? null);
  }, [channels, sessions]);

  return (
    <div className="orch-rail orch-rail-v3">
      <div className="orch-sessions">
        {channelCount > 0 ? (
          <div className="orch-session-empty">
            <span className="orch-dot live"/>
            <span className="orch-status-label">{channelCount} channel{channelCount === 1 ? '' : 's'} live</span>
            <span className="orch-session-hint">
              briefs &amp; gates deliver to {channelCount === 1 ? 'this session' : 'these sessions'} from the command center
            </span>
          </div>
        ) : (
          <div className="orch-session-empty">
            <span className="orch-dot offline"/>
            <span className="orch-status-label">No channels</span>
            <span className="orch-session-hint">
              sessions started before <span className="mono">v4.0.3</span> have no channel — new sessions register automatically
            </span>
          </div>
        )}
        {sessions.map((s) => <SessionChip key={s.session_id} session={s}/>)}
      </div>

      <div className="orch-meta-row" onClick={onMemoClick} title="Open CEO chat">
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
              {channelCount > 0
                ? 'no recent journey memo — send a brief from the command center to start one'
                : 'no recent journey memo'}
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

// v4: Native Claude Code sessions panel. Surfaces EVERY live `claude` session
// on the machine (not just golem/substrated ones), derived from
// `claude agents --json` + ~/.claude/sessions/*.json, pid-checked. Sessions in
// projects the dashboard doesn't know about get an "unregistered" badge.
function NativeSessions() {
  useStore();
  const sessions = window.Store.getNativeSessions();

  if (!sessions || sessions.length === 0) {
    return (
      <EmptyCard
        label="no native Claude Code sessions"
        hint={<>This lists every live <span className="mono">claude</span> session on the machine. None are running right now (or the <span className="mono">claude agents --json</span> CLI is unavailable).</>}
      />
    );
  }

  const statusClass = (s) => {
    if (!s.alive) return 'dead';
    if (s.status === 'busy') return 'busy';
    if (s.status === 'waiting') return 'waiting';
    return 'idle';
  };

  return (
    <div className="native-sessions">
      {sessions.map((s) => {
        // The server's `registered` flag is authoritative (matches cwd/root
        // against the registry). Fall back to a contract-id project lookup —
        // the dashboard `id` (registry id) ≠ the derived contract project_id,
        // so a plain id-set membership test would mis-flag registered sessions.
        const registered = s.registered || !!window.Store.getProjectByContractId(s.project_id);
        const cls = statusClass(s);
        return (
          <div key={s.session_id || s.pid} className={`native-session-card ${cls}`}>
            <div className="native-session-top">
              <span className={`orch-dot ${cls === 'dead' ? 'offline' : (cls === 'idle' ? 'idle' : 'live')}`}/>
              <span className="native-session-name">
                {s.name || <span className="mono">{(s.session_id || '').slice(0, 8) || `pid ${s.pid}`}</span>}
              </span>
              <span className={`native-session-status status-${cls}`}>
                {s.status || (s.alive ? 'alive' : 'dead')}
                {s.waiting_for ? ` · ${s.waiting_for}` : ''}
              </span>
              {!registered && (
                <span className="native-session-badge" title="this project is not registered with the dashboard">
                  unregistered
                </span>
              )}
            </div>
            <div className="native-session-cwd mono" title={s.cwd || ''}>
              {s.cwd || '—'}
            </div>
            <div className="native-session-meta">
              <span className="mono">pid {s.pid ?? '?'}</span>
              {s.session_id && <span className="mono" title={s.session_id}>{s.session_id.slice(0, 8)}</span>}
              {s.project_id && <span className="mono" title="derived project_id">{s.project_id}</span>}
              {s.updated_at && (
                <span title="last updated">
                  {window.SubstrateFmt?.fmtClock?.(s.updated_at) || ''}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

window.OrchestratorRail = OrchestratorRail;
window.openCeoDrawer = openCeoDrawer;
window.NativeSessions = NativeSessions;
