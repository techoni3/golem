import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { golemHome } from './lib/golem-home.js';
import { dashboardJsonPath } from './lib/golem-home.js';
import { createGolemClient, resolveGolemDashboardBaseUrl } from './lib/golem-client.js';
import { GOLEM_TOOL_CONTRACTS } from './lib/golem-tool-contracts.js';
import { createGolemToolRuntime } from './lib/golem-tool-runtime.js';
import { PiNativeAdapter } from './lib/pi-native-adapter.js';
import { readRoleCard, sessionsJsonPath, setSessionRole, validateSessionRole } from './lib/session-role.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PI_ROLES = new Set(['builder', 'explorer', 'reviewer']);

function sessionRole(sessionId) {
  try {
    const value = JSON.parse(fs.readFileSync(sessionsJsonPath(), 'utf8'));
    return value.sessions?.find((row) => row.session_id === sessionId)?.role ?? null;
  } catch { return null; }
}

function projectContext(sessionId, cwd) {
  const script = path.join(ROOT, 'hooks', 'tracker-context.sh');
  const out = execFileSync('bash', [script], {
    cwd, encoding: 'utf8', input: JSON.stringify({ session_id: sessionId, cwd }),
    stdio: ['pipe', 'pipe', 'ignore'], timeout: 3000,
  });
  return JSON.parse(out)?.hookSpecificOutput?.additionalContext?.trim() || '(no project context available)';
}

function toolText(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length <= 30_000 ? text : `${text.slice(0, 30_000)}\n… output truncated by Golem`;
}

// Pi-specific primitive binding. Shared transport, lifecycle, replay, facts,
// leases, and journaling live in the rendered runtime modules.
export default function golem(pi) {
  const adapter = new PiNativeAdapter(pi);
  adapter.bind();

  for (const contract of GOLEM_TOOL_CONTRACTS) {
    pi.registerTool({
      name: contract.name,
      label: contract.name,
      description: contract.description,
      parameters: contract.inputSchema,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        try {
          const sessionId = adapter.canonicalId || ctx.sessionManager.getSessionId();
          const client = createGolemClient({
            baseUrl: resolveGolemDashboardBaseUrl({ dashboardFile: dashboardJsonPath() }),
            callerSessionId: sessionId,
          });
          const runtime = createGolemToolRuntime({
            client,
            callerSessionId: sessionId,
            projectId: adapter.projectId,
            acknowledge: ({ envelope_id, ...body }) => {
              if (!envelope_id) return { ok: true, skipped: true, reason: 'uncorrelated acknowledgement has no durable envelope' };
              return client.acknowledgeEnvelope(envelope_id, body);
            },
            respond: (body) => client.respond(body),
            setRole: ({ role }) => {
              if (role != null && !PI_ROLES.has(role)) throw new Error(`Pi first-class worker role must be builder, explorer, reviewer, or clear (got ${role})`);
              validateSessionRole(role);
              return setSessionRole(sessionId, role, { by: 'self:mcp' });
            },
            projectContext: () => projectContext(sessionId, ctx.cwd),
          });
          const result = await runtime.invoke(contract.name, params || {});
          return { content: [{ type: 'text', text: toolText(result) }], details: { ok: true, result } };
        } catch (error) {
          const detail = typeof error?.toJSON === 'function' ? error.toJSON() : { name: error?.name || 'Error', message: error?.message || String(error) };
          return { content: [{ type: 'text', text: toolText(detail) }], details: { ok: false, error: detail }, isError: true };
        }
      },
    });
  }

  pi.on('resources_discover', () => ({ skillPaths: [path.join(ROOT, 'skills')] }));
  pi.on('before_agent_start', (event, ctx) => {
    const sessionId = adapter.canonicalId || ctx.sessionManager.getSessionId();
    const role = sessionRole(sessionId);
    const instructions = fs.readFileSync(path.join(ROOT, 'instructions', 'AGENTS.md'), 'utf8').trim();
    const roleCard = PI_ROLES.has(role) ? readRoleCard(role) : null;
    let ambient = '';
    try { ambient = projectContext(sessionId, ctx.cwd); } catch {}
    const boundary = 'Pi worker scope: this process may act only as builder, explorer, or reviewer. Lead/standalone orchestration and Pi subagent delegation are not available in this release.';
    return { systemPrompt: [event.systemPrompt, instructions, boundary, roleCard, ambient].filter(Boolean).join('\n\n') };
  });

  // Migration-only reader for records published by the former Tier-B adapter.
  // First-class typed dispatch never writes this spool; keep already-published
  // records recoverable until the dashboard cutover proves it empty.
  const home = golemHome();
  let canonicalId;
  let pendingPickup = [];
  pi.on('session_start', (_event, ctx) => {
    canonicalId = ctx.sessionManager.getSessionId();
  });
  pi.on('input', (event, ctx) => {
    if (event.source === 'extension') return;
    const id = canonicalId || ctx.sessionManager.getSessionId();
    const root = path.join(home, 'pi-inbox', id);
    const pending = path.join(root, 'pending');
    const processingDir = path.join(root, 'processing');
    const work = [
      ...(fs.existsSync(processingDir) ? fs.readdirSync(processingDir).sort().map((name) => ({ name, source: path.join(processingDir, name), claimed: true })) : []),
      ...(fs.existsSync(pending) ? fs.readdirSync(pending).sort().map((name) => ({ name, source: path.join(pending, name), claimed: false })) : []),
    ];
    const messages = [];
    for (const item of work) {
      const processing = path.join(root, 'processing', item.name);
      try {
        fs.mkdirSync(path.dirname(processing), { recursive: true });
        if (!item.claimed) fs.renameSync(item.source, processing);
        const value = JSON.parse(fs.readFileSync(processing, 'utf8'));
        if (typeof value?.text !== 'string') throw new Error('invalid text');
        messages.push(value);
        pendingPickup.push({ root, name: item.name });
      } catch {
        try {
          fs.mkdirSync(path.join(root, 'dead-letter'), { recursive: true });
          fs.renameSync(processing, path.join(root, 'dead-letter', item.name));
        } catch {}
      }
    }
    if (messages.length) return { action: 'transform', text: `${event.text}\n\n${messages.map((item) => item.text).join('\n\n')}` };
  });
  pi.on('agent_start', () => {
    for (const { root, name } of pendingPickup) {
      try {
        fs.mkdirSync(path.join(root, 'acks'), { recursive: true });
        fs.renameSync(path.join(root, 'processing', name), path.join(root, 'acks', name));
      } catch {}
    }
    pendingPickup = [];
  });
}
