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
//   session.deleted (parentID null)   → journal session-end  (does not fire on
//                                        normal exit — best-effort, degrades)
//   experimental.chat.system.transform→ append tracker-context.sh text to system[]
//
// RESILIENCE (non-negotiable, ADR-7): this must NEVER stall or crash an
// opencode session. Every shell-out is fire-and-forget (spawned, stdin written,
// not awaited); every failure is caught and logged to
// ~/.golem/logs/opencode-shim.log; no hook throws back into the harness.

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, rmdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import os from "node:os";

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
const SESSION_HEARTBEAT_MS = 30_000;
let currentSessionID = "";

function logErr(context, detail) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const msg = detail && detail.stack ? detail.stack : String(detail);
    appendFileSync(LOG_FILE, `${new Date().toISOString()} [${context}] ${msg}\n`);
  } catch {
    // last resort: swallow — the shim must never throw.
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

function registerBridge({ sessionID, cwd, status, port, name }) {
  if (!sessionID || !port) return;
  const now = new Date().toISOString();
  withFileLock(BRIDGES_LOCK, () => {
    const reg = readJson(BRIDGES_REGISTRY, "bridges");
    reg.bridges = reg.bridges.filter((b) => b.opencode_pid !== process.pid && b.session_id !== sessionID);
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
      started_at: now,
      updated_at: now,
    });
    writeJson(BRIDGES_REGISTRY, reg);
  });
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

function updateBridge({ sessionID, cwd, status, port, name, insert = true }) {
  if (!sessionID || !port) return;
  const now = new Date().toISOString();
  withFileLock(BRIDGES_LOCK, () => {
    const reg = readJson(BRIDGES_REGISTRY, "bridges");
    let found = false;
    reg.bridges = reg.bridges.map((b) => {
      if (b.opencode_pid !== process.pid || b.session_id !== sessionID) return b;
      found = true;
      return { ...b, cwd: cwd || b.cwd || null, name: name || b.name || null, status: status || b.status || null, updated_at: now };
    });
    if (!found) {
      if (!insert) return; // child/unknown session — never create a phantom endpoint
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
        started_at: now,
        updated_at: now,
      });
    }
    writeJson(BRIDGES_REGISTRY, reg);
  });
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

function updateSessionRegistry({ sessionID, cwd, status, name, insert = true }) {
  if (!sessionID) return;
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
          last_seen_at: now,
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
          boot_time: now,
          last_seen_at: now,
        });
      }
      writeJson(SESSIONS_REGISTRY, reg);
    });
  } catch (e) {
    logErr("session registry update", e);
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

function startBridge({ client, dirFor, logErr }) {
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

      const text = channelTag(kind, content, meta);
      client.session.prompt({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text }] },
      }).catch((e) => logErr("bridge prompt", e));
      updateSessionRegistry({ sessionID, cwd: dirFor(sessionID), status: "busy" });
      if (port) updateBridge({ sessionID, cwd: dirFor(sessionID), status: "busy", port });
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
  process.once("exit", unregisterBridges);
  return { port: () => port };
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
  const initCwd = input?.directory || process.cwd();
  initialCwdForContext = initCwd;
  const sessionDir = new Map(); // sessionID → directory (tool events carry no dir)
  const knownSessionIDs = new Set();
  const trackerContextCache = new Map();

  const trackerContextFor = (sessionID, cwd) => {
    const key = sessionID || "__base__";
    if (!trackerContextCache.has(key)) trackerContextCache.set(key, loadTrackerContext(sessionID || "", cwd || dirFor(sessionID)));
    return trackerContextCache.get(key);
  };

  const dirFor = (sid) => sessionDir.get(sid) || initCwd;
  const base = (sessionID, cwd) => ({ session_id: sessionID || "", cwd: cwd || initCwd, harness: "opencode" });
  const bridge = startBridge({ client: input?.client, dirFor, logErr });
  // insert:false is the default so events from child/subagent sessions (whose
  // ids also flow through chat.message/tool.* hooks) can only UPDATE existing
  // rows, never create phantom sessions or dispatch endpoints. Only the
  // parentID-guarded session.created/session.updated paths insert.
  const publishBridge = (sessionID, status = null, name = null, { insert = false } = {}) => {
    const port = bridge.port();
    if (!sessionID || !port) return;
    const st = statusString(status);
    updateBridge({ sessionID, cwd: dirFor(sessionID), status: st, port, name, insert });
    updateSessionRegistry({ sessionID, cwd: dirFor(sessionID), status: st, name, insert });
  };
  const registerWhenBridgeReady = (fn, attempt = 0) => {
    if (fn()) return;
    if (attempt >= 20) return;
    setTimeout(() => registerWhenBridgeReady(fn, attempt + 1), 100).unref?.();
  };
  const rememberSession = (info, status = null) => {
    if (!topLevelSession(info)) return false;
    if (info.directory) sessionDir.set(info.id, info.directory);
    knownSessionIDs.add(info.id);
    currentSessionID = info.id || currentSessionID;
    publishBridge(info.id, status || info.status || "idle", info.title || info.name || null, { insert: true });
    return true;
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
        .filter((s) => activeIds.size === 0 || activeIds.has(s.id))
        .sort((a, b) => sessionUpdatedAt(b) - sessionUpdatedAt(a));
      const seeded = candidates.length ? candidates : sessions.filter(topLevelSession).sort((a, b) => sessionUpdatedAt(b) - sessionUpdatedAt(a)).slice(0, 1);
      const register = () => {
        if (!bridge.port()) return false;
        for (const info of seeded) rememberSession(info, statusById[info.id] || "idle");
        return true;
      };
      registerWhenBridgeReady(register);
    } catch (e) {
      logErr("resume seed", e);
    }
  };
  seedResumedSessions();
  const heartbeat = setInterval(() => {
    try {
      for (const sid of knownSessionIDs) publishBridge(sid);
      if (knownSessionIDs.size === 0 && currentSessionID) publishBridge(currentSessionID);
    } catch (e) {
      logErr("session heartbeat", e);
    }
  }, SESSION_HEARTBEAT_MS);
  heartbeat.unref?.();

  return {
    event: async ({ event }) => {
      try {
        const t = event?.type;
        const p = event?.properties || {};
        if (t === "session.created") {
          const info = p.info || {};
          if (info.parentID) return; // child/subagent session — journaled via the task tool, not as a top-level start
          if (info.directory) sessionDir.set(info.id, info.directory);
          knownSessionIDs.add(info.id);
          currentSessionID = info.id || currentSessionID;
          if (info.id) trackerContextCache.delete(info.id);
          const stdin = base(info.id, info.directory);
          runHook("session-register.sh", [], stdin);
          runHook("journal-route.sh", ["session-start"], stdin);
          const status = info.status || "idle";
          const name = info.title || info.name || null;
          const register = () => {
            const port = bridge.port();
            if (!port) return false;
            registerBridge({ sessionID: info.id, cwd: info.directory || dirFor(info.id), status, port, name });
            updateSessionRegistry({ sessionID: info.id, cwd: info.directory || dirFor(info.id), status, name });
            return true;
          };
          registerWhenBridgeReady(register);
        } else if (t === "session.idle") {
          currentSessionID = p.sessionID || currentSessionID;
          publishBridge(p.sessionID, "idle");
          runHook("journal-route.sh", ["stop"], base(p.sessionID, dirFor(p.sessionID)));
        } else if (t === "session.status") {
          // properties = { sessionID, status: {type:"idle"|"retry"|"busy"} } —
          // no info object; statusString (in publishBridge) collapses the shape.
          const sid = p.sessionID || currentSessionID;
          currentSessionID = sid || currentSessionID;
          publishBridge(sid, p.status);
        } else if (t === "session.updated") {
          // Carries the full Session — the ONLY place the real title shows up
          // (auto-generated after the first message, and on any rename). Keep
          // the registry name fresh so the dashboard shows names, not ses_* ids.
          const info = p.info || {};
          if (info.parentID) return; // child/subagent session
          if (info.directory) sessionDir.set(info.id, info.directory);
          knownSessionIDs.add(info.id);
          currentSessionID = info.id || currentSessionID;
          publishBridge(info.id, null, info.title || null, { insert: true });
        } else if (t === "session.compacted") {
          runHook("journal-route.sh", ["pre-compact"], base(p.sessionID, dirFor(p.sessionID)));
        } else if (t === "session.deleted") {
          const info = p.info || {};
          if (!info.parentID) runHook("journal-route.sh", ["session-end"], base(info.id, info.directory || dirFor(info.id)));
        }
      } catch (e) {
        logErr("event", e);
      }
    },

    "chat.message": async (inp) => {
      try {
        currentSessionID = inp?.sessionID || currentSessionID;
        publishBridge(inp?.sessionID, "busy");
        runHook("journal-route.sh", ["user-prompt"], base(inp?.sessionID, dirFor(inp?.sessionID)));
      } catch (e) {
        logErr("chat.message", e);
      }
    },

    "tool.execute.before": async (inp, out) => {
      try {
        currentSessionID = inp?.sessionID || currentSessionID;
        publishBridge(inp?.sessionID, "busy");
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
