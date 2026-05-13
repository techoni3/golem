# golem channel server

A custom [MCP channel](https://code.claude.com/docs/en/channels-reference.md)
server for the golem substrate. Lets the dashboard (or any HTTP client) push
**briefs**, **interrupts**, **halts**, and **gate verdicts** into a live
`golem-ceo` Claude Code session — and exposes an SSE stream so the dashboard
can subscribe to the CEO's acks.

This server is internal to the substrate. Not published to npm.

## How it fits

```
                                                  ┌──────────────────────┐
  POST /brief, /interrupt, /halt, /gates/:id/... │  golem-ceo session   │
  GET  /events  (SSE: CEO acks back)             │  (Claude Code)       │
  ─────────────────────────────►  ┌──────────┐  │                      │
       dashboard / cli / curl     │  golem   │──│ ◄── stdio (MCP)      │
                                  │  channel │  │                      │
                                  │  server  │──│ ──► <channel> events │
                                  └──────────┘  │                      │
                                                └──────────────────────┘
```

The CEO sees inbound events as `<channel source="golem" kind="...">` tags and
responds by calling the `ack` reply tool. The dashboard subscribes to
`GET /events` to observe those acks live.

## Endpoints

All POST routes require an `X-Sender` header whose value is one of the
allowed senders (default: `dashboard,cli,curl`; override via
`GOLEM_CHANNEL_ALLOWED_SENDERS`). The body can be plain text or JSON; if
JSON with a `content` or `brief` field, that field is used as the event body.

| Method | Path                          | Inbound kind   | Notes                                                  |
| :----- | :---------------------------- | :------------- | :----------------------------------------------------- |
| POST   | `/brief`                      | `brief`        | New user brief. CEO classifies and runs the flow.      |
| POST   | `/interrupt`                  | `interrupt`    | Course-correction folded into in-flight work.          |
| POST   | `/halt`                       | `halt`         | Graceful halt — CEO writes a closing memo and yields.  |
| POST   | `/gates/:id/approve`          | `gate_approve` | Approve a pending gate. `gate_id` meta attribute set.  |
| POST   | `/gates/:id/deny`             | `gate_deny`    | Deny — hard stop for that journey.                     |
| POST   | `/gates/:id/cancel`           | `gate_cancel`  | Cancel — log + drop, no retry.                         |
| GET    | `/events`                     | —              | SSE stream of CEO replies — `event: ack` and `event: response`. |
| GET    | `/healthz`                    | —              | `{ ok: true, version }` — for smoke tests.             |

## Reply tools — `ack` and `respond`

The server exposes **two** tools the CEO calls to send messages back through
the channel. The split matters: `ack` is the fire-and-forget receipt, and
`respond` is for user-facing prose.

### `ack({ kind, gate_id?, summary })`

Called immediately on every inbound event. Confirms receipt and states (in
one sentence) what the CEO is about to do. Broadcast as `event: ack` on the
SSE stream:

```
event: ack
data: {"kind":"brief","summary":"classified as fresh idea, dispatching ideation team","ts":"2026-05-11T..."}
```

The dashboard renders these as muted, italicised "ceo · ack" bubbles in the
chat lane — they're the working-on-it signal, not a substantive reply.

### `respond({ text, kind?, gate_id? })`

Called when the CEO has something user-facing to say: a status answer, a
clarification, a decision ask, or a short outcome summary. Broadcast as
`event: response`:

```
event: response
data: {"text":"Smelter picked variant B — async stand-up bot for distributed eng teams. Pausing at the post-ideation gate per posture.","kind":"brief","ts":"2026-05-11T..."}
```

The dashboard renders these as normal "ceo" bubbles. The CEO is instructed
**not** to use `respond` for narrating intermediate tool calls — the agent
timeline already shows that activity. A typical journey: one `ack` at start,
zero `respond` calls if the work is purely internal, one `respond` at the
end if there's a user-facing outcome.

See the [`golem-ceo` persona](../../personas/golem-ceo.md) § "Channel reply
contract" for the authoritative rules.

## Install

```bash
cd substrate/channels/golem
npm install
```

## Register with Claude Code

Channel MCP servers are registered via a project-level `.mcp.json` that
Claude Code reads from its cwd at startup. The launcher's cwd is
`$GOLEM_ROOT` (default `~/Documents/software/experiments/golem`).

There's a template at `substrate/channels/golem/.mcp.json` with
`__ABS_PATH__` as a placeholder. Copy it into `$GOLEM_ROOT/.mcp.json` and
replace `__ABS_PATH__` with the absolute path to your substrate checkout:

```bash
# Example (adjust the absolute path to your substrate location):
SUBSTRATE_DIR="$HOME/Documents/software/experiments/golem/substrate"
GOLEM_ROOT="${GOLEM_ROOT:-$HOME/Documents/software/experiments/golem}"
sed "s|__ABS_PATH__|$SUBSTRATE_DIR|g" \
    "$SUBSTRATE_DIR/channels/golem/.mcp.json" \
    > "$GOLEM_ROOT/.mcp.json"
```

If `$GOLEM_ROOT/.mcp.json` already exists with other MCP servers, merge by
hand — don't blow it away.

Then verify Claude Code sees it:

```bash
cd "$GOLEM_ROOT" && claude mcp list
```

## Run

The launcher spawns this server as a subprocess of Claude Code:

```bash
export GOLEM_CEO_CHANNELS="server:golem"
golem-ceo
```

`golem-ceo` detects the `server:` prefix and passes
`--dangerously-load-development-channels server:golem` (required during the
channels research preview, since custom channels aren't on the approved
allowlist). The flag pops a one-time confirmation prompt on first use.

## Smoke test

```bash
cd substrate/channels/golem
npm run check
```

This boots the server, polls `/healthz`, and verifies the sender gate. The
MCP stdio side won't be hooked up (no Claude Code peer), which is expected —
the smoke only exercises HTTP.

One-liner to push a brief manually once the server is running under a CEO
session:

```bash
curl -X POST \
  -H "X-Sender: curl" \
  --data 'run the idea pipeline on graph-native databases' \
  http://127.0.0.1:7421/brief
```

Approve a pending gate:

```bash
curl -X POST \
  -H "X-Sender: dashboard" \
  http://127.0.0.1:7421/gates/after-ideation-2026-05-11-a1b2/approve
```

Watch CEO replies live (both acks and substantive responses):

```bash
curl -N -H "X-Sender: dashboard" http://127.0.0.1:7421/events
```

(GET /events doesn't require X-Sender, but the example includes it for
parity with the dashboard's normal request style.)

## Environment

| Variable                          | Default                | Notes                                                                                  |
| :-------------------------------- | :--------------------- | :------------------------------------------------------------------------------------- |
| `GOLEM_CHANNEL_PORT`              | `7421`                 | HTTP port (bound on `127.0.0.1` only).                                                 |
| `GOLEM_CHANNEL_ALLOWED_SENDERS`   | `dashboard,cli,curl`   | Comma-separated allowlist for the `X-Sender` header on all POST routes.                |

## Constraints / caveats

- **Meta keys must be identifiers.** Claude Code silently drops meta keys
  containing hyphens or other non-`[A-Za-z0-9_]` characters. This server
  uses `gate_id` (snake_case) for that reason.
- **`stdout` is reserved for MCP stdio framing.** Diagnostic logging from
  this server goes to `stderr`.
- **Localhost only.** The HTTP listener binds to `127.0.0.1`. If you need
  remote access, front it with an authenticated proxy — don't change the
  bind.
- **No persistence.** Inbound events are pushed straight through; SSE
  listeners only see acks emitted while they're connected. If the dashboard
  wants durable history, it must persist on its end.

## File layout

```
substrate/channels/golem/
├── .mcp.json          # template — copy to $GOLEM_ROOT/.mcp.json
├── README.md          # this file
├── index.js           # the whole server (~250 LoC)
├── package.json
└── scripts/
    └── smoke.js       # `npm run check` smoke test
```
