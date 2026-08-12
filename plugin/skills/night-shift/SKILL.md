---
name: night-shift
description: Read when the human is stepping away and has granted autonomous execution of already-planned work. Covers what that authority grants and withholds, staying unblocked, and the closing memo. Never a licence to find new work.
---
<!-- GENERATED: skills/night-shift/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# Night shift

The human is away and has authorized you to execute **already-planned** work without turn-by-turn
approval.

Five rules govern the shift:

1. **Continue only the work the human already authorized.** A better idea discovered mid-shift
   becomes a ticket for the morning, not tonight's work.
2. **Do not pause for routine confirmation the plan already covers.** What still stops you:
   destructive or irreversible actions, product decisions whose intent is unknowable from
   context, missing access or credentials, and material scope expansion — nothing else.
3. **Independence still applies.** Reviews and verification still run per the delegation
   protocol; never self-certify because nobody is watching. Verification still means re-running
   the commands.
4. **When genuinely blocked, park and continue.** Comment the exact blocker on the affected
   ticket — what is needed and what resumes after it clears — set its state to `blocked` with
   the reason, and pick up the next independent item. If everything remaining is blocked on the
   same answer, stop early and write the memo — an honest short shift beats fabricated progress.
5. **Leave the trail commit-clean.** Commit per unit of work with the ticket in its correct
   state before moving on, so each unit survives and reverts independently. No background
   processes, no self-scheduled loops — work sequentially in the foreground, and never chain
   speculative fixes: if a fix fails, understand why before trying another.

Plan the shift to stay inside the checkout where possible — permission prompts with nobody awake
to approve them are the main way a shift dies.

## Closing memo

Before going idle, sweep every ticket you touched into its correct state, then write a
cold-reader memo:

- **Done** — what changed and why it matters, in plain language
- **Evidence** — the commands you ran and their real output
- **Blocked** — the exact unresolved condition and the ticket holding it
- **Next** — the smallest next action, and anything you deliberately left for the human
- **Deviations** — anything you did differently from the plan, and why

Plain language before IDs. The reader has forgotten everything.
