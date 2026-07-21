import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { golemHome } from './lib/golem-home.js';
import { upsertSessionFact } from './lib/session-facts.js';

export default function golem(pi) {
  const home = golemHome();
  let canonicalId;
  let pendingPickup = [];
  let producerSequence = 0;
  const opaque = (prefix, value) => typeof value === 'string' && new RegExp(`^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, 'i').test(value);
  const safeSessionKey = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/.test(value) ? value : null;
  function bindingFor(rawSessionId) {
    const key = safeSessionKey(rawSessionId); if (!key) return null;
    try {
      const value = JSON.parse(fs.readFileSync(path.join(home, 'pi-adapter', 'bindings', `${key}.json`), 'utf8'));
      if (!opaque('prj', value?.project_id) || !opaque('ses', value?.session_id) || !opaque('gen', value?.generation_id) || !opaque('ep', value?.endpoint_id) || !opaque('prod', value?.producer_instance_id) || typeof value?.owner_fence !== 'string' || !/^[1-9][0-9]*$/.test(value.owner_fence)) return null;
      return value;
    } catch { return null; }
  }
  function diagnostic(rawSessionId, code) {
    const key = safeSessionKey(rawSessionId); if (!key) return;
    try {
      const dir = path.join(home, 'pi-adapter', 'diagnostics'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const target = path.join(dir, `${key}.json`); const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ schema_version: 'golem.pi-adapter-diagnostic/v1', session_key: key, code, delivery_mode: 'next_turn', push_ready: false }) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, target);
    } catch {}
  }
  function spoolSignal(signal) {
    const pending = path.join(home, 'pi-adapter', 'runtime-events', 'pending');
    fs.mkdirSync(pending, { recursive: true, mode: 0o700 });
    const target = path.join(pending, `${signal.event_id}.json`); const tmp = path.join(pending, `.${signal.event_id}.${process.pid}.tmp`);
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(signal) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.linkSync(tmp, target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    try { fs.unlinkSync(tmp); } catch {}
  }
  function lifecycle(ctx, nativeEvent, observations = {}) {
    const rawSessionId = ctx.sessionManager.getSessionId(); const binding = bindingFor(rawSessionId);
    if (!binding) { diagnostic(rawSessionId, 'pi.binding.unqualified'); return; }
    const observedAt = new Date().toISOString(); const generation = { project_id: binding.project_id, session_id: binding.session_id, generation_id: binding.generation_id };
    const signal = (event_kind, payload) => {
      producerSequence += 1;
      spoolSignal({ schema_version: 'golem.runtime-signal/v1', event_id: `evt_${crypto.randomUUID()}`, event_kind,
        producer: 'golem-pi-extension', producer_instance_id: binding.producer_instance_id, harness: 'pi', producer_sequence: producerSequence,
        correlation_id: binding.generation_id, deduplication_key: `pi:${binding.generation_id}:${producerSequence}:${event_kind}`,
        owner_fence: binding.owner_fence, clocks: { source_observed_at: observedAt, received_at: observedAt },
        provenance: { source: 'adapter', evidence_id: binding.generation_id, confidence: 'observed' }, clear_fields: [], payload });
    };
    if (nativeEvent === 'session_start') {
      const resumed = observations.reason === 'resume';
      signal(resumed ? 'session.resumed' : 'session.started', resumed ? { kind: 'session.resumed', generation } : { kind: 'session.started', generation, metadata: { name: ctx.sessionManager.getSessionName() || '' } });
      if (!resumed) {
        signal('endpoint.claimed', { kind: 'endpoint.claimed', endpoint: { endpoint_id: binding.endpoint_id, generation, state: 'healthy', owner_fence: binding.owner_fence, delivery_mode: 'next_turn', readiness: 'next_turn', revision: 1, last_heartbeat_at: observedAt } });
        signal('capabilities.reported', { kind: 'capabilities.reported', project: { project_id: binding.project_id }, capabilities: [{ capability_id: 'pi.next-turn.pull', harness: 'pi', adapter_version: '5.1.1', integration_layers: ['extension'], qualification: 'supported', delivery_mode: 'next_turn', readiness: 'next_turn', reason_code: 'real_user_turn_required', evidence_version: 'pi-next-turn-v1' }] });
      }
    } else if (nativeEvent === 'session_info_changed') signal('session.metadata_patched', { kind: 'session.metadata_patched', generation, metadata: { name: observations.name || ctx.sessionManager.getSessionName() || '' } });
    else if (nativeEvent === 'agent_start') signal('session.activity', { kind: 'session.activity', generation, activity_kind: 'work' });
    else if (nativeEvent === 'agent_settled') signal('session.idle', { kind: 'session.idle', generation });
    else if (nativeEvent === 'tool_call') signal('session.activity', { kind: 'session.activity', generation, activity_kind: 'tool' });
    else if (nativeEvent === 'session_shutdown') signal('session.ended', { kind: 'session.ended', generation, disposition: 'ended' });
  }
  function record(ctx, event, status, observations = {}) {
    const id = ctx.sessionManager.getSessionId();
    canonicalId = id;
    try {
      upsertSessionFact({ canonical_id: id, continuation_key: id, harness: 'pi',
        locator: { raw_session_id: id, session_file: ctx.sessionManager.getSessionFile() }, project_path: ctx.cwd,
        name: ctx.sessionManager.getSessionName(), status, delivery: { mode: 'next_turn', push: false },
        lifecycle_event: event, observations, observed_at: new Date().toISOString() });
    } catch {}
    try { lifecycle(ctx, event, observations); } catch { diagnostic(id, 'pi.runtime_signal.spool_failed'); }
  }
  pi.on('session_start', (event, ctx) => record(ctx, 'session_start', 'idle', { reason: event.reason }));
  pi.on('session_info_changed', (event, ctx) => record(ctx, 'session_info_changed', ctx.isIdle() ? 'idle' : 'active', { name: event.name }));
  pi.on('agent_start', (_event, ctx) => {
    record(ctx, 'agent_start', 'active');
    for (const { root, name, canonical, claimToken } of pendingPickup) {
      try {
        fs.mkdirSync(path.join(root, 'acks'), { recursive: true }); fs.renameSync(path.join(root, 'processing', name), path.join(root, 'acks', name));
        if (canonical && claimToken) {
          try { fs.unlinkSync(path.join(root, 'processing', `${name}.lease.json`)); } catch {}
          const acknowledgementId = `del_${crypto.randomUUID()}`;
          const ack = path.join(root, 'acks', `${name}.lease.json`); const temporary = `${ack}.${process.pid}.tmp`;
          fs.writeFileSync(temporary, JSON.stringify({ acknowledgement_id: acknowledgementId, claim_token: claimToken }) + '\n', { mode: 0o600 }); fs.renameSync(temporary, ack);
        }
      } catch {}
    }
    pendingPickup = [];
  });
  pi.on('agent_settled', (_event, ctx) => record(ctx, 'agent_settled', 'idle'));
  pi.on('tool_call', (event, ctx) => record(ctx, 'tool_call', 'active', { tool_name: event.toolName, tool_call_id: event.toolCallId }));
  pi.on('session_shutdown', (event, ctx) => record(ctx, 'session_shutdown', 'ended', { reason: event.reason }));
  pi.on('input', (_event, ctx) => {
    const id = canonicalId || ctx.sessionManager.getSessionId();
    const root = path.join(home, 'pi-inbox', id); const pending = path.join(root, 'pending');
    const binding = bindingFor(id); const canonicalRoot = binding ? path.join(home, 'pi-next-turn', binding.session_id, binding.generation_id) : null;
    const messages = []; const processingDir = path.join(root, 'processing');
    const work = [
      ...(fs.existsSync(processingDir) ? fs.readdirSync(processingDir).sort().map((name) => ({ name, source: path.join(processingDir, name), claimed: true })) : []),
      ...(fs.existsSync(pending) ? fs.readdirSync(pending).sort().map((name) => ({ name, source: path.join(pending, name), claimed: false })) : []),
    ];
    for (const item of work) {
      const { name, source } = item; const processing = path.join(root, 'processing', name);
      try {
        fs.mkdirSync(path.dirname(processing), { recursive: true }); if (!item.claimed) fs.renameSync(source, processing);
        const value = JSON.parse(fs.readFileSync(processing, 'utf8'));
        if (typeof value?.text !== 'string') throw new Error('invalid text');
        messages.push(value); pendingPickup.push({ root, name });
      } catch {
        try { fs.mkdirSync(path.join(root, 'dead-letter'), { recursive: true }); fs.renameSync(processing, path.join(root, 'dead-letter', name)); } catch {}
      }
    }
    if (canonicalRoot && binding) {
      const canonicalProcessing = path.join(canonicalRoot, 'processing'); const canonicalPending = path.join(canonicalRoot, 'pending');
      const canonicalWork = [
        ...(fs.existsSync(canonicalProcessing) ? fs.readdirSync(canonicalProcessing).filter((name) => name.endsWith('.json') && !name.endsWith('.lease.json')).sort().map((name) => ({ name, source: path.join(canonicalProcessing, name), claimed: true })) : []),
        ...(fs.existsSync(canonicalPending) ? fs.readdirSync(canonicalPending).filter((name) => name.endsWith('.json')).sort().map((name) => ({ name, source: path.join(canonicalPending, name), claimed: false })) : []),
      ];
      for (const item of canonicalWork) {
        const { name, source } = item; const processing = path.join(canonicalRoot, 'processing', name);
        try {
          fs.mkdirSync(path.dirname(processing), { recursive: true }); if (!item.claimed) fs.renameSync(source, processing);
          const value = JSON.parse(fs.readFileSync(processing, 'utf8'));
          const matches = value?.schema_version === 'golem.pi-next-turn/v1' && value?.binding?.project_id === binding.project_id && value?.binding?.session_id === binding.session_id && value?.binding?.generation_id === binding.generation_id && value?.binding?.endpoint_id === binding.endpoint_id && value?.binding?.owner_fence === binding.owner_fence;
          if (!matches || typeof value?.text !== 'string' || typeof value?.claimToken !== 'string') throw new Error('invalid canonical next-turn record');
          messages.push(value); pendingPickup.push({ root: canonicalRoot, name, canonical: true, claimToken: value.claimToken });
        } catch {
          try { fs.mkdirSync(path.join(canonicalRoot, 'dead-letter'), { recursive: true }); fs.renameSync(processing, path.join(canonicalRoot, 'dead-letter', name)); } catch {}
        }
      }
    }
    if (messages.length) return { action: 'transform', text: `${_event.text}\n\n${messages.map((x) => x.text).join('\n\n')}` };
  });
}
