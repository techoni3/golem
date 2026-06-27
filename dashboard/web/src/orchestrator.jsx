// Orchestrator rail — persistent top-of-page strip showing live channel status
// and the most recent cross-project milestone.
//
// v3 CEO session registry + gate counts were removed in TKT-0009. This rail now
// only surfaces whether any golem channels are live and the latest milestone.

const { useCallback } = React;

function openCeoDrawer(sessionId) {
  window.dispatchEvent(new CustomEvent('open-ceo-drawer', { detail: { sessionId: sessionId ?? null } }));
}

function OrchestratorRail() {
  useStore();
  const channels = window.Store.getChannels();
  const channelCount = channels.length;

  const latestMilestone = window.Store.getRecentMilestones()[0] ?? null;
  const milestoneProject = latestMilestone
    ? window.Store.getProjectByContractId(latestMilestone.project)
    : null;

  const onMemoClick = useCallback(() => {
    openCeoDrawer(channels[0]?.session_id ?? null);
  }, [channels]);

  return (
    <div className="orch-rail orch-rail-v4">
      <div className="orch-sessions">
        {channelCount > 0 ? (
          <div className="orch-session-empty">
            <span className="orch-dot live"/>
            <span className="orch-status-label">{channelCount} channel{channelCount === 1 ? '' : 's'} live</span>
            <span className="orch-session-hint">
              briefs deliver to {channelCount === 1 ? 'this session' : 'these sessions'} from the command center
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
      </div>

      <div className="orch-meta-row" onClick={onMemoClick} title="Open session chat">
        <div className="orch-memo">
          {latestMilestone ? (
            <div className="orch-milestone-line">
              <span
                className="orch-milestone-chip"
                style={milestoneProject ? { '--chip-color': milestoneProject.color } : undefined}
                title={milestoneProject ? milestoneProject.name : (latestMilestone.project_name || latestMilestone.project || '')}
              >
                <span
                  className="orch-milestone-dot"
                  style={{ background: latestMilestone.project_color || milestoneProject?.color || 'var(--accent)' }}
                />
                <span className="orch-milestone-chip-text">
                  {milestoneProject?.name || latestMilestone.project_name || latestMilestone.project || '—'}
                </span>
              </span>
              <span className="orch-milestone-text" title={latestMilestone.text}>{latestMilestone.text}</span>
              <span className="orch-milestone-ts mono">· {window.SubstrateFmt.fmtTimeAgo(latestMilestone.t)}</span>
            </div>
          ) : (
            <div className="orch-memo-empty">
              no milestones yet — sessions append them as work lands
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

window.OrchestratorRail = OrchestratorRail;
