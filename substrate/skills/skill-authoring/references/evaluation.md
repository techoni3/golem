# Evaluating a skill

A skill nobody measured is a skill nobody knows the value of. These are the cheapest measurements
that produce real answers.

## Three layers

| Layer | Question | Method |
|-------|----------|--------|
| **Trigger** | Given this phrasing, does it activate? | ~20 queries, half should-trigger and half should-not. Run each several times — activation is not deterministic |
| **Quality** | Is the output better than without? | The same task with and without the skill. The delta is the value |
| **Process** | Is every part pulling weight? | Read the execution transcript. If the agent skips the same step across three runs, delete that step |

### Building the trigger matrix

The negatives matter more than the positives. **Near-misses, not obviously unrelated prompts** —
a skill that stays quiet on "what's the weather" proves nothing. Use the requests that its nearest
competing skills should win.

```
must-trigger:
  - "review this PR before I merge"
  - "can you audit the auth changes"
  - "check the diff for problems"
must-not-trigger:
  - "write tests for the auth changes"        → belongs to the testing skill
  - "explain how auth works here"             → plain question, no skill needed
```

Keep this file next to the skill. It is a regression suite: re-run it after adding skills, editing
descriptions, or updating the harness, because skills fail silently and stay failing.

### Running the A/B delta

Write the **rubric before running the eval**. The rubric is the specification of what good looks
like; writing it afterwards means grading against whatever you happened to get.

Then run the same realistic task both ways and score against the rubric. Two rules keep this
honest:

- **Evaluate blind where possible** — the grader should not know which output came from which
  configuration.
- **Do not grade your own work.** A grader that shares the generating context drifts toward
  agreement. Isolation is what makes the score mean anything.

If the without-skill result lands within a few points of the with-skill result, the skill is
coasting. That is a delete, not a rewrite.

### Reading the transcript

Outputs hide process failures. A skill can produce an acceptable answer while making the agent
take a longer, more circuitous path to it — pure cost, invisible in the result. Read what actually
happened at least once per skill.

## Iterating on a draft

A generated first draft is a starting point, not a deliverable — unedited drafts are worth
approximately nothing. The loop that works:

1. Clarify intended behaviour, workflow, edge cases, and dependencies **before** drafting.
2. Draft, and build a small set of realistic user prompts alongside it.
3. Run them with the skill available. Compare against running without.
4. Revise from **observed** failures, not imagined ones.
5. Expand the prompt set and re-run.
6. Optimise the description **separately** from the body, against positive, negative, and
   ambiguous queries.

Step 6 is separate on purpose: description edits change *whether* the skill runs and body edits
change *what it does when it runs*. Tuning both at once means you cannot attribute the change.

## Retirement

A skill written to compensate for a model weakness has a natural expiry — when the weakness goes
away, the skill becomes training wheels and can actively degrade output. Run this after major
model updates:

1. Run the standard tasks **with the skill disabled**. Within a few points of with-skill → the
   skill is coasting on inertia.
2. Price the token overhead against that delta.
3. Read transcripts, not just outputs.
4. Test on **new** prompts. The original set may be accidentally tuned to the skill's strengths.

This applies to capability-uplift skills. A skill encoding local conventions, infrastructure, or
process does not expire — no model update teaches the model your deployment topology.

## Sprawl

Individual skills stay reasonable while the collection becomes the problem: every installed
description competes for one shared startup budget, and project-specific skills sitting in a
global scope tax every unrelated project.

- Audit whenever any single scope exceeds roughly ten skills.
- Sorting rule: **used in one project only → move it there. Otherwise → global.**
- Disable rather than accumulate.
