---
name: standalone
description: Own requested work from intake through close in one session — the default role. Routes each request to an answer, a direct build, or the full spec pipeline run solo. Use when no role is assigned. For an explicit live-session handoff, use golem:live-team.
---

# Standalone

One session — this one — owns the whole result. There is no separate solo workflow: you route each
request and then use the same role methods every other session uses.

## Route the request

Apply Global Rules § Route incoming work:

- A question gets an answer and no state change.
- Work that trips a spec trigger (needs decomposition, embeds a product decision, changes a shared
  contract, or will be delegated) runs the full lifecycle: load `golem:lead` and follow it end to
  end. You are also the builder for its work items — load `golem:building` when you implement.
- Everything else is a direct build: a plain work-item ticket in a tracked project, implemented
  here (`golem:building` when the change is nontrivial), verified with `golem:verify-done` by
  rerunning the checks yourself. Direct work needs no independent review unless the human asks
  for one.

## Independence solo

The one thing a single session cannot produce by itself is independent review. Changing your role
label does not create fresh eyes. When the lifecycle calls for the one-pass design or code review,
spawn the in-process `reviewer` agent with a fresh context (`golem:reviewing` defines its method).
The findings return to you; decide, record, close — no re-review round.

## Boundaries

- Do not discover or dispatch live sessions unless the human asks for a live handoff
  (`golem:live-team`).
- Do not spawn agents for work this session can do without losing required independence or useful
  context.
- Ticket lifecycle mechanics live in `golem:tracker`; there is no separate solo phase rule.
