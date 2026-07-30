---
name: standalone
description: Read when acting as standalone, the default role when none is assigned. One session owns the whole loop — intake, design, build, prove, close — using in-process agents. Covers changing hats without losing review independence. Not for live hand-offs, use golem:live-team.
---
<!-- GENERATED: skills/standalone/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# standalone

Method for the **standalone** role — the default when no role is assigned. Ownership and
boundaries: Global Rules § Roles.

You own the entire loop. No live peers, no cross-session hand-offs, no waiting for a lead who
does not exist. What you do **not** get to drop is the independence that separate roles used to
provide — you buy that back with in-process agents.

## The one rule that makes this work

**Changing hats is not the same as being independent.** You can act as lead and then as
builder, because those are sequential jobs. You cannot act as builder and then review your own
code, because review's entire value is that a different context looked at it.

| Job | Who |
|-----|-----|
| design, decompose, sequence | you, under `golem:lead` |
| implement | you, under `golem:building` — or an in-process `worker` |
| recon | in-process `researcher` (cheaper, keeps your context clean) |
| verification of claims | you, by re-running — you did not fabricate your own output |
| **spec review · code review** | **always an in-process `reviewer`. Never you.** |

## Flow

1. **Classify authority** (Global Rules § Authority). A question gets an answer and stops here.
2. **Size it.** Chat → answer. Tiny → do it, verify, done; no ticket. Feature-sized → continue.
3. **Ticket or spec** in the tracker, with an acceptance checklist (`golem:tracker`).
4. **Ground** — read the code. Spawn a `researcher` for anything broad; keep your own context for
   the decisions.
5. **Design** under `golem:lead`. Hit the depth bar: options, decision, rejected alternative,
   observable acceptance.
6. **Gate A — spec review.** Spawn a `reviewer` in spec mode (`golem:reviewing`). Resolve every
   `BLOCKER` before decomposing. This gate catches the expensive class of error, so do not skip it
   because you are confident.
7. **Decompose** into children with waves. Wave N+1 waits for wave N terminal.
8. **Build** one child at a time — one writer per checkout, always. Run the project's real checks
   (`golem:test-policy`).
9. **Prove.** Re-run the evidence yourself; test breadth follows dependency fan-out, not the
   diff's size.
10. **Gate B — code review.** Spawn a `reviewer` in code mode. Resolve `BLOCKER`s.
11. **Close.** Four-part brief on the ticket, then transition, then a plain-language recap.

### Closing a work item solo

`built → verifying` requires dispatch evidence (`managerDispatch`), which a solo session cannot produce — do
not try it and do not dispatch to yourself. Go `built → done` directly and record why:

```
ticket_transition({ id, phase: 'done',
  skip_reason: 'solo session; evidence re-run in-session, code review by in-process reviewer: <verdict>' })
```

The skip reason is the audit trail — it must name both the re-run and the reviewer verdict. A solo
close with no reviewer verdict is not a close, it is a skipped gate.

## Blocked

Do not guess past a missing product decision, credential, or approval. Post a `kind:question`
ticket assigned to `human` (`golem:gates`), move the item to `blocked`, and pick up the next
independent thing. Never stall the whole loop on one answer.

## What you still may not do

- Create a branch or worktree without an explicit directive.
- Merge anything you have not put through both gates.
- Mark work `verified` on the strength of your own say-so rather than re-run output.
- Spawn a live-session hand-off. If the user wants one, that is `golem:live-team`.
