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
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
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

function logErr(context, detail) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const msg = detail && detail.stack ? detail.stack : String(detail);
    appendFileSync(LOG_FILE, `${new Date().toISOString()} [${context}] ${msg}\n`);
  } catch {
    // last resort: swallow — the shim must never throw.
  }
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

// Run tracker-context.sh once and extract its additionalContext string (R2).
// Synchronous, at plugin init only; failures degrade to no injection.
function loadTrackerContext() {
  try {
    const out = execFileSync("bash", [join(HOOKS_DIR, "tracker-context.sh")], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"], // capture stdout only; never leak a broken script's stderr into the harness
    });
    const parsed = JSON.parse(out);
    return parsed?.hookSpecificOutput?.additionalContext || null;
  } catch (e) {
    logErr("tracker-context", e);
    return null;
  }
}

export default async (input) => {
  const initCwd = input?.directory || process.cwd();
  const sessionDir = new Map(); // sessionID → directory (tool events carry no dir)
  const trackerContext = loadTrackerContext();

  const dirFor = (sid) => sessionDir.get(sid) || initCwd;
  const base = (sessionID, cwd) => ({ session_id: sessionID || "", cwd: cwd || initCwd, harness: "opencode" });

  return {
    event: async ({ event }) => {
      try {
        const t = event?.type;
        const p = event?.properties || {};
        if (t === "session.created") {
          const info = p.info || {};
          if (info.parentID) return; // child/subagent session — journaled via the task tool, not as a top-level start
          if (info.directory) sessionDir.set(info.id, info.directory);
          const stdin = base(info.id, info.directory);
          runHook("session-register.sh", [], stdin);
          runHook("journal-route.sh", ["session-start"], stdin);
        } else if (t === "session.idle") {
          runHook("journal-route.sh", ["stop"], base(p.sessionID, dirFor(p.sessionID)));
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
        runHook("journal-route.sh", ["user-prompt"], base(inp?.sessionID, dirFor(inp?.sessionID)));
      } catch (e) {
        logErr("chat.message", e);
      }
    },

    "tool.execute.before": async (inp, out) => {
      try {
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

    "experimental.chat.system.transform": async (_inp, output) => {
      try {
        // Idempotent: opencode may init the plugin more than once per session,
        // so guard against injecting the same context twice.
        if (trackerContext && Array.isArray(output?.system) && !output.system.includes(trackerContext)) {
          output.system.push(trackerContext);
        }
      } catch (e) {
        logErr("system.transform", e);
      }
    },
  };
};
