import os from 'node:os';
import path from 'node:path';
import { ticketAssetsDir } from '../../lib/golem-home.js';

const HOME = os.homedir();

function explicitPortArg() {
  const index = process.argv.findIndex((arg) => arg === '--port' || arg.startsWith('--port='));
  if (index < 0) return null;
  const raw = process.argv[index] === '--port' ? process.argv[index + 1] : process.argv[index].slice('--port='.length);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`--port requires an integer from 1 to 65535 (received ${raw ?? '(missing)'})`);
  }
  return port;
}

const PORT_ARG = explicitPortArg();

export const CONFIG = {
  // 7420 — deliberately off Vite's default (4173) so a project's dev server
  // can never shadow the dashboard on a shared port. Channel server is 7421.
  port: PORT_ARG ?? parseInt(process.env.PORT ?? '7420', 10),
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
    path.join(HOME, 'Documents/software/experiments/golem'),
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
  // TKT-0106: ticket asset directory. Content-addressed image storage used by
  // /api/ticket-assets (upload + serve).
  assetsDir: ticketAssetsDir(),
  // TKT-0106: max asset size in bytes. Defaults to 10 MB.
  assetMaxBytes: parseInt(process.env.GOLEM_ASSET_MAX_BYTES ?? `${10 * 1024 * 1024}`, 10),
  // TKT-0106: allowed MIME types for upload.
  assetAllowedMime: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
  // Cap on retained CEO chat messages (user briefs + CEO acks/responses).
  chatCap: parseInt(process.env.GOLEM_CHAT_CAP ?? '200', 10),
  // GOL-314: strict attribution rollout. Default is warn; reject is smoke-tested
  // but intentionally not enabled unless explicitly requested.
  attributionMode: (process.env.GOLEM_ATTRIBUTION_MODE ?? 'warn').toLowerCase(),
  // How often the SSE consumer retries when the channel server is unreachable.
  chatReconnectMs: parseInt(process.env.GOLEM_CHAT_RECONNECT_MS ?? '3000', 10),
  // Number of days since last project activity before it is considered stale.
  projectStaleDays: parseInt(process.env.GOLEM_PROJECT_STALE_DAYS ?? '30', 10),
};
