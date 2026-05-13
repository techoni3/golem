# Golem · Design v2

> **Predecessor:** [`design_v1.md`](./design_v1.md) — read first for mission, philosophy, agent-roster taxonomy, persona patterns, skills catalog, ADR scaffolding, tracker layout. This v2 doc captures the substrate as it stands today; sections that are unchanged from v1 are referenced rather than restated.

This is the canonical state-of-the-substrate doc for v2. It describes what shipped on top of v1 and supersedes the earlier `v2_notes.md` stub.

---

## 1. What changed in v2

v1 delivered the conceptual substrate: personas, skills, hooks-as-discipline, tracker shape, the `/golem`-as-CEO main thread, the iterative-team and leaf-one-shot patterns. v2 made the substrate **observable, interactive, and multi-workspace**:

| Theme | v1 | v2 |
|---|---|---|
| Visibility into agent work | journal files, read by hand | live dashboard with per-project journals, agent cards, action streams |
| User ↔ CEO communication | terminal-only | MCP-backed channel server with `ack` / `respond` / SSE, plus terminal fallback |
| Gates and clarification | inline in chat | structured gate files + dashboard-driven approve/deny |
| Hook coverage | settings.json only (main-thread events) | per-agent frontmatter hooks (sub-agent tool calls, teammate idle/stop) |
| Workspace topology | one project at a time, implicit | named projects + `$GOLEM_ROOT` as a journaled CEO workspace |
| Team-spawn mechanics | informal `team_name=` convention | explicit `TeamCreate` → `Agent` × N → `TeamDelete` contract |

What is **not** different from v1:
- Persona contracts, the agent roster, the skills catalog.
- Tracker states (`triage / open / in-progress / review / blocked / done`) and ticket frontmatter.
- ADR / ARCH / CONTEXT / conventions / repo-map / agent-notes layout.
- The substrate-vs-application boundary (substrator never writes source code).

---

## 2. Workspace topology

v2 introduces two workspace kinds beyond a single project root:

```
~/Documents/software/experiments/                       ← $GOLEM_ROOT
├── CLAUDE.md                                           ← project-root marker for the CEO workspace
├── .claude/
│   ├── settings.json                                   ← journaling-only hooks (no lint/git-guardrails)
│   └── hooks/
│       ├── journal-event.sh                            ← writes journal/hook.jsonl in the resolved project root
│       └── journal-summarise.sh
├── journal/
│   ├── hook.jsonl                                      ← raw mechanical event stream (the CEO's own meta-activity)
│   └── summary.jsonl                                   ← golem-summarise-session output (read by the dashboard)
├── golem/                                              ← the substrate repo itself
│   ├── substrate/
│   │   ├── personas/    (golem-ceo.md)
│   │   ├── agents/      (per-persona Markdown files, loaded by Claude Code from ~/.claude/agents/ symlinks)
│   │   ├── skills/      (golem-handoff-protocol, golem-summarise-session, golem-gates, …)
│   │   ├── templates/project-bootstrap/                ← canonical seed for a new project's substrate harness
│   │   └── channels/golem/                             ← MCP channel server (Node, port 7421)
│   ├── dashboard/                                      ← Node + Fastify + WS backend, React-via-CDN frontend
│   └── project_management/design/                      ← this doc lives here
├── golem-projects/<name>/                              ← project workspace (substrate harness + source + journal)
└── golem-ideas/<name>/                                 ← ideation workspace (Scout / Prospector / Smelter scratch)
```

Three workspace kinds the dashboard understands:

1. **Root** (`kind: 'root'`) — `$GOLEM_ROOT` itself. Surfaces only when `.claude/hooks/journal-event.sh` is present. Carries a `journal/` directory and a `tracker/` (currently empty) — exists so the CEO's meta-activity (decisions taken at the root level, before `cd`ing into a project) is journalled.
2. **Project** (`kind: 'project'`) — anything under `golem-projects/<name>/`. Full substrate harness; gets a journal store + ticket scan.
3. **Idea** (`kind: 'idea'`) — anything under `golem-ideas/<name>/`. Lightweight; no tracker, no journal store, surfaced in the workspaces panel only.

The dashboard scans these directories on startup, watches them for changes via `chokidar`, and rediscovers every 30s. (External projects — those outside `golem-projects/` — are out of scope for v2 and addressed in v3.)

---

## 3. Hooks — the v2 model

This is the section most changed from v1, because hooks moved from "settings.json-only" to "per-agent frontmatter + settings.json layered".

### 3.1 Why hooks matter in v2

Hooks are no longer just guardrails (the v1 `git-guardrails.sh` / `lint-format.sh` patterns are unchanged). In v2 they are the substrate's **mechanical telemetry**: every tool call, send-message, agent-spawn / agent-return, user-prompt submission, session start / end, teammate idle, teammate stop, gate verdict, and notification fires a hook that appends a single line to `<project>/journal/hook.jsonl`. The dashboard consumes this file.

### 3.2 Where hooks live

Two layers, both honoured by Claude Code:

**Layer A — `settings.json`** at the session's project root (resolved by `$CLAUDE_PROJECT_DIR`). Fires for events in the main thread (the CEO's session) and, depending on the event, for sub-agents the main thread spawns. Used for session-start, session-end, user-prompt, pre-compact, notification, the CEO's own PreToolUse / PostToolUse, the `Agent` and `SendMessage` matchers, and `SubagentStop` (parent observing a child terminate).

The `$GOLEM_ROOT/.claude/settings.json` is journaling-only (no lint/git-guardrails — the CEO doesn't write source code). Project-level `golem-projects/<name>/.claude/settings.json` adds `git-guardrails.sh` (PreToolUse on Bash) and `lint-format.sh` (PostToolUse on Edit/Write) on top.

**Layer B — per-agent frontmatter `hooks:` block** in the agent's Markdown file (`golem/substrate/agents/golem-<persona>.md`). Fires for tool calls **made by that specific sub-agent**, regardless of which session spawned it. Used today on:

- `golem-substrator` — `PreToolUse`, `PostToolUse`, `Stop`.
- `golem-product-architect` — `PreToolUse`, `PostToolUse`, `Stop`, `TeammateIdle`.
- `golem-product-architecture-reviewer` — same as PA.

The remaining 15 personas (TA, TAR, Engineer, Code Reviewer, Test Spec / Test Writer, UX, Diagnoser, Documentarian, Cloud / Local DevOps, Scout, Prospector, Smelter, Meta) **do not yet have frontmatter hooks**. They are journalled only via the parent's settings.json layer (which captures `Agent`-spawn at PreToolUse and `agent-return` at PostToolUse on the parent's side, but **not** the sub-agent's own tool stream). Rolling out frontmatter to those personas is mechanical and pending.

### 3.3 The `journal-event.sh` hook script

One script handles every event type. Called as:

```bash
$CLAUDE_PROJECT_DIR/.claude/hooks/journal-event.sh <event_tag>
```

The `event_tag` is set per matcher in settings.json / frontmatter (`tool-pre`, `tool-post`, `agent-spawn`, `send-message`, `subagent-stop`, `teammate-idle`, `session-start`, …).

The script's only non-trivial logic is **resolving which project journal to write to**. It walks up from `$PWD` (the agent's effective cwd at hook-fire time, NOT `$CLAUDE_PROJECT_DIR`) looking for a `CLAUDE.md` or `.git` marker. Found → write `<that-root>/journal/hook.jsonl`. Not found → fall back to `$CLAUDE_PROJECT_DIR` (so stray cwds outside any project tree don't pollute random directories with a `journal/`).

This `$PWD`-based walk is load-bearing for v2: `CLAUDE_PROJECT_DIR` is inherited from the parent session unchanged for every sub-agent, so resolving by it would route every sub-agent's events to the CEO's root workspace regardless of which project they're actually working in.

Each line written is:

```json
{
  "ts":"2026-05-12T15:33:00Z",
  "event":"tool-post",            // our event_tag
  "session_id":"…",                // the agent's session_id at hook-fire time
  "cwd":"…",                       // $PWD at hook-fire time
  "payload":"<stringified-JSON-Claude-Code-passed-to-stdin>"
}
```

The interesting fields (`tool_name`, `tool_input`, `agent_id`, `agent_type`, `hook_event_name`, `transcript_path`, `permission_mode`, `subagent_type` on Agent calls, `to` / `message` on SendMessage) all live inside `payload` as a JSON-encoded string. The dashboard parses and flattens them in `normalizeEvent()`.

### 3.4 Event taxonomy (current)

| Event tag | Source | Hook event name (Claude Code) | Carries `agent_id`? | Semantics |
|---|---|---|---|---|
| `session-start`     | settings.json     | SessionStart           | no  | Session began at this project root |
| `session-end`       | settings.json     | SessionEnd             | depends | Session ended (terminal); for a sub-agent's own session, the agent's session_id is in the envelope |
| `user-prompt`       | settings.json     | UserPromptSubmit       | no  | User typed something to the CEO |
| `notification`      | settings.json     | Notification           | no  | Claude Code internal notification (e.g. permission prompt) |
| `pre-compact`       | settings.json     | PreCompact             | no  | Context compaction about to happen |
| `tool-pre`          | settings.json + frontmatter | PreToolUse  | yes (frontmatter) / no (settings) | A tool is about to run |
| `tool-post`         | settings.json + frontmatter | PostToolUse | yes (frontmatter) / no (settings) | A tool completed |
| `agent-spawn`       | settings.json (PreToolUse matcher: `Agent`) | PreToolUse | no | The parent is spawning a sub-agent; payload has `tool_input.subagent_type` / `name` / `team_name` |
| `agent-return`      | settings.json (PostToolUse matcher: `Agent`) | PostToolUse | no | A spawned sub-agent returned to the parent |
| `send-message`      | settings.json (PreToolUse matcher: `SendMessage`) | PreToolUse | no | Teammate sending intra-team message |
| `send-message-post` | settings.json (PostToolUse matcher: `SendMessage`) | PostToolUse | no | Send completed |
| `subagent-stop`     | settings.json + frontmatter (Stop) | SubagentStop (settings) / Stop (frontmatter) | yes (settings) / no (frontmatter) | **Terminal**: sub-agent shut down. Discriminate by `hook_event_name` (see §3.5) |
| `teammate-idle`     | frontmatter (TeammateIdle) | TeammateIdle | no | **Transient**: teammate is pausing between turns to wait on a SendMessage |
| `stop`              | settings.json     | Stop                   | no  | The main thread's model turn ended |

### 3.5 The Stop / SubagentStop / TeammateIdle distinction

Per the official docs ([agent-teams](https://code.claude.com/docs/en/agent-teams.md), [hooks](https://code.claude.com/docs/en/hooks.md)):

- A **leaf sub-agent** (Substrator, UX, Diagnoser, etc., spawned with no `team_name`) runs once and terminates. Its `Stop` hook fires once and is terminal. `Stop` auto-converts to `SubagentStop` for sub-agents at the parent layer.
- A **teammate** (PA, PAR, TA, TAR, dev-team members — spawned with `team_name`) persists across turns. It goes **idle** between turns waiting on a `SendMessage`. Claude Code fires a dedicated `TeammateIdle` hook on the idle transition; `Stop` / `SubagentStop` are reserved for actual termination.
- The same event_tag (`subagent-stop`) is fired by two distinct hook sources:
  - **Frontmatter `Stop`** (in the agent's own context) — `hook_event_name = "Stop"`, fires when the agent itself terminates.
  - **Parent's settings.json `SubagentStop`** — `hook_event_name = "SubagentStop"`, fires when the parent observes a child terminate.
  Both land in the same journal bucket; the dashboard discriminates via `hook_event_name` (see §5.3).

### 3.6 Routing matrix

| Scenario | Effective `$PWD` | Walk lands at | Journal written to |
|---|---|---|---|
| CEO at `$GOLEM_ROOT` doing meta-work | `$GOLEM_ROOT` | `$GOLEM_ROOT/CLAUDE.md` | `$GOLEM_ROOT/journal/hook.jsonl` |
| CEO `cd`'d into `golem-projects/factscroll/` | `golem-projects/factscroll/` | `factscroll/CLAUDE.md` | `factscroll/journal/hook.jsonl` |
| Sub-agent spawned in factscroll | inherits factscroll | `factscroll/CLAUDE.md` | `factscroll/journal/hook.jsonl` |
| Sub-agent that `cd`s to `/tmp` in a Bash call | `/tmp` (one-shot subshell — does not persist) | no marker found anywhere upstream | falls back to `$CLAUDE_PROJECT_DIR` (= `$GOLEM_ROOT`) — `$GOLEM_ROOT/journal/hook.jsonl` |

Sub-agent sessions do not carry `cd` across Bash invocations (per Claude Code's documented behaviour), so a sub-agent's effective `$PWD` is fixed at spawn time. The main-thread session's `cd` does persist, but that's intentional — when the CEO is working inside a project, its events should journal to that project.

---

## 4. The channel server (MCP)

Lives at `golem/substrate/channels/golem/` — a Node MCP server bound to `127.0.0.1:7421`. Auto-spawned by the CEO session via Claude Code's MCP wiring. Provides three things to the running CEO:

- **`ack` tool.** Fire-and-forget; immediately on receiving a channel-delivered message, the CEO calls `ack(kind, gate_id?, summary)` to send the user-visible "received, working on it" signal. Required when the inbound was a `<channel source="golem" …>` event. See the CEO persona's Step 1.5.
- **`respond` tool.** Sends a chat-style message back through the channel. Used for direct user-asked responses, clarification requests (paired with a written gate so the journey actually pauses), phase-completion summaries, and escalations. **Not** used to narrate intermediate tool calls — the dashboard already shows tool activity.
- **`notifications/claude/channel`** notification stream — outbound user → CEO messages flow this way, delivered by the channel server when the dashboard's chat drawer posts.

The dashboard subscribes to the channel server's SSE `/events` endpoint to render chat history in real time. Chat records are persisted server-side in `chat.js`, so reloading the dashboard restores the conversation.

The channel server is a single-instance singleton today (one CEO ↔ one channel). v3 extends it to project-scoped routing — see `v3_notes.md`.

---

## 5. The dashboard

A Node + Fastify backend with a React-via-CDN frontend; no build step. Lives at `golem/dashboard/`.

### 5.1 Backend layout

| File | Role |
|---|---|
| `server/index.js`           | Fastify entry — REST + WS + chat endpoints + static file serving with no-cache headers |
| `server/state.js`           | In-memory state owner; per-project journal stores; chokidar watching; debounced refreshes; event emitter that feeds WS broadcasts |
| `server/projects.js`        | Workspace discovery (`discoverRoot()` + `discoverProjects()` — root + projects + ideas, alphabetised within each group) |
| `server/journal.js`         | Parses `journal/hook.jsonl` + `summary.jsonl` into per-workspace agent records; the heart of the v2 dashboard |
| `server/tracker.js`         | Reads ticket markdown files out of `tracker/<state>/` |
| `server/orchestrator.js`    | Polls the CEO transcript (`~/.claude/projects/-…/<session_id>.jsonl`) for "still alive" / "headline memo" indicators; reads gate files |
| `server/chat.js`            | Persisted chat-history store; channel-side ingestion |
| `server/brief.js`           | POST `/api/brief`, `/api/halt`, `/api/interrupt`, `/api/gates/:id/:decision` — proxies to the channel server while atomically recording the user message in chat history (records BEFORE forwarding so a failed forward still appears in chat as `system/error`) |
| `server/roles.js`           | Maps `subagent_type` → role glyph (`ORC` / `PA` / `PR` / `TA` / `TR` / `ENG` / `CR` / `…`) |
| `server/config.js`, `util.js` | Constants, helpers |

The Fastify server uses `tryListen(startPort)` which auto-increments on `EADDRINUSE` up to `+20` ports. Default port 4173; the CLI prints the actual port. Static asset responses carry `Cache-Control: no-cache, no-store, must-revalidate` so JSX / CSS edits show up without hard-refresh during dev.

### 5.2 Frontend layout

React 18 from CDN + Babel-standalone in-browser transpile + `marked@14.1.4` for CEO message rendering. No bundler.

| File | Role |
|---|---|
| `web/src/app.jsx`              | Root — routes between the dashboard view, per-project view, agent detail, settings |
| `web/src/shell.jsx`            | Sidebar (workspace list + tweaks button) + topbar (CEO live indicator) |
| `web/src/dashboard.jsx`        | Aggregate view |
| `web/src/project-view.jsx`     | Per-project: agents tab, tickets tab, journal tab |
| `web/src/orchestrator.jsx`     | Top-level CEO panel (status, headline memo, awaiting-gate ribbon) |
| `web/src/drawer-ceo.jsx`       | Chat drawer (send brief, render acks-as-trace, render markdown CEO responses) |
| `web/src/drawer.jsx`           | Generic right-side drawer (agent detail, journal stream) |
| `web/src/tweaks.jsx`           | Accent-colour swatches; lives in the sidebar footer with a `⌘,` / `Ctrl+,` shortcut |
| `web/src/atoms.jsx`, `format.js`, `icons.jsx` | Reusable primitives |
| `web/src/store.js`             | Tiny event-store driven by WS deltas |
| `web/src/api.js`               | Fetch wrappers |

WS event taxonomy (from `state.js`): `project-update`, `agents-update`, `agent-detail`, `tickets-update`, `projects-list`, `orchestrator-update`.

### 5.3 Agent classification in `journal.js`

Each parsed event is normalised by `normalizeEvent()` which extracts from the inner payload: `tool_name`, `tool_input`, `tool_response`, `message`, `subagent_type` / `subagent_name` / `team_name` (from the parent's Agent spawn call), `send_to`, `agent_id`, `agent_type`, `hook_event_name`.

Agent records are keyed by:

- `agent:<agent_id>` when the event carries an `agent_id` (sub-agent firing from its own frontmatter, stamped by Claude Code with the agent's identity).
- `session:<session_id>` otherwise (CEO main thread + teammates firing from their own session_ids without `agent_id`).

This dual keying matters because sub-agent identity surfaces differently for leaves and teammates:

- **Leaf sub-agents** (substrator, etc.) share the parent's `session_id` but their events carry `agent_id`. They get an `agent:<id>` record.
- **Teammates** (PA, PAR, etc.) have their own `session_id` and don't carry `agent_id` on their tool events. They get a `session:<sid>` record.

Special discriminator for `subagent-stop` events:

- `hook_event_name == "SubagentStop"` AND `agent_id` present → the parent's settings.json observing a child terminate. Routed to the **parent's session record** (not the child's), so it doesn't spawn an empty ghost record per teammate-stop cycle. Logged as `Teammate <id> terminated`. Parent itself is NOT marked stopped.
- `hook_event_name == "Stop"` → the agent's own frontmatter firing. Terminal. Marks the routed record stopped.

Status classification (`classifyAgent()`):

- `tools_running > 0` → `running` (regardless of recency; long thinking phases don't fire hooks).
- `stopped == true` → `done`.
- `sinceLast < agentActiveWindowMs` → `active`.
- `sinceLast < agentIdleTimeoutMs` → `active` (still recent enough).
- Otherwise → `done`.

`teammate-idle` events set `a.action = "idle (waiting for message)"` and add a journal entry but do NOT set `stopped`. When the teammate wakes up on the next `SendMessage` and fires another tool, `last_seen` bumps and status flips back to `running` / `active`.

Spawn correlation: when the parent fires `agent-spawn`, a `pendingSpawn` record is queued (`subagent_type`, `subagent_name`, `team_name`, `spawn_ts`, `parent_session`). When a new agent record is created within `spawnCorrelationMs` of a pending spawn whose `subagent_type` matches the agent's `agent_type`, the spawn is claimed and used to enrich `name` / `team_name` / `parent_session`. For session-keyed records (teammates with their own session_id) the spawn correlation also supplies `subagent_type` itself.

The CEO main-thread record is labelled on its first agent-spawn fire: if a session_id record exists with no role / subagent_type, it's branded `subagent_type=golem-ceo`, `role=ORC`, `name=CEO`, `team_name=main`.

### 5.4 Gates and the orchestrator panel

`docs/agent-notes/gates/<gate-id>.md` files express clarification points the CEO needs from the user (write-stack-pick gate, deploy-confirm gate, etc.). They have YAML frontmatter (`status: awaiting | approved | denied | cancelled`, `phase`, `created_at`, optional `acted_at`).

The dashboard polls `gatesDir` per workspace (via chokidar), aggregates open gates, and surfaces them in the orchestrator panel. Approving via the dashboard hits `/api/gates/:id/:decision`, which atomically rewrites the gate file's `status` and posts a channel notification so the CEO sees it on the next turn.

`orchestrator.js` separately polls the CEO's Claude Code transcript for "still alive" markers and the latest "headline memo" — these are read-only (we don't watch `~/.claude/projects/` because sessions append constantly and chokidar would thrash).

---

## 6. Team-spawning contract

The mechanism the CEO uses to spin up an iterative loop (PA↔PAR, TA↔TAR, dev team). Codified in:

- `golem/substrate/personas/golem-ceo.md` — Critical rule "Team-spawning contract (NON-NEGOTIABLE)" + the B.2 / B.4 / §D examples.
- `golem/substrate/skills/golem-handoff-protocol/SKILL.md` — Step 1 (Option 2) and the Anti-patterns list.

Required sequence for any iterative loop:

```
TeamCreate(team_name: "specs-bringup", description: "PA ↔ PAR loop — product specs for <project>")
Agent(subagent_type: "golem-product-architect",            name: "pa",  team_name: "specs-bringup", …)
Agent(subagent_type: "golem-product-architecture-reviewer", name: "par", team_name: "specs-bringup", …)
```

After the team converges and teammates have shut down:

```
TeamDelete()
```

Why `TeamCreate` is mandatory: passing `team_name` on Agent calls does **not** auto-provision the team. The underlying team registry (`~/.claude/teams/<name>/config.json`) does not exist; the shared task-list directory (`~/.claude/tasks/<name>/`) does not exist; `SendMessage` between members routes nowhere; the loop stalls with both teammates idle. The fingerprint of this failure mode in the dashboard is two teammate cards that spawn and immediately go DONE with zero `send-message` events recorded.

Leaf one-shots **never** use `TeamCreate` and **never** pass `team_name`. Wrapping a one-shot in a team is also an anti-pattern.

Hard constraint Claude Code enforces (https://code.claude.com/docs/en/agent-teams#limitations): **a single session can manage only one active team at a time.** This is a load-bearing constraint that motivates v3's multi-CEO direction.

---

## 7. The CEO persona — what's new in v2

`golem/substrate/personas/golem-ceo.md` adds (on top of v1):

- **Step 1.5 — Channel reply contract.** When the inbound message is a `<channel source="golem" …>` event, the CEO must call `ack` immediately, before any reasoning. `respond` is for user-facing prose only — never to narrate tool calls.
- **Critical rule — Agent calls are synchronous.** `Agent(…)` blocks until the spawned work yields back. Forbids polling / `tail -f` / loop-watching for verdicts. After return, `Read` the relevant tracker / hand-off file.
- **Critical rule — Bash discipline.** No compound `cd && cmd` (Claude Code's hardcoded safety blocks them). No `tail -f` / `watch` / polling. No pipe chains for state extraction (`Read` instead). One mechanical thing per Bash call.
- **Critical rule — Team-spawning contract.** As described in §6.
- **Gate scan as Step 1.** List `docs/agent-notes/gates/*.md` and process unacted gates before treating the new user message as a fresh brief.

The `What you do NOT do` list and the §B / §C / §D / §E / §F / §G section structure are unchanged from v1.

---

## 8. Per-project substrate harness

Unchanged from v1 except for the journal-hook-script fix. A `golem-projects/<name>/` directory after substrator runs contains:

```
CLAUDE.md                           ← project entry-point (50–100 lines)
CONTEXT.md                          ← vocabulary, entities, invariants
README.md                           ← human-only stub
docs/
├── ARCH.md
├── adr/{0000-template.md, 0001-stack-choice.md, …}
├── repo-map.md
├── conventions/README.md
├── agent-notes/
│   ├── README.md
│   ├── ceo-handoff-<date>.md
│   ├── substrator-handoff-<date>.md
│   └── gates/                      ← <id>.md per active gate
tracker/
├── README.md, INDEX.md
└── {triage,open,in-progress,review,blocked,done}/
journal/
├── hook.jsonl                      ← gitignored; written by the journal-event hook
└── summary.jsonl                   ← gitignored; written by the summarise-session skill
.claude/
├── settings.json                   ← project-level hooks (incl. git-guardrails, lint-format)
└── hooks/{journal-event.sh, journal-summarise.sh, git-guardrails.sh, lint-format.sh}
.gitignore
```

The template at `golem/substrate/templates/project-bootstrap/` is the canonical seed. Substrator copies it via `tar`-pipe, substitutes `{{PROJECT_NAME}}` / `{{STACK_PRIMARY}}` / `{{DATE}}`, chmods the hook scripts, runs `git init`.

---

## 9. Known constraints and tensions (today)

1. **One team per CEO session.** Claude Code enforces it. A single CEO cannot run PA↔PAR for project A and the dev team for project B in parallel. Leaf one-shots can be parallelised freely.
2. **Per-agent frontmatter coverage is partial.** Only 3 of 18 personas have hook frontmatter (substrator, PA, PAR). Others are visible only via the parent's settings.json layer — meaning their internal tool stream is invisible to the dashboard. Rolling out frontmatter to the remaining 15 is mechanical.
3. **No project registry yet.** Discovery only sees `$GOLEM_ROOT/golem-projects/<name>/`. Working with external projects (e.g. `~/Documents/software/trialroomai`) requires either moving them under `golem-projects/` or symlinking. v3 addresses this.
4. **Channel server is single-CEO.** Hardcoded as a singleton; no project-scoped routing.
5. **No teammate-health monitoring.** When a teammate goes idle from an unexpected cause (permission prompt blocking, faulty settings.json, model error), the CEO's `Agent(…)` call blocks indefinitely. There is no "deadman switch" or sanity-check timer.
6. **Stale CEO sessions occupy dashboard ports.** `tryListen()` auto-increments — useful for development, but means killing only one process can still leave the dashboard on a non-canonical port.
7. **`teammate-idle` is wired only on PA and PAR.** Other future teammate personas (TA, TAR, dev-team members) need it added when they ship.
8. **`hook_event_name` discrimination is implicit.** Documented in code comments only; no schema enforcement. If Claude Code changes the field's surface, the dashboard's stop / idle distinction breaks silently.

---

## 10. Decisions log (v2 additions)

- **D-v2-001.** `$PWD`-based project-root resolution in `journal-event.sh`, with fallback to `$CLAUDE_PROJECT_DIR`. Routes sub-agent events to the project they're actually working in, not the parent session's home.
- **D-v2-002.** Agent records keyed by `agent_id` (sub-agents firing under the parent's session_id) or `session_id` (teammates with their own session_id), discriminated automatically in `getOrCreate`. Resolves the "multiple sub-agents under one parent session" attribution problem.
- **D-v2-003.** `subagent-stop` events routed by `hook_event_name`: `Stop` (agent's own frontmatter) = terminal; `SubagentStop` (parent observing) = journal entry only. Prevents ghost agent records spawning per parent-side observation.
- **D-v2-004.** `TeammateIdle` introduced as a distinct event tag, wired in teammate frontmatter. Recency-based classification handles wake-from-idle naturally.
- **D-v2-005.** `TeamCreate` made mandatory before iterative-loop Agent spawns. Codified in CEO persona + handoff-protocol skill.
- **D-v2-006.** `$GOLEM_ROOT` treated as a first-class workspace (kind `'root'`). The CEO's meta-activity becomes inspectable through the dashboard.
- **D-v2-007.** Static asset responses carry `no-cache` headers so dev edits show up without hard-refresh. Acceptable cost during the build-iteration phase.
- **D-v2-008.** Dashboard chat handlers (`/api/brief` and siblings) record-then-forward (chat persisted first, then proxied to the channel server). A failed forward surfaces as a `system/error` chat entry instead of silent message loss.
- **D-v2-009.** Channel `ack` / `respond` separated: `ack` mandatory and immediate; `respond` only for user-facing prose. Codified in CEO persona Step 1.5.
- **D-v2-010.** Acks rendered as inline thinking-trace, full CEO `respond` messages rendered as markdown via `marked`. Visual hierarchy in the chat drawer matches the semantic split.
