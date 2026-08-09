---
name: standalone
description: Own requested work from intake through close in one session. Use when no role is assigned or one session must handle the full work. For an explicit live-session handoff, use golem:live-team.
---

# Standalone

Keep responsibility for the requested result in the current session. Use the role method for each
stage that the work needs; do not create a second workflow for solo work.

## Method

| Stage | Guidance |
|---|---|
| Understand | Confirm the requested result, scope, constraints, and current state. |
| Design | Load `golem:lead` when the work needs design, a specification, or decomposition. |
| Build | Load `golem:building` when you implement a change. Keep useful source context in this session. |
| Verify | Load `golem:verify-done` and inspect the claimed result and evidence. |
| Review | Load `golem:reviewing`. Use a fresh reviewer when independent judgment is required. |
| Close | Load `golem:tracker` for ticket lifecycle work, then explain the result and next action to the human. |

Do the work in this session when it already has the useful context. Use an in-process agent only
when the task needs independent judgment or a separate context that materially improves the result.

## Boundaries

- A different role label in the same session does not provide independent review.
- Do not split work among agents when the current session can complete it without losing required
  independence or useful context.
- Do not discover or dispatch live sessions unless the user requests a live handoff. Load
  `golem:live-team` when that condition applies.
- Follow the lifecycle method in `golem:tracker`. Do not add a separate solo phase sequence here.
