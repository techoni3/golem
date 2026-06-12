---
name: work-loop
description: Dispatcher loop for feature-sized or larger work — intake questions, PLAN.md format, one-opus-worker-per-item execution, verify-then-check, milestone logging. Read when starting a feature or multi-step build (not a chat answer or one-line fix).
---

# work-loop

For feature-sized+ work only. Skip intake entirely for chat answers and tiny fixes — just do + verify.

## 1. Intake — ask via AskUserQuestion (2–4 questions), then proceed on defaults

- **Journey size** — confirm this is feature-sized+ (not a one-off fix).
- **Spec depth** — default: a single PRD section in the PLAN.md header (no separate spec doc).
- **Test budget** — default: 10–20 journey-level integration/e2e (see test-policy).
- **Gates wanted** — default: pre-merge gate only (no mid-phase approval gates).

## 2. Write PLAN.md at the repo root

H1 title, optional one-paragraph context, then a single FLAT GitHub-checkbox list —
one item per line, no nesting, no tables:
```markdown
# <Feature title>

<optional context paragraph / PRD section>

- [ ] First item
- [ ] Second item
```

## 3. Execute — one item at a time

- Spawn exactly ONE worker subagent (`model: opus`) per item. Prompt = the item text +
  the names of relevant skills (e.g. test-policy, pr-conventions, verify-done).
- **Never two writer agents in the same repo concurrently** — serialize all writes.
  Read-only research may fan out in parallel.
- On worker return, run `golem:verify-done` BEFORE checking the box. Claims aren't evidence.
- Then flip `- [ ]` → `- [x]` in PLAN.md.

## 4. Milestone — per completed item

Append ONE journal line per the `golem:journaling` one-liner (`event:"milestone"`,
`text` = the item text), after the box is checked.
