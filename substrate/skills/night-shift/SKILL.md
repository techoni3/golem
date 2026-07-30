---
name: night-shift
description: Read when the user is stepping away and has granted autonomous execution of already-planned work. Covers what that authority grants and withholds, staying unblocked, and the closing memo. Never a licence to find new work; a true blocker goes to golem:gates.
---

# night-shift

The user is away and has authorised you to execute **already-planned** work without
turn-by-turn approval.

## What this grants

Autonomous-loop authority (Global Rules § Authority): act through the planned phases **until
revoked**. Do not pause for trivial approval, do not ask "shall I continue?", and do not stop at
a phase boundary that the plan already covers.

## What this does not grant

- **New scope.** Execute the plan that exists. A better idea discovered mid-shift becomes a
  ticket for the morning, not tonight's work.
- **Skipping the gates.** Verification and review still run — use in-process agents
  (`golem:reviewing`, `researcher`, `reviewer`). Never self-certify because nobody is watching.
- **Background processes.** No wake crons, no self-scheduled loops, no monitors, no background
  agents. Work sequentially in the foreground; when the planned work is done, stop and write the
  memo.
- **Anything irreversible without a recorded reason.** Overriding a `BLOCKER`, force-pushing,
  deleting data, or touching anything outside the repo waits for the human.

## Before the user leaves

This is the moment to front-load everything. Batch and ask now:

- decisions that change what gets built
- credentials or approvals the work will need
- anything ambiguous enough that two readings produce materially different work

Once they are gone, an unasked question costs the whole shift.

## Staying unblocked

- **Permission prompts are the main failure.** Anything reaching outside the repo, or a
  protected path, will stall the shift with nobody to approve it. Plan the work to stay inside
  the checkout.
- **Commit per unit of work**, with the ticket in its correct phase before you move on. If the
  shift ends badly, everything before the last commit survives and each unit reverts
  independently.
- **Never chain speculative fixes.** If a fix fails, stop and understand why. A night of
  guessing produces a morning of untangling.

## When genuinely blocked

Do not burn the shift on one item, and do not guess past a missing decision or credential.

1. Post a `kind:question` ticket assigned to `human` with the exact blocker and what resumes
   after it clears (`golem:gates`).
2. Move that ticket to `blocked` with the reason.
3. **Move to the next independent item** and keep going.
4. If everything remaining is blocked on the same answer, stop early and write the memo. An
   honest short shift beats fabricated progress.

## Closing memo

Before going idle, sweep every ticket you touched into its correct state, then write a
cold-reader memo:

- **Done** — what changed and why it matters, in plain language
- **Evidence** — the commands you ran and their real output
- **Blocked** — the exact unresolved condition and the question ticket holding it
- **Next** — the smallest next action, and anything you deliberately left for the human
- **Deviations** — anything you did differently from the plan, and why

Plain language before IDs. The reader has forgotten everything.
