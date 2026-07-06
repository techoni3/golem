---
name: get-consult
description: Read when genuinely stuck (a bug, a blind spot, or tunnel vision) and your own subagents have not cracked it, or when the user says "get consult from <session>". Fires an async `consult_request`; you keep working, the reply pushes back later.
---
<!-- GENERATED: skills/get-consult/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# get-consult

A **consult** is a fresh pair of eyes from a *peer session* (often on a different
backend — claude, or an ollama model like glm-5.2). It is **not** delegation and
**not** a subagent: the peer keeps its own context, does its own investigation,
and hands back advice you weigh critically. You keep the final say.

## When to reach for it

- A bug you (and your subagents) cannot crack after a real attempt.
- A suspected architectural blind spot — something the design makes hard to see.
- Tunnel vision: you've been circling one approach and want a different angle.
- The user explicitly says *"get consult from `<session-name>`"*.

Do **not** use it as cheap delegation. If the work is just "go do this," that's a
subagent or a dispatched ticket, not a consult.

## How to send one

Call the **`consult_request`** MCP tool (golem channel). It is fire-and-forget —
it returns a `consult_id` immediately and you **keep working**. Do not block, do
not poll in a loop, do not set a timeout.

```
consult_request({
  to: "ogolem",                      // the peer's /rename name, or a session_id
  question: "<what you're stuck on, what you've already tried, the specific ask>",
  context: "<error output, key file paths/snippets, repo/branch, constraints>"   // optional but helps
})
```

Write `question` like you're briefing a sharp colleague who has *none* of your
context: state the symptom, what you expected, what you tried and why it didn't
work, and the precise question. Put supporting material (stack traces, the 2–3
files that matter, the branch) in `context` — the consultant investigates on its
own, so give it a running start, not your whole repo.

Targeting: `to` is the peer's **`/rename` name** (e.g. `"ogolem"`). If the name is
ambiguous (two live sessions share it) or unresolved, the tool tells you — pass an
exact `session_id` instead. The peer must be a **live session running the golem
plugin** (it needs a registered channel to receive the consult).

After it returns, **carry on with your own work.** Tell the user you've sent the
consult and what you're doing meanwhile.

## When the reply arrives

It pushes into your context later as a channel event:

```
<channel source="golem" kind="consult_reply" consult_id="cns-…" from_name="ogolem">…</channel>
```

Treat it as **advice, not orders.** Read it critically: keep what holds up against
the evidence, discard what doesn't, and re-decide for yourself. A fresh perspective
is valuable precisely because it's unattached to your assumptions — but it also
lacks your full context, so verify its claims before acting. Then fold the useful
parts into your work and tell the user what you took and what you set aside.

## If it's taking a while

You never block, but if you want a status check, nudge with **`consult_status`**:

```
consult_status({ to: "ogolem", consult_id: "cns-…" })
```

Still non-blocking — the consultant replies (or sends a status) on its own schedule.

## Related

- `golem:provide-consult` — the other side: how a session answers a consult.
