# Codex support matrix

Validated against the official OpenAI Codex Hooks, Build plugins, MCP,
AGENTS.md, and App Server documentation on 2026-07-15, plus the native
`codex-cli 0.144.5` App Server schema on 2026-07-16.

| Capability | Support |
|---|---|
| Skills / AGENTS.md | Native |
| Plugin manifest / marketplace | Native |
| STDIO MCP | Native |
| Session, prompt, tool pre/post, compaction, subagent-stop, stop facts | Native documented hooks |
| Hook trust | User must review non-managed hooks with `/hooks` |
| Ordinary Codex CLI dispatch delivery | Tier B: explicit pull with Golem MCP tools only |
| Live push into an ordinary CLI turn | **Not supported / never reported delivered** |
| Managed App Server dispatch/control delivery | Tier A for a Golem-owned, version-gated headless supervisor or its private `golem codex` TUI bridge: typed durable envelopes into one idle, bound thread |

`codex-cli 0.144.5` can add and enable the generated plugin, but its `codex mcp`
command exposes configuration (`list/get/add/remove/login/logout`) and no
generic MCP tool-call command. The isolated journey therefore installs the
plugin with the native CLI, verifies it is enabled, and speaks MCP stdio
directly to the installed bundled server to initialize and list tools. It does
not label marketplace discovery alone as MCP validation.

The adapter relies only on documented hook inputs. In particular it does not
parse `transcript_path`, whose format OpenAI explicitly says is unstable. The
supported events are `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStop`, and `Stop`.

## GOL-472 App Server version contract

GOL-472 has established a narrow, mechanically tested contract for a future
Golem-owned Codex supervisor. It does **not** change the current Codex plugin
from Tier B to Tier A: an ordinary `codex` TUI is still pull-only and must
never be reported as having received a dispatch.

The supported spike environment is exactly:

| Field | Contract |
|---|---|
| CLI | `codex-cli 0.144.5` |
| Schema command | `codex app-server generate-json-schema --experimental --out <dir>` |
| Fingerprinted surface | Deterministically ordered hashes of the 30 generated request, response, approval, lifecycle, and TUI-bridge leaf schemas used by the supervisor |
| Contract SHA-256 | `8fea722bf38d19e54265e4650f36e9329bac40d334c1c287d12bb6d21c8eac71` |
| Transport exercised | Local JSONL over `stdio://` |
| WebSocket | Not a production transport: documented as experimental and unsupported |

The generator's aggregate JSON bundle is not byte-stable: its definition order
changes between invocations of the same binary. The contract therefore hashes
the deterministic leaf schemas that Golem will actually consume, rather than
pretending the unordered aggregate bundle is a reliable version gate. The
single journey at `test/codex-app-server-spike.test.mjs` regenerates and checks
that leaf set, then proves the installed process accepts `initialize` /
`initialized`, `mcpServerStatus/list`, `thread/start`, `thread/resume`, and
`turn/start`; observes `turn/completed`; and exercises the schema-known command
approval callback without auto-approving it. The turn is read-only,
network-disabled, and its requested `touch` command is not allowed; the test
asserts that the target file was not created. `thread/resume` requires a persisted rollout in this version,
so the journey completes one read-only turn before it resumes, then explicitly
deletes its temporary thread after completion.

Run it with:

```bash
node test/codex-app-server-spike.test.mjs
```

Any Codex version or fingerprint mismatch is a hard stop for a managed
supervisor: regenerate the schema, review the protocol and approval decision
shapes, update this contract intentionally, then rerun the journey. GOL-473
must enforce that same check before it presents a session as dispatchable.

GOL-477 later qualifies one narrow local-Unix TUI topology. It does not make a
separately launched `codex`, an arbitrary `codex --remote` endpoint, or a
network WebSocket listener dispatchable.

## GOL-473 managed supervisor lifecycle

Golem now has one recoverable App Server supervisor per canonical Codex session.
This began as a headless lifecycle-only primitive. GOL-474 added its
inbound tracker-target boundary; GOL-475 and GOL-476 complete the supported
cross-harness dispatch, control-envelope, and owner-approval contract. None of
that qualifies an ordinary Codex TUI or arbitrary remote TUI as Tier A.

The managed process is local JSONL over `stdio://` only. It runs the exact
GOL-472 CLI/schema gate before spawning, initializes once, starts or resumes
the persisted thread, and denies unknown unsolicited server callbacks. A new
thread gets one read-only, network-disabled readiness turn before a health lease
is exposed; this is necessary because 0.144.5 only resumes a thread after it
has a persisted completed rollout. A restart resumes the recorded thread id and
fails closed rather than silently creating a replacement thread.

The durable registry at `~/.golem/codex-supervisors.json` is mode `0600` and
records the canonical id, App Server pid/stdio transport, thread id, cwd,
resolved project id/root, exact version fingerprint, health lease, turn state,
and durable-envelope/turn mappings. A process exit, failed lease renewal, or
explicit stop releases the lease and records a terminal fact, so recency cannot
leave a dead supervisor dispatchable.

## GOL-474 typed managed-Codex delivery

The supervisor starts the required Golem MCP child through documented Codex
`app-server --config` dotted TOML overrides. Those overrides are process-local:
they do not edit project or user `config.toml`. The child gets both the
canonical `GOLEM_CEO_SESSION_ID` and a managed-bound marker. Its MCP status
must expose the `golem` server plus `ticket_dispatch` and
`sessions_dispatchable` before Golem advertises delivery.

Managed-bound MCP calls never use model-provided `__golem_session_id` as actor
identity. A conflicting value fails closed; a missing or inconsistent
supervisor binding fails closed; OpenCode's existing shim-injected identity
continues to use its separate local-plugin trust boundary. The managed MCP
process deliberately does not bind the generic CC/OC HTTP channel endpoint.

The Golem supervisor itself owns a loopback-only typed `POST /brief` endpoint.
Dashboard routing adds the canonical target and the current health-lease owner
credential; the credential is kept non-enumerable in dashboard channel rows so
browser/API projections do not expose it. The adapter accepts only a durable
envelope with non-empty content. It persists envelope acceptance before
`turn/start`, then persists the returned turn id. Duplicate envelopes with the
same envelope id return the existing acceptance and never create another turn;
after first acceptance, retry bytes are not used as a new delivery instruction.
If a process loss makes the `turn/start` outcome ambiguous, the mapping is kept
recovery-pending and is not replayed automatically. A completed mapping survives
a restart; an in-progress mapping remains non-dispatchable until a later
recovery policy resolves it.

`delivery_ready:true` therefore means all of the following are true at once:
the pinned App Server is live, the required MCP is active with the canonical
binding, the typed endpoint lease is current, and the thread is idle with no
in-flight envelope. Busy, failed, stopped, or recovery-pending sessions remain
visible as facts but are not dispatch targets. This wave preserves the existing
raw CC/OC channel behavior unchanged.

For the lifecycle primitive only, run it in the foreground:

```bash
golem codex-supervisor run --session <canonical-id> --cwd <project-path>
```

This is not an ordinary `codex` TUI and must not be attached with `codex
--remote`. The command emits a public health record (never the lease owner
token) and stops cleanly on Ctrl-C.

Run the real lifecycle/restart journey with:

```bash
node test/codex-supervisor.test.mjs
```

Run the dashboard-to-turn delivery and identity journey with:

```bash
node test/codex-delivery.test.mjs
```

The journey interrupts its own temporary App Server turn immediately after the
durable mapping is observed (or accepts the controlled prompt's immediate
completion), so it never performs the tracker ticket's requested work in the
source checkout.

## GOL-477 private managed Codex TUI

`golem codex` opens an ordinary interactive Codex terminal in the current
directory without required flags. It creates one canonical Golem session,
starts the pinned App Server on private JSONL stdio, then exposes a temporary
mode-`0700` Unix-socket WebSocket bridge and launches `codex --remote` against
that socket. `--session <canonical-id>` and `--cwd <path>` are advanced wrapper
options; other Codex arguments pass through. `--remote` and `-C`/`--cd` are
reserved so the TUI cannot bypass the bridge or switch Golem's canonical
project. When an explicit `--session` has a stored thread id, the wrapper uses
documented remote `codex resume <thread-id>`; it preserves that mapping unless
the native resume response successfully binds a replacement thread.

The TUI is the **only logical App Server client**. It sends `initialize`,
`initialized`, thread start/resume/fork, normal turns, sandbox/model options,
and approval responses unchanged. The bridge never initializes a second client.
After the TUI's `initialized` notification, it injects only a private,
unforgeable-id `mcpServerStatus/list` request; after an idle canonical thread is
bound, it may similarly inject a durable tracker `turn/start`. Responses with
those reserved ids stay private; all App Server notifications and server
requests—including approvals—are forwarded to the TUI unchanged.

Before forwarding a TUI `turn/start` or `turn/steer`, the bridge synchronously
marks the canonical session busy. This prevents tracker injection into a human
turn even when App Server reports a steer as a fresh-looking turn id. A
`turn/completed` notification releases the dispatch gate; an interrupted human
turn is also idle, while an interrupted durable envelope remains failed. TUI
responses to `thread/start`, `thread/resume`, and `thread/fork` update the
canonical thread; server-created `thread/started` broadcasts never do, because
they may belong to a subagent.

`delivery_ready:true` in TUI mode is stricter than a stored thread id: the one
connected TUI must have sent `initialized` and completed its own
`thread/start`, `thread/resume`, or `thread/fork` response. The gate closes
synchronously on a disconnect and while `/new`, resume, or fork is pending;
a failed lifecycle response restores the prior binding only. Tracker-created
turns omit sandbox, model, and approval overrides, so they inherit the native
TUI's active settings and every approval remains in the TUI.

The managed session card uses Codex's own thread identity and activity
protocol. Start/resume responses and `thread/name/updated` supply the displayed
thread name (for example `sol:main2`), while `thread/status/changed`,
`turn/started`, and `turn/completed` drive working, waiting, and idle state.
The dashboard reads Codex's append-only `session_index.jsonl` as a fail-open
name fallback for managed sessions started before those notifications were
captured. Its authenticated health response supplies the live delivery gate;
the slower persisted lease is recovery evidence, not the current activity
signal. A managed TUI's raw hook fact is shadowed by its canonical supervisor
row so one thread cannot appear as two agent cards.

Exactly one TUI may attach. On TUI exit, SIGTERM, or App Server loss, the
wrapper cleans the lease, process, and socket. SIGINT is left to the foreground
TUI/turn interruption and does not tear down the wrapper. While a human turn is
busy, dashboard `when_idle` dispatches remain in the durable queue and drain
only after the now-idle bridge advertises `delivery_ready:true`.

Run the real transport journey with:

```bash
node test/codex-tui-bridge.test.mjs
```

## GOL-475 cross-harness delivery matrix

The tracker, managed Codex MCP, generic Claude Code channel, and OpenCode shim
now share one durable dispatch contract. For Tracker→Codex, Codex→Codex/CC/OC,
CC→Codex, and OC→Codex, the canonical sender and target are stored on the
envelope before delivery. The receiving harness acknowledges that exact
envelope and its follow-up tracker action is attributed to the same canonical
target; a successful transport response alone is not treated as pickup.

`delivery_ready:false` on a `codex-supervisor` lease is unreachable for every
direct/when-idle path: direct routing returns an undelivered result and the
drainer holds durable queued work. Once the bound MCP and idle thread make the
lease ready again, the existing queue delivers one envelope. CC and OpenCode
retain their historical channel-presence behavior; ordinary Codex TUI remains
Tier B/pull-only.

The isolated matrix also proves busy and waiting holds, failed typed delivery
followed by a retry of the same envelope, target/supervisor restart without a
second turn, and rejection of a model-supplied cross-harness actor identity:

```bash
node test/cross-harness-matrix.test.mjs
```

## GOL-476 managed control plane and approvals

Tier A applies only to the managed headless supervisor above. It is not a
capability claim for a separately launched `codex` TUI, `codex --remote`, a
WebSocket listener, or an arbitrary local terminal. Those remain Tier B/pull
only because Golem has no documented, safe way to inject work into them.

| Inbound behavior | Managed Codex | CC / OpenCode |
|---|---|---|
| Ticket dispatch | Durable envelope → typed `/brief` → one App Server turn | Existing channel/bridge route unchanged |
| Session notification, consult request/reply/status | Durable control envelope → typed `/brief` | Existing `/brief` or `/consult` route unchanged |
| Subscription digest, tracker gate resolution | Durable control envelope → typed `/brief` | Existing channel brief/gate route unchanged |
| Role activation | Stored durably, then visibly gated; use an explicit ticket dispatch or restart before the next dispatch | Existing `/role` behavior |
| Interrupt / halt | Visibly gated; wait and send an explicit follow-up, or stop/recover the owning supervisor for an emergency | Existing generic controls |
| App Server approval | Local owner-mediated, one-off decision only | Harness-native policy |

Every managed non-ticket control is allocated in `message_envelopes` before
network delivery with its canonical sender and target. The supervisor accepts
only that typed envelope; it never accepts a raw `/consult`, `/role`, or
untracked `/brief` from the dashboard. A retry keeps the original
envelope-to-turn mapping. CC and OpenCode still receive their route-specific
events, so the new Codex path does not alter their channel semantics.

### Operator approval procedure

Known App Server command/file approvals pause as pending local operator work;
unknown server requests fail closed. The persisted supervisor record contains
only a redacted correlation row (method, thread/turn/item ids and a bounded
reason), never command text, patches, or permission profile contents. The full
live request is available only through the owner-authenticated loopback
endpoint behind this local CLI flow:

```bash
golem codex-supervisor approvals --session <canonical-id>
golem codex-supervisor approvals --session <canonical-id> --id <approval-id>
golem codex-supervisor approvals --session <canonical-id> --id <approval-id> --decision approve
```

`approve` is always one-off: command/file requests use the pinned schema's
single-request decision; permission-profile approval echoes exactly the
requested profile with `scope: "turn"`. It never enables a session cache or a
policy amendment. `decline` and `cancel` are explicit; permission-profile
decline/cancel returns a JSON-RPC error because the pinned schema has no deny
result. Supervisor stop, crash, or restart fails all pending requests closed
and never replays a decision.

### Recovery and upgrade policy

Run a managed session with `golem codex-supervisor run --session <canonical-id>
--cwd <project-path>`. For an expected stop, use its owning terminal (Ctrl-C);
for an unexpected stop, inspect `~/.golem/codex-supervisors.json`, resolve any
failed-closed approval or recovery-pending envelope, then start the same
canonical session again. Do not redeliver a recovery-pending envelope unless a
human explicitly creates a new dispatch.

Any Codex CLI or schema fingerprint change is a hard stop. Regenerate the App
Server schemas, review every changed request/response pair (especially
approval responses), intentionally update `lib/codex-app-server-contract.js`,
then rerun the App Server, delivery, control-plane, and cross-harness journeys.

```bash
node test/codex-control-plane.test.mjs
```
