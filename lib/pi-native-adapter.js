// Thin Pi translation layer over Golem's shared typed-worker endpoint.
// Queueing, envelope validation, replay identity, and lifecycle semantics stay
// in the shared modules; this class owns only Pi primitives and observations.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  acceptTypedDelivery,
  claimTypedDelivery,
  closeTypedWorkerEndpoint,
  getTypedDelivery,
  interruptTypedDelivery,
  normalizeTypedWorkerInbox,
  releaseTypedDeliveryClaim,
  reportTypedDeliveryLifecycle,
  requireTypedDeliveryRecovery,
  settleTypedDelivery,
  startTypedWorkerEndpoint,
  typedDeliveryResult,
} from './typed-worker-endpoint.js';
import {
  readTypedDeliveryTombstone,
  upsertTypedDeliveryTombstone,
} from './typed-delivery-tombstones.js';
import {
  DEFAULT_LEASE_TTL_MS,
  releaseEndpointLeases,
  renewEndpointLease,
  upsertSessionFact,
} from './session-facts.js';
import { dashboardJsonPath, golemHome, journalDirFor } from './golem-home.js';
import { projectIdFor, resolveProjectRoot } from './project-id.js';

const ADAPTER_SCHEMA = 1;
const ACCEPT_TIMEOUT_MS = 10_000;
const CONTROL_TIMEOUT_MS = 10_000;

function iso(value = Date.now()) { return new Date(value).toISOString(); }

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp.${process.pid}.${crypto.randomUUID()}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

function dashboardBaseUrl() {
  try {
    const value = JSON.parse(fs.readFileSync(dashboardJsonPath(), 'utf8'));
    if (typeof value?.url === 'string' && value.url.trim()) return value.url.replace(/\/+$/, '');
    if (value?.host && value?.port) return `http://${value.host}:${value.port}`;
  } catch {}
  return 'http://dashboard.golem.localhost:7420';
}

export class PiNativeAdapter {
  constructor(pi, {
    home = golemHome(),
    ownerToken = crypto.randomUUID(),
    acceptTimeoutMs = ACCEPT_TIMEOUT_MS,
    controlTimeoutMs = CONTROL_TIMEOUT_MS,
  } = {}) {
    this.pi = pi;
    this.home = home;
    this.ownerToken = ownerToken;
    this.acceptTimeoutMs = acceptTimeoutMs;
    this.controlTimeoutMs = controlTimeoutMs;
    this.canonicalId = null;
    this.ctx = null;
    this.state = 'idle';
    this.endpoint = null;
    this.heartbeat = null;
    this.pendingAcceptance = null;
    this.pendingControl = null;
    this.projectRoot = null;
    this.projectId = null;
    this.recordFile = null;
  }

  bind() {
    this.pi.on('session_start', (event, ctx) => this.sessionStart(event, ctx));
    this.pi.on('session_info_changed', (event, ctx) => this.observe(ctx, 'session_info_changed', this.state === 'idle' ? 'idle' : 'active', { name: event.name }));
    this.pi.on('input', (event, ctx) => this.input(event, ctx));
    this.pi.on('agent_start', (event, ctx) => this.agentStart(event, ctx));
    this.pi.on('agent_settled', (event, ctx) => this.agentSettled(event, ctx));
    this.pi.on('tool_call', (event, ctx) => this.observe(ctx, 'tool_call', 'active', { tool_name: event.toolName, tool_call_id: event.toolCallId }));
    this.pi.on('session_shutdown', (event, ctx) => this.sessionShutdown(event, ctx));
  }

  defaultRecord() {
    return { schema: ADAPTER_SCHEMA, canonical_id: this.canonicalId, inbox: normalizeTypedWorkerInbox() };
  }

  readRecord() {
    const raw = readJson(this.recordFile, this.defaultRecord());
    return { ...this.defaultRecord(), ...raw, inbox: normalizeTypedWorkerInbox(raw?.inbox) };
  }

  writeRecord(record) {
    atomicJson(this.recordFile, { ...record, schema: ADAPTER_SCHEMA, canonical_id: this.canonicalId, updated_at: iso() });
    return record;
  }

  currentDelivery(record = this.readRecord()) {
    return record.inbox.in_flight_envelope_id
      ? getTypedDelivery(record.inbox, record.inbox.in_flight_envelope_id)
      : null;
  }

  deliveryReady() {
    return Boolean(this.endpoint && this.ctx && this.state === 'idle'
      && this.ctx.isIdle() && !this.ctx.hasPendingMessages()
      && !this.readRecord().inbox.in_flight_envelope_id);
  }

  persistLease() {
    if (!this.endpoint || !this.canonicalId) return null;
    return renewEndpointLease({
      canonical_id: this.canonicalId,
      owner_token: this.ownerToken,
      host: this.endpoint.host,
      port: this.endpoint.port,
      pid: process.pid,
      harness: 'pi',
      transport: 'http',
      kind: 'typed-worker',
      delivery_ready: this.deliveryReady(),
    });
  }

  startHeartbeat() {
    const interval = Math.max(1_000, Math.floor(DEFAULT_LEASE_TTL_MS / 3));
    this.heartbeat = setInterval(() => {
      try { this.persistLease(); } catch {}
      void this.flushTerminalReports();
    }, interval);
    this.heartbeat.unref?.();
  }

  async sessionStart(event, ctx) {
    this.ctx = ctx;
    this.canonicalId = ctx.sessionManager.getSessionId();
    this.recordFile = path.join(this.home, 'pi-workers', this.canonicalId, 'delivery.json');
    this.projectRoot = await resolveProjectRoot(ctx.cwd);
    this.projectId = projectIdFor(this.projectRoot);
    const record = this.readRecord();
    const inFlight = this.currentDelivery(record);
    if (inFlight?.lifecycle_state === 'claimed') {
      releaseTypedDeliveryClaim(record.inbox, inFlight.envelope_id, { attemptId: inFlight.attempt_id, error: 'Pi restarted before correlated agent_start' });
      this.writeRecord(record);
    } else if (inFlight?.lifecycle_state === 'accepted') {
      const recovery = requireTypedDeliveryRecovery(record.inbox, inFlight.envelope_id, { error: 'Pi session restarted before agent_settled' });
      upsertTypedDeliveryTombstone(this.canonicalId, recovery.delivery);
      this.writeRecord(record);
    }
    this.state = 'idle';
    this.endpoint = await startTypedWorkerEndpoint({
      canonicalId: this.canonicalId,
      ownerToken: this.ownerToken,
      deliveryReady: () => this.deliveryReady(),
      acceptDelivery: (envelope) => this.acceptEnvelope(envelope),
    });
    this.persistLease();
    this.startHeartbeat();
    this.observe(ctx, 'session_start', 'idle', {
      reason: event.reason,
      previous_session_file: event.previousSessionFile ?? null,
      endpoint_port: this.endpoint.port,
    });
    await this.flushTerminalReports();
  }

  async acceptEnvelope(envelope) {
    if (envelope.kind === 'interrupt') return this.handleInterrupt(envelope);
    if (envelope.kind === 'halt') return this.handleHalt(envelope);
    const priorRecord = this.readRecord();
    const prior = getTypedDelivery(priorRecord.inbox, envelope.envelope_id)
      || readTypedDeliveryTombstone(this.canonicalId, envelope.envelope_id);
    if (prior) return typedDeliveryResult(prior, { duplicate: true, attemptId: envelope.attempt_id });
    if (!this.deliveryReady()) return { ok: false, accepted: false, http_status: 409, error: `Pi worker is ${this.state}` };

    this.state = 'starting'; // synchronous reservation before any native call
    const record = this.readRecord();
    const claim = claimTypedDelivery(record.inbox, envelope, {
      lookupTombstone: (id) => readTypedDeliveryTombstone(this.canonicalId, id),
    });
    if (claim.fenced) { this.state = 'idle'; return { ok: false, accepted: false, http_status: 409, error: 'delivery predates replay fence' }; }
    if (claim.busy) { this.state = 'idle'; return { ok: false, accepted: false, http_status: 409, error: 'Pi worker already has in-flight work' }; }
    if (claim.duplicate) {
      this.state = claim.delivery.lifecycle_state === 'claimed' ? 'starting' : 'idle';
      return typedDeliveryResult(claim.delivery, { duplicate: true, attemptId: envelope.attempt_id });
    }
    this.writeRecord(record);

    let resolveAcceptance;
    const accepted = new Promise((resolve) => { resolveAcceptance = resolve; });
    const timer = setTimeout(() => {
      const latest = this.readRecord();
      const current = getTypedDelivery(latest.inbox, envelope.envelope_id);
      if (current?.lifecycle_state === 'claimed') {
        const correlated = this.pendingAcceptance?.envelopeId === envelope.envelope_id
          && this.pendingAcceptance.inputSeen;
        const disposition = correlated
          ? requireTypedDeliveryRecovery(latest.inbox, envelope.envelope_id, {
            error: 'Pi emitted correlated input but not agent_start before timeout',
          })
          : releaseTypedDeliveryClaim(latest.inbox, envelope.envelope_id, {
            attemptId: envelope.attempt_id,
            error: 'Pi did not emit correlated input and agent_start before timeout',
          });
        if (correlated) upsertTypedDeliveryTombstone(this.canonicalId, disposition.delivery);
        this.writeRecord(latest);
        this.pendingAcceptance = null;
        this.state = correlated ? 'active' : (this.ctx?.isIdle() ? 'idle' : 'active');
        this.persistLease();
        resolveAcceptance(correlated
          ? typedDeliveryResult(disposition.delivery, { attemptId: envelope.attempt_id })
          : { ok: false, accepted: false, http_status: 503, error: 'Pi did not accept the typed turn before timeout' });
        if (this.pendingControl) {
          this.finishControl(this.pendingControl, correlated
            ? { ok: false, accepted: false, http_status: 503, error: 'Pi control could not settle correlated preflight before timeout' }
            : this.controlResult(this.pendingControl.envelope));
        }
      }
    }, this.acceptTimeoutMs);
    timer.unref?.();
    this.pendingAcceptance = {
      envelopeId: envelope.envelope_id,
      attemptId: envelope.attempt_id,
      content: envelope.content,
      resolve: resolveAcceptance,
      timer,
      inputSeen: false,
    };
    try {
      this.pi.sendUserMessage(envelope.content);
    } catch (error) {
      clearTimeout(timer);
      this.pendingAcceptance = null;
      const latest = this.readRecord();
      releaseTypedDeliveryClaim(latest.inbox, envelope.envelope_id, { attemptId: envelope.attempt_id, error: error?.message ?? String(error) });
      this.writeRecord(latest);
      this.state = 'idle';
      return { ok: false, accepted: false, http_status: 503, error: error?.message ?? String(error) };
    }
    this.persistLease();
    return accepted;
  }

  input(event, ctx) {
    this.ctx = ctx;
    // Pi emits input before agent_start. Reserve the single native turn for
    // every source so an interactive or migration turn cannot race a typed
    // delivery through the pre-agent gap.
    if (this.state === 'idle') this.state = 'starting';
    if (event.source === 'extension' && this.pendingAcceptance
      && event.text === this.pendingAcceptance.content) {
      this.pendingAcceptance.inputSeen = true;
    }
    this.persistLease();
    // Legacy next-turn migration is intentionally left to the old input reader
    // until the dashboard cutover slice stops publishing new records.
  }

  agentStart(_event, ctx) {
    this.ctx = ctx;
    this.state = 'active';
    const pending = this.pendingAcceptance;
    if (pending) {
      const record = this.readRecord();
      clearTimeout(pending.timer);
      this.pendingAcceptance = null;
      if (pending.inputSeen) {
        const accepted = acceptTypedDelivery(record.inbox, pending.envelopeId, { turnId: ctx.sessionManager.getLeafId?.() ?? null }).delivery;
        upsertTypedDeliveryTombstone(this.canonicalId, accepted);
        this.writeRecord(record);
        pending.resolve(typedDeliveryResult(accepted, { attemptId: pending.attemptId }));
        // abort() during idle preflight is a no-op in Pi 0.80.10. Repeat it at
        // the first native boundary that guarantees an active agent run.
        if (this.pendingControl) {
          try { ctx.abort(); } catch {}
        }
      } else {
        releaseTypedDeliveryClaim(record.inbox, pending.envelopeId, {
          attemptId: pending.attemptId,
          error: 'A different Pi input reached agent_start before the typed turn',
        });
        this.writeRecord(record);
        pending.resolve({ ok: false, accepted: false, http_status: 409, error: 'Typed turn was displaced by another Pi input; retry when idle' });
      }
    }
    this.persistLease();
    this.observe(ctx, 'agent_start', 'active');
  }

  async agentSettled(_event, ctx) {
    this.ctx = ctx;
    if (this.pendingAcceptance) {
      const pending = this.pendingAcceptance;
      clearTimeout(pending.timer);
      this.pendingAcceptance = null;
      const unaccepted = this.readRecord();
      releaseTypedDeliveryClaim(unaccepted.inbox, pending.envelopeId, {
        attemptId: pending.attemptId,
        error: 'Pi settled without a correlated agent_start',
      });
      this.writeRecord(unaccepted);
      pending.resolve({ ok: false, accepted: false, http_status: 503, error: 'Pi settled without accepting the typed turn' });
    }
    const record = this.readRecord();
    const delivery = this.currentDelivery(record);
    const control = this.pendingControl;
    if (delivery?.lifecycle_state === 'accepted' && control) {
      const interrupted = interruptTypedDelivery(record.inbox, delivery.envelope_id, {
        turnId: ctx.sessionManager.getLeafId?.() ?? delivery.turn_id,
        completionStatus: control.kind === 'halt' ? 'halted' : 'aborted',
      }).delivery;
      upsertTypedDeliveryTombstone(this.canonicalId, interrupted);
      this.writeRecord(record);
      await this.reportTerminal(interrupted);
    } else if (delivery?.lifecycle_state === 'accepted') {
      const settled = settleTypedDelivery(record.inbox, delivery.envelope_id, { turnId: ctx.sessionManager.getLeafId?.() ?? delivery.turn_id, completionStatus: 'settled' }).delivery;
      upsertTypedDeliveryTombstone(this.canonicalId, settled);
      this.writeRecord(record);
      await this.reportTerminal(settled);
    }
    if (control) this.finishControl(control);
    else if (this.state !== 'stopping') this.state = 'idle';
    this.persistLease();
    this.observe(ctx, 'agent_settled', this.state === 'stopping' ? 'stopping' : 'idle');
  }

  async handleInterrupt(envelope) {
    return this.control(envelope, 'interrupt');
  }

  async handleHalt(envelope) {
    return this.control(envelope, 'halt');
  }

  controlResult(envelope) {
    return {
      ok: true, accepted: true, http_status: 200,
      envelope_id: envelope.envelope_id,
      attempt_id: envelope.attempt_id,
      accepted_attempt_id: envelope.attempt_id,
      delivery_state: 'settled', turn_id: null,
    };
  }

  async control(envelope, kind) {
    if (this.pendingControl) {
      return { ok: false, accepted: false, http_status: 409, error: 'Pi worker already has a pending control request' };
    }
    if (kind === 'halt') this.state = 'stopping';

    let correlatedPreflight = false;
    if (this.pendingAcceptance?.inputSeen) {
      // Pi has consumed the exact input, but may still be awaiting auth,
      // compaction, or before_agent_start. It cannot cancel that idle preflight,
      // so keep the claim and abort again when agent_start makes it cancellable.
      correlatedPreflight = true;
    } else if (this.pendingAcceptance) {
      // Without correlated input, the native prompt has not begun and the
      // exact claim remains safe to release for retry.
      const pending = this.pendingAcceptance;
      clearTimeout(pending.timer);
      this.pendingAcceptance = null;
      const record = this.readRecord();
      releaseTypedDeliveryClaim(record.inbox, pending.envelopeId, {
        attemptId: pending.attemptId,
        error: `Pi ${kind} before typed acceptance`,
      });
      this.writeRecord(record);
      pending.resolve({ ok: false, accepted: false, http_status: 503, error: `Pi ${kind} before typed acceptance` });
    }

    const record = this.readRecord();
    const active = this.currentDelivery(record);
    const nativeBusy = this.ctx && !this.ctx.isIdle();
    if (!correlatedPreflight && !nativeBusy && active?.lifecycle_state !== 'accepted') {
      if (kind !== 'halt') this.state = 'idle';
      this.persistLease();
      if (kind === 'halt') setImmediate(() => this.ctx?.shutdown());
      return this.controlResult(envelope);
    }

    let resolveControl;
    const settled = new Promise((resolve) => { resolveControl = resolve; });
    const control = { envelope, kind, resolve: resolveControl, timer: null };
    control.timer = setTimeout(() => { void this.controlTimeout(control); }, this.controlTimeoutMs);
    control.timer.unref?.();
    this.pendingControl = control;
    try { this.ctx?.abort(); } catch {}
    return settled;
  }

  finishControl(control, result = this.controlResult(control.envelope)) {
    if (this.pendingControl !== control) return;
    clearTimeout(control.timer);
    this.pendingControl = null;
    if (control.kind === 'halt') {
      this.state = 'stopping';
      // The endpoint must serialize the disposition before shutdown closes it.
      setImmediate(() => this.ctx?.shutdown());
    } else {
      this.state = 'idle';
    }
    this.persistLease();
    control.resolve(result);
  }

  async controlTimeout(control) {
    if (this.pendingControl !== control) return;
    const record = this.readRecord();
    const active = this.currentDelivery(record);
    if (active?.lifecycle_state === 'accepted'
      || (active?.lifecycle_state === 'claimed' && this.pendingAcceptance?.inputSeen)) {
      const recovery = requireTypedDeliveryRecovery(record.inbox, active.envelope_id, {
        error: `Pi did not observe ${control.kind} settlement before timeout`,
      }).delivery;
      upsertTypedDeliveryTombstone(this.canonicalId, recovery);
      this.writeRecord(record);
      if (this.pendingAcceptance) {
        const pending = this.pendingAcceptance;
        clearTimeout(pending.timer);
        this.pendingAcceptance = null;
        pending.resolve(typedDeliveryResult(recovery, { attemptId: pending.attemptId }));
      }
      await this.reportTerminal(recovery);
    }
    this.finishControl(control, {
      ok: false, accepted: false, http_status: 503,
      error: `Pi did not settle after ${control.kind} before timeout`,
    });
  }

  async reportTerminal(delivery) {
    return reportTypedDeliveryLifecycle({
      baseUrl: dashboardBaseUrl(), canonicalId: this.canonicalId,
      ownerToken: this.ownerToken, delivery,
    });
  }

  async flushTerminalReports() {
    const record = this.readRecord();
    for (const delivery of record.inbox.deliveries) {
      if (['settled', 'interrupted', 'recovery_required'].includes(delivery.lifecycle_state)) await this.reportTerminal(delivery);
    }
  }

  observe(ctx, event, status, observations = {}) {
    if (!this.canonicalId) return;
    const model = ctx.model;
    const fact = upsertSessionFact({
      canonical_id: this.canonicalId,
      continuation_key: this.canonicalId,
      harness: 'pi',
      locator: { raw_session_id: this.canonicalId, session_file: ctx.sessionManager.getSessionFile() },
      project_path: this.projectRoot || ctx.cwd,
      name: ctx.sessionManager.getSessionName(),
      status,
      provider: model?.provider ?? null,
      model: model?.id ?? null,
      delivery: { mode: 'typed-worker', push: true, ready: this.deliveryReady() },
      capabilities: { typed_worker: true },
      trust: 'host-full-trust',
      lifecycle_event: event,
      observations: { adapter_state: this.state, ...observations },
      observed_at: iso(),
    });
    this.appendJournal(event, observations);
    return fact;
  }

  appendJournal(event, payload = {}) {
    if (!this.projectId || !this.projectRoot) return;
    try {
      const dir = journalDirFor(this.projectId);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'hook.jsonl'), `${JSON.stringify({
        ts: iso(), event, session_id: this.canonicalId, cwd: this.ctx?.cwd,
        project_id: this.projectId, project_path: this.projectRoot,
        payload: { harness: 'pi', ...payload },
      })}\n`, { mode: 0o600 });
    } catch {}
  }

  async sessionShutdown(event, ctx) {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const record = this.recordFile ? this.readRecord() : null;
    const active = record ? this.currentDelivery(record) : null;
    if (active?.lifecycle_state === 'claimed') {
      releaseTypedDeliveryClaim(record.inbox, active.envelope_id, { attemptId: active.attempt_id, error: `Pi shutdown before acceptance (${event.reason})` });
      this.writeRecord(record);
    } else if (active?.lifecycle_state === 'accepted') {
      const recovery = requireTypedDeliveryRecovery(record.inbox, active.envelope_id, { error: `Pi shutdown before settlement (${event.reason})` });
      upsertTypedDeliveryTombstone(this.canonicalId, recovery.delivery);
      this.writeRecord(record);
      await this.reportTerminal(recovery.delivery);
    }
    if (this.pendingAcceptance) {
      clearTimeout(this.pendingAcceptance.timer);
      this.pendingAcceptance.resolve({ ok: false, accepted: false, http_status: 503, error: 'Pi session shut down before acceptance' });
      this.pendingAcceptance = null;
    }
    if (this.pendingControl) {
      const control = this.pendingControl;
      clearTimeout(control.timer);
      this.pendingControl = null;
      control.resolve({ ok: false, accepted: false, http_status: 503, error: 'Pi session shut down before control settlement' });
    }
    releaseEndpointLeases(this.ownerToken, { canonicalId: this.canonicalId });
    await closeTypedWorkerEndpoint(this.endpoint?.server);
    this.endpoint = null;
    this.state = 'stopping';
    this.observe(ctx, 'session_shutdown', 'ended', { reason: event.reason, target_session_file: event.targetSessionFile ?? null });
  }
}
