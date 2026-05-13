import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();

export const CONFIG = {
  port: parseInt(process.env.PORT ?? '4173', 10),
  host: process.env.HOST ?? '127.0.0.1',
  projectsRoot:
    process.env.GOLEM_PROJECTS_ROOT ??
    path.join(HOME, 'Documents/software/experiments/golem/golem-projects'),
  ideasRoot:
    process.env.GOLEM_IDEAS_ROOT ??
    path.join(HOME, 'Documents/software/experiments/golem/golem-ideas'),
  // Workspace root that the golem-ceo launcher cd's into. Used to locate the
  // CEO Claude Code session under ~/.claude/projects/<encoded>/*.jsonl.
  golemRoot:
    process.env.GOLEM_ROOT ??
    path.join(HOME, 'Documents/software/experiments'),
  // URL of the golem MCP channel server. Used by POST /api/brief to forward
  // intrusions into the live CEO session.
  channelUrl: process.env.GOLEM_CHANNEL_URL ?? 'http://127.0.0.1:7421',
  // How long since last activity before we consider an agent "done" with no explicit stop event.
  agentIdleTimeoutMs: parseInt(process.env.GOLEM_AGENT_IDLE_MS ?? `${15 * 60 * 1000}`, 10),
  // How fresh "active" status requires last activity to be.
  agentActiveWindowMs: parseInt(process.env.GOLEM_AGENT_ACTIVE_MS ?? `${60 * 1000}`, 10),
  // CEO session is considered "live" if its jsonl was modified within this window.
  ceoLiveWindowMs: parseInt(process.env.GOLEM_CEO_LIVE_MS ?? `${5 * 60 * 1000}`, 10),
  // Window in which we correlate a new session_id with a recent agent-spawn event.
  spawnCorrelationMs: parseInt(process.env.GOLEM_SPAWN_CORR_MS ?? `${30 * 1000}`, 10),
  // Cap on retained tool events per agent.
  hookCapPerAgent: parseInt(process.env.GOLEM_HOOK_CAP ?? '500', 10),
  journalCapPerAgent: parseInt(process.env.GOLEM_JOURNAL_CAP ?? '200', 10),
  // Cap on retained CEO chat messages (user briefs + CEO acks/responses).
  chatCap: parseInt(process.env.GOLEM_CHAT_CAP ?? '200', 10),
  // How often the SSE consumer retries when the channel server is unreachable.
  chatReconnectMs: parseInt(process.env.GOLEM_CHAT_RECONNECT_MS ?? '3000', 10),
};
