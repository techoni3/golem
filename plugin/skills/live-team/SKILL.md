---
name: live-team
description: Read ONLY when the user explicitly asks for a live-session hand-off or names a target session. Covers cross-session dispatch, outbound consults, manager distribution across live peers, and worktree reconcile. Do not use for solo work — the default path is golem:standalone.
---
<!-- GENERATED: skills/live-team/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# live-team

> [!WARNING]
> Cross-session delegation is **disabled by default**. Do not load or act on this skill
> because a task looks big, because peers appear in a Team roster, or because a role card
> mentions a hand-off. Load it only when the user explicitly asks for a live-session
> hand-off or names a target session.
>
> The default path is a single session using in-process agents — see `golem:standalone`.

## Why this is opt-in

A live peer's message is not evidence. A teammate once reported an approved PR with passing
tests; independent `gh` checks found no PR and no implementation, and teardown was moments
away. Every claim that crosses a session boundary must be re-verified by the receiver before
it changes state. That cost is why this is opt-in rather than default.

## Discovery

`sessions_dispatchable` — live sessions, roles, workload, pending queue. Never trust a Team
roster snapshot from session start; re-check immediately before every dispatch.

## Dispatch

`ticket_dispatch({id, session_id, when_idle})`. The dispatched ticket must already carry its
own scope: read-first materials, in/out of scope, acceptance and evidence contract, writer of
record, and return format. A topic is not a dispatch.

Route by capability, not by model brand:

| Work | Target role |
|------|-------------|
| bounded recon | explorer |
| design, decomposition, context packs | planner |
| one scoped implementation ticket | builder |
| mechanical verification of claims | explorer |
| spec or code review | reviewer |
| routing, reconcile, closure | manager |

If the target role is not live, fall back to the in-process agent (`researcher` / `worker` /
`reviewer`) and record the exception on the ticket. Never leave work parked because a peer is
absent.

## Manager: distribution

When a spec reaches `planned`:

1. `sessions_dispatchable` — confirm live targets.
2. Dispatch child work items to live builders, least-loaded first.
3. Parallel builders in one repo → an explicit worktree directive per builder
   (`golem:git-conventions`).
4. Subscribe to `spec/<display_id>/tree` and the relevant `ticket/<display_id>` topics. Quiet
   next-turn interest — never poll.

## Manager: built event loop

When a child reaches `built`:

1. Dispatch **verification** to a live explorer; move the child to `verifying` with dispatch
   evidence naming the verifier.
2. Dispatch **review** to a live reviewer (`golem:reviewing`, code mode). Verification and
   review are different gates — run both.
3. `verified` + review verdict clean → `done`. `rejected` or a `BLOCKER` → re-dispatch the
   original builder with the report → `building`.

No live explorer or reviewer → spawn the in-process `researcher` / `reviewer`, note it on the
ticket, and still record the evidence before advancing.

## Manager: reconcile

For worktree branches you orchestrated, serialise on main after verification and review:

```bash
git merge --no-ff <type>/gol-<n>-<kebab-slug>
```

Bounce conflicts back to the builder with the conflict output; never ask a builder to merge
into main, and never resolve a builder's conflicts for them. Full lifecycle:
`golem:git-conventions`.

## Outbound consults

`consult_request({to, question, context})` — fire-and-forget when you are stuck after a real
attempt, suspect tunnel vision, or the user names a session. Keep working; do not poll.
`consult_status` nudges. The reply is advice: keep what holds up, discard the rest, you keep
final say.

Do not use a consult as cheap task hand-off — that is a dispatch. Answering an inbound consult
needs no opt-in and lives in `golem:consulting`.

## Receiving

An inbound `ticket_dispatch` is always valid work, with or without this skill loaded. Load the
role skill named by your role, verify the dispatch context against repository reality, and
report deviations.
