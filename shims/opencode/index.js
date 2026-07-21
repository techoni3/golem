// golem opencode runtime shim (TKT-0577, P5 — ADR-7).
//
// Bridges opencode's plugin event bus to golem's EXISTING Claude Code hook
// scripts, so an opencode session journals + self-registers exactly like a CC
// session. Each opencode event is normalized into the CC-shaped stdin JSON the
// scripts already parse (`{session_id, cwd, harness:"opencode", …}`) and piped
// to `substrate/hooks/*.sh`. The scripts are unchanged except for an additive
// optional `harness` field in session-register.sh.
//
// Event → CC event_kind (observed via a probe plugin, TKT-0577 research):
//   session.created (parentID null)   → session-register.sh + journal session-start
//                                      (session-register also performs P6
//                                       project sync-on-register)
//   session.updated (parentID null)   → registry name/cwd refresh (info.title is
//                                       the only real-time source of the title)
//   session.status                    → registry status refresh; status is an
//                                       OBJECT {type:"idle"|"retry"|"busy"} —
//                                       collapsed to a string via statusString()
//   chat.message (user)               → journal user-prompt
//   tool.execute.before               → journal tool-pre   (tool "task" → agent-spawn)
//   tool.execute.after                → journal tool-post  (tool "task" → agent-return)
//   session.idle                      → journal stop
//   session.compacted                 → journal pre-compact
//   session.deleted (parentID null)   → journal session-end + mark session ended
//   server.instance.disposed          → mark this shim's sessions ended
//   experimental.chat.system.transform→ append tracker-context.sh text to system[]
//
// RESILIENCE (non-negotiable, ADR-7): this must NEVER stall or crash an
// opencode session. Every shell-out is fire-and-forget (spawned, stdin written,
// not awaited); every failure is caught and logged to
// ~/.golem/logs/opencode-shim.log; no hook throws back into the harness.
// Log triage: no [init] means the shim never loaded; [init] without
// [session.created] means no session was created; [session.created] without
// [registered] means registration failed and the adjacent error is actionable.

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, rmdirSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import os from "node:os";
import { upsertSessionFact } from "../../lib/session-facts.js";

const SHIM_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SHIM_DIR, "..", ".."); // shims/opencode → repo root
// GOLEM_HOOKS_DIR overrides the script location (used by the fail-open test to
// point at a deliberately-broken copy); defaults to the repo's substrate hooks.
const HOOKS_DIR = process.env.GOLEM_HOOKS_DIR || join(REPO_ROOT, "substrate", "hooks");

// Minimal mirror of lib/golem-home.js resolution (for the shim's own log dir).
function golemHome() {
  if (process.env.GOLEM_HOME) return process.env.GOLEM_HOME;
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "golem");
  const dot = join(os.homedir(), ".golem");
  if (existsSync(dot)) return dot;
  return join(os.homedir(), ".config", "golem");
}

const LOG_DIR = join(golemHome(), "logs");
const LOG_FILE = join(LOG_DIR, "opencode-shim.log");
const HOST = "127.0.0.1";
const VERSION = "0.1.0";
const BRIDGES_REGISTRY = join(golemHome(), "opencode-bridges.json");
const BRIDGES_LOCK = `${BRIDGES_REGISTRY}.lock`;
const SESSIONS_REGISTRY = join(golemHome(), "sessions.json");
const SESSIONS_LOCK = `${SESSIONS_REGISTRY}.lock`;
const RESUME_FALLBACK_MAX_AGE_MS = 5 * 60 * 1000;
const ENDED_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSION_REGISTRY_ROWS = 500;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
let currentSessionID = "";

// Opencode namespaces MCP tools with a user-configurable server name. Match
// only golem's suffixes so injected identity keys never reach foreign tools.
const GOLEM_TOOL_SUFFIXES = new Set([
  "ticket_list", "ticket_get", "ticket_create", "ticket_update", "ticket_comment",
  "ticket_comment_update", "ticket_comment_reply", "ticket_dispatch", "ticket_transition",
  "ack", "respond", "session_notify", "session_role", "sessions_dispatchable",
  "subscribe", "unsubscribe", "subscriptions_list", "stream_create", "stream_list",
  "consult_request", "consult_reply", "consult_status",
]);

function isGolemToolName(name) {
  return typeof name === "string" && [...GOLEM_TOOL_SUFFIXES].some((tool) => name === tool || name.endsWith(`_${tool}`));
}

function opencodeStateDir() {
  if (process.env.OPENCODE_STATE_DIR) return process.env.OPENCODE_STATE_DIR;
  if (process.env.XDG_STATE_HOME) return join(process.env.XDG_STATE_HOME, "opencode");
  return join(os.homedir(), ".local", "state", "opencode");
}

function opencodeDataDir() {
  if (process.env.OPENCODE_DATA_DIR) return process.env.OPENCODE_DATA_DIR;
  if (process.env.XDG_DATA_HOME) return join(process.env.XDG_DATA_HOME, "opencode");
  return join(os.homedir(), ".local", "share", "opencode");
}

function normalizeModelId(value) {
  const s = typeof value === "string" ? value.trim() : "";
  return s || null;
}

function normalizeModelValue(value) {
  if (!value) return null;
  if (typeof value === "object") return modelFromObject(value);
  const s = normalizeModelId(value);
  if (!s) return null;
  if (s[0] === "{" || s[0] === "[") {
    try {
      const parsed = JSON.parse(s);
      return modelFromObject(parsed) || normalizeModelId(parsed?.id);
    }
    catch { /* not JSON; use the raw string */ }
  }
  return s;
}

function modelFromObject(obj) {
  if (!obj || typeof obj !== "object") return null;
  return normalizeModelValue(
    obj.modelID || obj.modelId || obj.model_id || obj.model || obj.activeModel ||
    obj.session?.modelID || obj.session?.model || obj.info?.modelID || obj.info?.model,
  );
}

function readRecentOpencodeModel() {
  try {
    const parsed = JSON.parse(readFileSync(join(opencodeStateDir(), "model.json"), "utf8"));
    const recent = Array.isArray(parsed?.recent) ? parsed.recent[0] : null;
    return modelFromObject(recent) || modelFromObject(parsed);
  } catch {
    return null;
  }
}

function sqlString(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function readOpencodeDbValue(sql) {
  try {
    const out = execFileSync("sqlite3", [
      "-readonly",
      "-cmd", ".timeout 200",
      join(opencodeDataDir(), "opencode.db"),
      sql,
    ], { encoding: "utf8", timeout: 500, stdio: ["ignore", "pipe", "ignore"] });
    return normalizeModelValue(out.split("\n")[0]);
  } catch {
    return null;
  }
}

function readOpencodeModel(sessionID = "") {
  if (sessionID) {
    const sid = sqlString(sessionID);
    const messageModel = readOpencodeDbValue(`SELECT json_extract(data, '$.modelID') FROM message WHERE session_id = ${sid} ORDER BY time_created DESC LIMIT 1`);
    if (messageModel) return messageModel;
    const sessionModel = readOpencodeDbValue(`SELECT model FROM session WHERE id = ${sid}`);
    if (sessionModel) return sessionModel;
  }
  return readRecentOpencodeModel();
}

function logLine(context, detail) {
  try { mkdirSync(LOG_DIR, { recursive: true }); } catch { return; }
  if (context === "init") {
    try {
      if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > MAX_LOG_BYTES) {
        rmSync(`${LOG_FILE}.1`, { force: true });
        renameSync(LOG_FILE, `${LOG_FILE}.1`);
      }
    } catch { /* rotation must not suppress the marker */ }
  }
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} [${context}] ${String(detail)}\n`);
  } catch {
    // last resort: swallow — the shim must never throw.
  }
}

function logErr(context, detail) {
  logLine(context, detail && detail.stack ? detail.stack : String(detail));
}

// The compatibility shim keeps its old fail-open registry behavior, but when a
// typed control-plane identity is explicitly configured it also submits the
// same native event through the canonical runtime ingress. The dynamic import
// is intentional: an older rendered shim must continue to load if a package
// update has not yet supplied the typed adapter.
async function createCanonicalRuntime(client) {
  const projectId = process.env.GOLEM_RUNTIME_PROJECT_ID;
  const origin = process.env.GOLEM_CONTROL_PLANE_URL;
  const token = process.env.GOLEM_CONTROL_PLANE_TOKEN;
  if (!projectId || !origin || !token) return null;
  try {
    const typed = await import("@golem/adapter-opencode");
    const runtime = new typed.OpenCodeCompatibilityRuntime({
      projectId,
      producerInstanceId: `prod_${randomUUID()}`,
      producer: "opencode-shim",
      ingress: typed.createOpenCodeControlPlaneIngress({ origin, token }),
    });
    return {
      consume: (event) => runtime.consume(event),
      deliver: ({ sessionID, deliveryId, text, fence }) => runtime.deliver({
        rawSessionId: sessionID,
        request: { deliveryId, text, fence },
        port: typed.openCodeSdkPromptPort(client),
      }),
      fence: typed.openCodeFence,
    };
  } catch {
    logLine("canonical runtime", "adapter unavailable or runtime ingress not configured");
    return null;
  }
}

function withFileLock(lockPath, fn) {
  try { mkdirSync(dirname(lockPath), { recursive: true }); } catch { /* ignore */ }
  for (let i = 0; i < 50; i++) {
    try {
      mkdirSync(lockPath);
      try { return fn(); }
      finally { try { rmdirSync(lockPath); } catch { /* ignore */ } }
    } catch (err) {
      if (err?.code === "EEXIST") {
        const wait = Date.now() + 20;
        while (Date.now() < wait) { /* brief spin */ }
        continue;
      }
      throw err;
    }
  }
  throw new Error(`failed to acquire ${lockPath}`);
}

function readJson(file, key) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (Array.isArray(parsed?.[key])) return parsed;
  } catch { /* ignore */ }
  return { version: 1, [key]: [] };
}

function writeJson(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, file);
}

function registerBridge({ sessionID, cwd, status, port, name, model }) {
  if (!sessionID || !port) return false;
  try {
    const now = new Date().toISOString();
    withFileLock(BRIDGES_LOCK, () => {
      const reg = readJson(BRIDGES_REGISTRY, "bridges");
      reg.bridges = reg.bridges.filter((b) => b.session_id !== sessionID);
      reg.bridges.push({
        session_id: sessionID,
        opencode_pid: process.pid,
        pid: process.pid,
        host: HOST,
        port,
        version: VERSION,
        harness: "opencode",
        cwd: cwd || null,
        name: name || null,
        status: status || null,
        model: model || null,
        started_at: now,
        updated_at: now,
      });
      writeJson(BRIDGES_REGISTRY, reg);
    });
    logLine("registered", `${sessionID} port=${port}`);
    publishCanonical(sessionID, { cwd, status, name, model, port });
    return true;
  } catch (e) {
    logErr("bridge register", e);
    return false;
  }
}

// opencode's SessionStatus is an OBJECT ({type:"idle"|"retry"|"busy"}), but the
// dashboard compares plain strings (status === 'busy' drives the working gear).
// Collapse to the string; "retry" is still mid-work → busy.
function statusString(status) {
  const t = typeof status === "string" ? status : status?.type;
  if (!t) return null;
  return t === "retry" ? "busy" : t;
}

function sessionUpdatedAt(info) {
  const t = Number(info?.time?.updated ?? info?.time?.created ?? 0);
  return Number.isFinite(t) ? t : 0;
}

function topLevelSession(info) {
  return info && info.id && !info.parentID;
}

function updateBridge({ sessionID, cwd, status, port, name, model, insert = true }) {
  if (!sessionID || !port) return false;
  try {
    const now = new Date().toISOString();
    withFileLock(BRIDGES_LOCK, () => {
      const reg = readJson(BRIDGES_REGISTRY, "bridges");
      let found = false;
      reg.bridges = reg.bridges.map((b) => {
        if (b.opencode_pid !== process.pid || b.session_id !== sessionID) return b;
        found = true;
        return { ...b, cwd: cwd || b.cwd || null, name: name || b.name || null, status: status || b.status || null, model: model || b.model || null, updated_at: now };
      });
      if (!found) {
        if (!insert) return; // child/unknown session — never create a phantom endpoint
        reg.bridges = reg.bridges.filter((b) => b.session_id !== sessionID);
        reg.bridges.push({
          session_id: sessionID,
          opencode_pid: process.pid,
          pid: process.pid,
          host: HOST,
          port,
          version: VERSION,
          harness: "opencode",
          cwd: cwd || null,
          name: name || null,
          status: status || null,
          model: model || null,
          started_at: now,
          updated_at: now,
        });
      }
      writeJson(BRIDGES_REGISTRY, reg);
    });
    publishCanonical(sessionID, { cwd, status, name, model, port });
    return true;
  } catch (e) {
    logErr("bridge update", e);
    return false;
  }
}

function unregisterBridges() {
  try {
    withFileLock(BRIDGES_LOCK, () => {
      const reg = readJson(BRIDGES_REGISTRY, "bridges");
      const before = reg.bridges.length;
      reg.bridges = reg.bridges.filter((b) => b.opencode_pid !== process.pid);
      if (reg.bridges.length !== before) writeJson(BRIDGES_REGISTRY, reg);
    });
  } catch (e) {
    logErr("bridge unregister", e);
  }
}

function publishCanonical(sessionID, { cwd, status, name, model, port }) {
  upsertSessionFact({
    canonical_id: sessionID,
    harness: "opencode",
    locator: { raw_session_id: sessionID },
    continuation_key: sessionID,
    project_path: cwd || null,
    name: name || null,
    status: status || null,
    model: model || null,
  });
}

function unregisterBridge(sessionID) {
  if (!sessionID) return;
  try {
    withFileLock(BRIDGES_LOCK, () => {
      const reg = readJson(BRIDGES_REGISTRY, "bridges");
      const before = reg.bridges.length;
      reg.bridges = reg.bridges.filter((b) => !(b.opencode_pid === process.pid && b.session_id === sessionID));
      if (reg.bridges.length !== before) writeJson(BRIDGES_REGISTRY, reg);
    });
  } catch (e) {
    logErr("bridge unregister session", e);
  }
}

function pruneSessionRows(rows, nowMs = Date.now()) {
  const retained = rows.filter((s) => {
    const endedAt = Date.parse(s.ended_at || "");
    return !Number.isFinite(endedAt) || nowMs - endedAt < ENDED_SESSION_RETENTION_MS;
  });
  if (retained.length <= MAX_SESSION_REGISTRY_ROWS) return retained;
  return retained
    .slice()
    .sort((a, b) => Date.parse(b.last_seen_at || b.boot_time || b.ended_at || 0) - Date.parse(a.last_seen_at || a.boot_time || a.ended_at || 0))
    .slice(0, MAX_SESSION_REGISTRY_ROWS);
}

function updateSessionRegistry({ sessionID, cwd, status, name, model, insert = true, touchLastSeen = true }) {
  if (!sessionID) return false;
  try {
    const now = new Date().toISOString();
    withFileLock(SESSIONS_LOCK, () => {
      const reg = readJson(SESSIONS_REGISTRY, "sessions");
      let found = false;
      reg.sessions = reg.sessions.map((s) => {
        if (s.session_id !== sessionID) return s;
        found = true;
        return {
          ...s,
          project_path: cwd || s.project_path,
          harness: "opencode",
          status: status || s.status || null,
          name: name || s.name || null,
          model: model || s.model || null,
          ended_at: null,
          last_seen_at: touchLastSeen ? now : s.last_seen_at,
        };
      });
      if (!found) {
        if (!insert) return; // child/unknown session — don't fabricate a registry row
        reg.sessions.push({
          session_id: sessionID,
          hook_ppid: process.pid,
          project_path: cwd || null,
          harness: "opencode",
          status: status || null,
          name: name || null,
          model: model || null,
          boot_time: now,
          last_seen_at: now,
          ended_at: null,
        });
      }
      reg.sessions = pruneSessionRows(reg.sessions);
      writeJson(SESSIONS_REGISTRY, reg);
    });
    return true;
  } catch (e) {
    logErr("session registry update", e);
    return false;
  }
}

function markSessionRegistryEnded(sessionIDs) {
  const ids = new Set((Array.isArray(sessionIDs) ? sessionIDs : [sessionIDs]).filter(Boolean));
  if (!ids.size) return;
  try {
    const now = new Date().toISOString();
    withFileLock(SESSIONS_LOCK, () => {
      const reg = readJson(SESSIONS_REGISTRY, "sessions");
      let changed = false;
      reg.sessions = reg.sessions.map((s) => {
        if (!ids.has(s.session_id)) return s;
        changed = true;
        return { ...s, harness: "opencode", status: "dead", ended_at: now };
      });
      reg.sessions = pruneSessionRows(reg.sessions);
      if (changed) writeJson(SESSIONS_REGISTRY, reg);
    });
  } catch (e) {
    logErr("session registry end", e);
  }
}

function markOwnedSessionRegistryEndedSync() {
  try {
    let ids = [];
    withFileLock(BRIDGES_LOCK, () => {
      const reg = readJson(BRIDGES_REGISTRY, "bridges");
      ids = reg.bridges.filter((b) => b.opencode_pid === process.pid).map((b) => b.session_id).filter(Boolean);
    });
    markSessionRegistryEnded(ids);
  } catch (e) {
    logErr("session registry owned end", e);
  }
}

function xmlAttr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function channelTag(kind, content, meta = {}) {
  const attrs = { source: "golem", kind, ...meta };
  const attrText = Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== null && String(v) !== "")
    .map(([k, v]) => `${k}="${xmlAttr(v)}"`)
    .join(" ");
  return `<channel ${attrText}>\n${String(content || "")}\n</channel>`;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function dashboardBaseUrl() {
  if (process.env.GOLEM_DASHBOARD_URL) return process.env.GOLEM_DASHBOARD_URL.replace(/\/+$/, "");
  try {
    const doc = JSON.parse(readFileSync(join(golemHome(), "dashboard.json"), "utf8"));
    if (typeof doc?.url === "string" && doc.url.trim()) return doc.url.replace(/\/+$/, "");
    if (doc?.host && doc?.port) return `http://${doc.host}:${doc.port}`;
  } catch { /* dashboard not ready — fail open below */ }
  return null;
}

async function passiveDeltaRequest(sessionID, action, body = null) {
  if (!sessionID) return null;
  const baseUrl = dashboardBaseUrl();
  if (!baseUrl) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 600);
  try {
    const response = await fetch(`${baseUrl}/api/passive-deltas/${encodeURIComponent(sessionID)}/${action}`, {
      method: "POST",
      headers: {
        "X-Golem-Caller-Session": sessionID,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// GOL-424: chat.message is OpenCode's mutation seam for an already-submitted
// real user message. This intentionally never calls session.prompt/noReply;
// only the existing message gains the durable next-turn context.
async function appendPassiveDeltaToMessage(sessionID, output) {
  const claim = await passiveDeltaRequest(sessionID, "claim");
  const leaseID = claim?.lease_id;
  const text = claim?.batch?.body;
  if (!leaseID || !text) return;
  let committed = false;
  try {
    if (!Array.isArray(output?.parts)) return;
    output.parts.push({ type: "text", text });
    // The mutation above is synchronous; commit only after the exact part has
    // entered OpenCode's outgoing message serialization object.
    committed = Boolean((await passiveDeltaRequest(sessionID, "commit", { lease_id: leaseID }))?.committed);
  } finally {
    if (!committed) await passiveDeltaRequest(sessionID, "release", { lease_id: leaseID });
  }
}

function startBridge({ client, dirFor, logErr, canonical }) {
  let port = null;
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/healthz") {
        return sendJson(res, 200, { ok: true, harness: "opencode", version: VERSION });
      }
      if (req.method !== "POST" || req.url !== "/push") {
        return sendJson(res, 404, { ok: false, error: "not found" });
      }
      const raw = await readBody(req);
      let payload = {};
      try { payload = JSON.parse(raw || "{}"); } catch { payload = {}; }
      const kind = String(payload.kind || payload.meta?.kind || "brief");
      const content = String(payload.content || "");
      const meta = payload.meta && typeof payload.meta === "object" ? payload.meta : { kind };
      const sessionID = String(payload.session_id || meta.session_id || currentSessionID || "");
      if (!sessionID) return sendJson(res, 409, { ok: false, error: "no active opencode session" });

      // New durable delivery enters with the canonical generation/fence
      // snapshot. The adapter rechecks that snapshot immediately before the
      // SDK boundary; old channel callers without the snapshot retain their
      // compatibility path below.
      const fence = canonical?.fence(payload.fence || meta.fence);
      if (canonical && fence) {
        const deliveryId = String(payload.delivery_id || payload.id || meta.delivery_id || "");
        if (!deliveryId) return sendJson(res, 400, { ok: false, error: "delivery id is required" });
        const result = await canonical.deliver({
          sessionID,
          deliveryId,
          text: channelTag(kind, content, meta),
          fence,
        });
        if (result.status === "accepted") {
          const model = readOpencodeModel(sessionID);
          updateSessionRegistry({ sessionID, cwd: dirFor(sessionID), status: "busy", model });
          if (port) updateBridge({ sessionID, cwd: dirFor(sessionID), status: "busy", port, model });
          return sendJson(res, 202, { ok: true, kind, session_id: sessionID });
        }
        return sendJson(res, result.status === "retry" ? 503 : 409, {
          ok: false,
          error: result.code,
        });
      }

      const text = channelTag(kind, content, meta);
      // OpenCode SDK v1.17.18 defines promptAsync as POST /prompt_async with a
      // 204 "Prompt accepted" response; prompt instead waits on /message for a
      // created assistant result. This bridge needs the former acceptance fact,
      // not a fire-and-forget request or a completed model turn.
      if (typeof client?.session?.promptAsync !== "function") throw new Error("OpenCode session.promptAsync is unavailable");
      const accepted = await client.session.promptAsync({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text }] },
        throwOnError: true,
      });
      if (accepted?.error || accepted?.response?.ok === false) throw new Error("OpenCode rejected actionable prompt");
      const model = readOpencodeModel(sessionID);
      updateSessionRegistry({ sessionID, cwd: dirFor(sessionID), status: "busy", model });
      if (port) updateBridge({ sessionID, cwd: dirFor(sessionID), status: "busy", port, model });
      return sendJson(res, 202, { ok: true, kind, session_id: sessionID });
    } catch (e) {
      logErr("bridge request", e);
      return sendJson(res, 500, { ok: false, error: String(e?.message || e) });
    }
  });
  server.on("error", (e) => logErr("bridge server", e));
  server.listen(0, HOST, () => {
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : null;
  });
  server.unref();
  process.once("exit", () => {
    markOwnedSessionRegistryEndedSync();
    unregisterBridges();
  });
  return {
    port: () => port,
    close: () => {
      try { server.close(); } catch { /* cleanup only */ }
    },
  };
}

// Fire-and-forget: spawn a hook script, write CC-shaped stdin, DO NOT await.
// Errors and non-zero exits are logged, never surfaced to opencode.
function runHook(script, args, stdinObj) {
  try {
    const child = spawn("bash", [join(HOOKS_DIR, script), ...args], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    child.on("error", (e) => logErr(`spawn ${script}`, e));
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => {
      if (code !== 0) logErr(`${script} exit ${code}`, stderr.trim() || "(no stderr)");
    });
    child.stdin.on("error", (e) => logErr(`stdin ${script}`, e));
    child.stdin.end(JSON.stringify(stdinObj));
  } catch (e) {
    logErr(`runHook ${script}`, e);
  }
}

// Run tracker-context.sh and extract its additionalContext string. When a
// session id is known, pass it both as --session and CC-shaped stdin so the
// shared hook can append the role card for that session.
function loadTrackerContext(sessionID = "", cwd = initCwdFallback()) {
  try {
    const args = [join(HOOKS_DIR, "tracker-context.sh")];
    if (sessionID) args.push("--session", sessionID);
    const out = execFileSync("bash", args, {
      encoding: "utf8",
      timeout: 3000,
      input: JSON.stringify({ session_id: sessionID || "", cwd: cwd || initCwdFallback(), harness: "opencode" }),
      stdio: ["pipe", "pipe", "ignore"], // capture stdout only; never leak a broken script's stderr into the harness
    });
    const parsed = JSON.parse(out);
    return parsed?.hookSpecificOutput?.additionalContext || null;
  } catch (e) {
    logErr("tracker-context", e);
    return null;
  }
}

let initialCwdForContext = process.cwd();
function initCwdFallback() { return initialCwdForContext; }

export default async (input) => {
  logLine("init", `pid=${process.pid} dir=${input?.directory || process.cwd()} hooks=${HOOKS_DIR} v=${VERSION}`);
  const initCwd = input?.directory || process.cwd();
  initialCwdForContext = initCwd;
  const sessionDir = new Map(); // sessionID → directory (tool events carry no dir)
  const parentOf = new Map(); // child sessionID → immediate parent sessionID
  const knownSessionIDs = new Set();
  const cancelledSessionIDs = new Set();
  const trackerContextCache = new Map();
  let disposed = false;

  const canonical = await createCanonicalRuntime(input?.client);
  const publishCanonicalEvent = (event) => {
    if (!canonical) return;
    void canonical.consume(event).catch(() => {
      // Do not expose transport/token/request diagnostics to the native host.
      logLine("canonical runtime", "runtime event was not accepted");
    });
  };

  const trackerContextFor = (sessionID, cwd) => {
    const key = sessionID || "__base__";
    if (!trackerContextCache.has(key)) trackerContextCache.set(key, loadTrackerContext(sessionID || "", cwd || dirFor(sessionID)));
    return trackerContextCache.get(key);
  };

  const dirFor = (sid) => sessionDir.get(sid) || initCwd;
  const topLevelOf = (sessionID) => {
    if (!sessionID) return null;
    let current = sessionID;
    const seen = new Set();
    while (parentOf.has(current)) {
      if (seen.has(current)) return null;
      seen.add(current);
      current = parentOf.get(current);
      if (!current) return null;
    }
    return knownSessionIDs.has(current) ? current : null;
  };
  const base = (sessionID, cwd, extra = {}) => ({ session_id: sessionID || "", cwd: cwd || initCwd, harness: "opencode", model: readOpencodeModel(sessionID), ...extra });
  const bridge = startBridge({ client: input?.client, dirFor, logErr, canonical });
  // Child/subagent ids never enter knownSessionIDs, so recurring events can
  // self-heal owned top-level rows without fabricating phantom endpoints.
  const publishBridge = (sessionID, status = null, name = null, { insert = false, touchLastSeen = true } = {}) => {
    const port = bridge.port();
    if (!sessionID || !port) return false;
    const st = statusString(status);
    const model = readOpencodeModel(sessionID);
    const canInsert = insert || knownSessionIDs.has(sessionID);
    const bridgeUpdated = updateBridge({ sessionID, cwd: dirFor(sessionID), status: st, port, name, model, insert: canInsert });
    const sessionUpdated = updateSessionRegistry({ sessionID, cwd: dirFor(sessionID), status: st, name, model, insert: canInsert, touchLastSeen });
    return bridgeUpdated && sessionUpdated;
  };
  const registerWhenBridgeReady = (fn, label, attempt = 0) => {
    let registered = false;
    try {
      registered = fn() === true;
    } catch (e) {
      logErr(`bridge ready ${label}`, e);
    }
    if (registered) return;
    if (attempt >= 20) {
      logErr("bridge ready", `gave up ${label} after ${attempt + 1} attempts`);
      return;
    }
    setTimeout(() => registerWhenBridgeReady(fn, label, attempt + 1), 100).unref?.();
  };
  const rememberSession = (info, status = null) => {
    if (!topLevelSession(info)) return false;
    if (cancelledSessionIDs.has(info.id)) return true;
    if (info.directory) sessionDir.set(info.id, info.directory);
    knownSessionIDs.add(info.id);
    currentSessionID = info.id || currentSessionID;
    return publishBridge(info.id, status || info.status || "idle", info.title || info.name || null, { insert: true });
  };
  const seedResumedSessions = async () => {
    try {
      const callSession = (method, args) => {
        const fn = input?.client?.session?.[method];
        return typeof fn === "function" ? fn.call(input.client.session, args).catch(() => null) : Promise.resolve(null);
      };
      const [listed, statuses] = await Promise.all([
        callSession("list", { query: { directory: initCwd } }),
        callSession("status", { query: { directory: initCwd } }),
      ]);
      const sessions = Array.isArray(listed?.data) ? listed.data : [];
      const statusById = statuses?.data && typeof statuses.data === "object" ? statuses.data : {};
      const activeIds = new Set(Object.keys(statusById));
      const candidates = sessions
        .filter(topLevelSession)
        .filter((s) => activeIds.has(s.id))
        .sort((a, b) => sessionUpdatedAt(b) - sessionUpdatedAt(a));
      const fallback = sessions
        .filter(topLevelSession)
        .sort((a, b) => sessionUpdatedAt(b) - sessionUpdatedAt(a))
        .slice(0, 1)
        .filter((s) => Date.now() - sessionUpdatedAt(s) <= RESUME_FALLBACK_MAX_AGE_MS);
      const seeded = activeIds.size > 0 ? candidates : fallback;
      const register = () => {
        if (disposed) return true;
        if (!bridge.port()) return false;
        return seeded.every((info) => rememberSession(info, statusById[info.id] || "idle"));
      };
      registerWhenBridgeReady(register, "resume seed");
    } catch (e) {
      logErr("resume seed", e);
    }
  };
  seedResumedSessions();

  const endSession = (sessionID, cwd) => {
    if (!sessionID) return;
    cancelledSessionIDs.add(sessionID);
    knownSessionIDs.delete(sessionID);
    if (currentSessionID === sessionID) currentSessionID = "";
    markSessionRegistryEnded(sessionID);
    unregisterBridge(sessionID);
    runHook("journal-route.sh", ["session-end"], base(sessionID, cwd || dirFor(sessionID)));
  };

  return {
    event: async ({ event }) => {
      try {
        const t = event?.type;
        const p = event?.properties || {};
        publishCanonicalEvent({ type: t || "", properties: p });
        if (t === "session.created") {
          const info = p.info || {};
          if (info.parentID) {
            parentOf.set(info.id, info.parentID);
            return; // child/subagent session — journaled via the task tool, not as a top-level start
          }
          cancelledSessionIDs.delete(info.id);
          logLine("session.created", `session=${info.id || ""}`);
          if (info.directory) sessionDir.set(info.id, info.directory);
          knownSessionIDs.add(info.id);
          currentSessionID = info.id || currentSessionID;
          if (info.id) trackerContextCache.delete(info.id);
          const stdin = base(info.id, info.directory, modelFromObject(info) ? { model: modelFromObject(info) } : {});
          runHook("session-register.sh", [], stdin);
          runHook("journal-route.sh", ["session-start"], stdin);
          const status = info.status || "idle";
          const name = info.title || info.name || null;
          const register = () => {
            if (disposed || !knownSessionIDs.has(info.id)) return true;
            const port = bridge.port();
            if (!port) return false;
            const model = modelFromObject(info) || readOpencodeModel(info.id);
            const registered = registerBridge({ sessionID: info.id, cwd: info.directory || dirFor(info.id), status, port, name, model });
            const sessionRegistered = updateSessionRegistry({ sessionID: info.id, cwd: info.directory || dirFor(info.id), status, name, model });
            return registered && sessionRegistered;
          };
          registerWhenBridgeReady(register, `session ${info.id || "unknown"}`);
        } else if (t === "session.idle") {
          currentSessionID = p.sessionID || currentSessionID;
          publishBridge(p.sessionID, "idle");
          runHook("journal-route.sh", ["stop"], base(p.sessionID, dirFor(p.sessionID)));
        } else if (t === "session.status") {
          // properties = { sessionID, status: {type:"idle"|"retry"|"busy"} } —
          // no info object; statusString (in publishBridge) collapses the shape.
          const sid = p.sessionID || currentSessionID;
          currentSessionID = sid || currentSessionID;
          const st = statusString(p.status);
          publishBridge(sid, p.status, null, { touchLastSeen: st === "busy" });
        } else if (t === "session.resumed") {
          const sid = p.sessionID || p.info?.id || currentSessionID;
          currentSessionID = sid || currentSessionID;
          publishBridge(sid, "idle", p.info?.title || null, { insert: true, touchLastSeen: false });
        } else if (t === "session.updated") {
          // Carries the full Session — the ONLY place the real title shows up
          // (auto-generated after the first message, and on any rename). Keep
          // the registry name fresh so the dashboard shows names, not ses_* ids.
          const info = p.info || {};
          if (info.parentID) {
            parentOf.set(info.id, info.parentID);
            return; // child/subagent session
          }
          if (info.directory) sessionDir.set(info.id, info.directory);
          knownSessionIDs.add(info.id);
          currentSessionID = info.id || currentSessionID;
          publishBridge(info.id, null, info.title || null, { insert: true, touchLastSeen: false });
        } else if (t === "session.compacted") {
          runHook("journal-route.sh", ["pre-compact"], base(p.sessionID, dirFor(p.sessionID)));
        } else if (t === "session.deleted") {
          const info = p.info || {};
          if (info.parentID) parentOf.delete(info.id);
          else endSession(info.id, info.directory || dirFor(info.id));
        } else if (t === "server.instance.disposed") {
          disposed = true;
          const ended = [...knownSessionIDs];
          markSessionRegistryEnded(ended);
          unregisterBridges();
          bridge.close();
          knownSessionIDs.clear();
          currentSessionID = "";
        }
      } catch (e) {
        logErr("event", e);
      }
    },

    "chat.message": async (inp, out) => {
      try {
        currentSessionID = inp?.sessionID || currentSessionID;
        publishCanonicalEvent({ type: "chat.message", properties: { sessionID: inp?.sessionID } });
        await appendPassiveDeltaToMessage(inp?.sessionID, out);
        runHook("journal-route.sh", ["user-prompt"], base(inp?.sessionID, dirFor(inp?.sessionID)));
      } catch (e) {
        logErr("chat.message", e);
      }
    },

    "tool.execute.before": async (inp, out) => {
      try {
        currentSessionID = inp?.sessionID || currentSessionID;
        publishCanonicalEvent({ type: "tool.execute.before", properties: { sessionID: inp?.sessionID } });
        publishBridge(inp?.sessionID, "busy");
        if (isGolemToolName(inp?.tool)) {
          const callerSessionID = topLevelOf(inp?.sessionID);
          if (callerSessionID && out?.args && typeof out.args === "object" && !Array.isArray(out.args)) {
            // Local plugins can already act as the user. This trusted shim is
            // therefore authoritative for the per-call session it injects.
            out.args.__golem_session_id = callerSessionID;
            out.args.__golem_call_id = inp?.callID;
          } else {
            logLine("identity injection", `not injected tool=${inp?.tool || ""} session=${inp?.sessionID || ""}`);
          }
        }
        const kind = inp?.tool === "task" ? "agent-spawn" : "tool-pre";
        runHook("journal-route.sh", [kind], {
          ...base(inp?.sessionID, dirFor(inp?.sessionID)),
          tool_name: inp?.tool,
          tool_input: out?.args,
        });
      } catch (e) {
        logErr("tool.execute.before", e);
      }
    },

    "tool.execute.after": async (inp) => {
      try {
        currentSessionID = inp?.sessionID || currentSessionID;
        publishCanonicalEvent({ type: "tool.execute.after", properties: { sessionID: inp?.sessionID } });
        publishBridge(inp?.sessionID, null);
        const kind = inp?.tool === "task" ? "agent-return" : "tool-post";
        runHook("journal-route.sh", [kind], {
          ...base(inp?.sessionID, dirFor(inp?.sessionID)),
          tool_name: inp?.tool,
          tool_input: inp?.args,
        });
      } catch (e) {
        logErr("tool.execute.after", e);
      }
    },

    "experimental.chat.system.transform": async (inp, output) => {
      try {
        const sid = inp?.sessionID || inp?.session_id || inp?.session?.id || currentSessionID;
        if (sid) currentSessionID = sid;
        const trackerContext = trackerContextFor(sid, sid ? dirFor(sid) : initCwd);
        // Idempotent: opencode may init the plugin more than once per session,
        // so guard against injecting the same context twice.
        if (trackerContext && Array.isArray(output?.system)) {
          const baseContext = trackerContextFor("", initCwd);
          const alreadyHasBase = baseContext && output.system.includes(baseContext);
          const roleOnly = alreadyHasBase && trackerContext !== baseContext && trackerContext.startsWith(baseContext)
            ? trackerContext.slice(baseContext.length).trimStart()
            : null;
          const toInject = roleOnly || trackerContext;
          if (toInject && !output.system.includes(toInject) && !output.system.includes(trackerContext)) output.system.push(toInject);
        }
      } catch (e) {
        logErr("system.transform", e);
      }
    },
  };
};
