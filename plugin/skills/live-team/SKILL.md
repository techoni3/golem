---
name: live-team
description: Read ONLY when the human explicitly asks for a live-session hand-off or names a target session. Owns the cross-session transport contract — discovery, dispatch, returns, and outbound consults. Do not use for solo work; the default path is golem:standalone.
---
<!-- GENERATED: skills/live-team/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# Live team

> [!WARNING]
> Cross-session delegation is **disabled by default**. Do not load or act on this skill because a
> task looks big, because peers appear in a roster, or because a role mentions a hand-off. Load it
> only when the human explicitly asks for a live-session hand-off or names a target session.

## Why this is opt-in

A live peer's message is not evidence. A teammate once reported an approved PR with passing
tests; independent `gh` checks found no PR and no implementation, and teardown was moments away.
Every claim that crosses a session boundary must be re-verified by the receiver before it changes
state. That cost is why this is opt-in rather than default.

## Discovery

`sessions_dispatchable` — live sessions, roles, workload, pending queue. Never trust a roster
snapshot from session start; re-check immediately before every dispatch or fallback decision.

## Dispatch

`ticket_dispatch({id, session_id, when_idle})`. The dispatched ticket must already carry its own
scope: read-first materials, in/out of scope, acceptance and evidence contract, writer of record,
and return format. A topic is not a dispatch.

Route by capability, not by model brand:

| Work | Target role |
|------|-------------|
| web research, repo orientation | explorer |
| code survey to ground a design | builder, loading `golem:code-survey` |
| design, decomposition, routing, close | lead |
| one scoped work item | builder |
| mechanical verification of claims | explorer |
| the one-pass design or code review | reviewer |

If the target role is not live, fall back to the in-process persona (`researcher` / `worker` /
`reviewer`) and record the exception on the ticket. Never leave work parked because a peer is
absent.

## Owner: distributing and closing work items

When a spec reaches `planned`:

1. Re-run `sessions_dispatchable` immediately before choosing each recipient.
2. Dispatch child work items to live builders, least-loaded first.
3. Parallel builders in one repo → an explicit worktree directive per builder
   (`golem:git-conventions`).

When a child reaches `built`:

1. Dispatch verification to a live explorer; move the child to `verifying` with dispatch evidence
   naming the verifier. A rejected verification re-dispatches the original builder with the
   report.
2. Obtain the one-pass code review (`golem:reviewing`) from a live reviewer. Findings are
   advisory: decide each, record what you incorporated or declined and why, and close — there is
   no re-review round.
3. Builders merge their own work into the spec branch (including from worktrees, after rebasing
   onto it); you resolve only cross-item conflicts and land the spec branch on `main`
   (`golem:git-conventions`).

No live explorer or reviewer → spawn the in-process persona, note it on the ticket, and still
record the evidence before advancing.

## Return identity

Every delegated brief carries an authenticated sender/delegator `session_id`. A builder,
explorer, or reviewer writes its durable report to the ticket first, then calls `session_notify`
to that exact id with the outcome, report location, and next action. Never route a return by a
`/rename` label, display name, or a fresh peer search — the delegator may have been renamed since
dispatch. Human-originated work has no peer return target. Events never wake a session; the
active notify is the only wake path.

## Outbound consults

Consultation uses the same `session_notify` primitive. Send a `CONSULT REQUEST — ADVISORY ONLY`
message with a unique reference, the question, and enough context to answer, to the exact current
session id. The consultant replies with `CONSULT REPLY` (or `CONSULT STATUS`) over
`session_notify`, echoing the reference. It is advice, not delegation; keep what holds up and
keep final say. Do not use a consult as cheap task hand-off — that is a dispatch. Answering an
inbound consult needs no opt-in and lives in `golem:consulting`.

## Receiving

An inbound `ticket_dispatch` is always valid work, with or without this skill loaded. Load the
role skill named by your role, verify the dispatch context against repository reality, and report
deviations.
