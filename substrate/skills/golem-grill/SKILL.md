---
name: golem-grill
description: Interview the brief — surface unstated assumptions, ambiguous acceptance criteria, missing context — before producing specs. Use when product or technical specs would be ungrounded without further questions.
expects:
  - A brief that is concrete enough to ask questions about, but vague enough to need them.
  - The user (or the orchestrator standing in for them) reachable for answers.
produces:
  - A list of surfaced ambiguities with proposed defaults.
  - Either: confirmed answers from the user, or recorded defaults the spec proceeds on.
category: sop
---

# golem-grill

Specs that are written from a vague brief tend to encode the agent's own assumptions, which surface only at review time when the cost of revising is high. The grill is the structured interview pass that pulls assumptions to the surface *before* spec authoring.

Used by:
- **Product Architect** on entry to a feature ticket.
- **Tech Architect** on entry to a stack/architecture decision.
- **Engineer** on entry to a ticket whose acceptance criteria are vague (per the Engineer's Skill playbook).

## Procedure

### Step 1 — Read everything available

Read the brief, the parent ticket if any, the relevant ADRs, the relevant CONTEXT entries. Form a working model. Most "questions" disappear once the available context has been read.

### Step 2 — Compose questions

For each unresolved point, write a question of one of three shapes:

- **Choice.** "Should we A or B?" — when a decision is needed and we have at least two named options with named tradeoffs.
- **Precision.** "When you said X, did you mean X-narrow or X-broad?" — when a term in the brief admits multiple readings.
- **Verification.** "We assume Y unless told otherwise — confirm?" — when we have a working assumption but want to call it out.

Each question:
- Has a one-line proposed default the grill will proceed on if the answer never comes.
- States *why* the question matters (one sentence — what changes downstream depending on the answer).

Cap at ~7 questions. If you have more, the brief is too vague for grilling — escalate to the orchestrator (TL or CEO) for clarification before grilling.

### Step 3 — Ask

Format the questions in a single message to the user (or, in practice, surface them in the ticket's hand-off log if the orchestrator is the entry point). Number them. Each numbered item: question, *why-it-matters*, *proposed-default*.

Example shape:

```
1. **Auth provider** — do we use Supabase Auth or roll our own JWT?
   _why_: changes the data model (RLS vs. middleware-enforced) and a downstream skill choice.
   _default_: Supabase Auth, since we're already on Supabase.

2. **Pagination** — cursor-based or offset?
   _why_: cursor needs an indexed sort key; offset is simpler but breaks under writes.
   _default_: offset (20/page) for v1; cursor when we hit perf.
```

### Step 4 — Record

Whether the user answers or the defaults stand:

- Append a "Grill outcome" block to the ticket's hand-off log. List each question with the resolved answer (user-confirmed or defaulted). Mark which is which.
- If a defaulted answer might be wrong, propose it as an `Open ambiguity` candidate in CONTEXT.md (as a flag for the Documentarian on next sweep).

### Step 5 — Proceed

Spec authoring continues with the resolved answers as anchors. Reference them by question number when the spec encodes one of them.

## Anti-patterns

- **Asking everything.** Grilling is for ambiguities that change downstream output. "What should we name the table?" is not grill-worthy.
- **Asking without proposed defaults.** Every question should be answerable by the user with "yes" / "go with default" / "no, do X instead". Open-ended "what should we do?" wastes the user's turn.
- **Asking after spec is half-written.** Grill is *before* spec. Mid-spec rework is the signal that grill should have happened earlier.
- **Skipping when the brief is "obvious".** Briefs that feel obvious often hide assumptions the grill would surface. Run grill, even briefly. One question is fine if that's all there is.

## When this skill is wrong

- The brief is already concrete and unambiguous (rare but possible — e.g. "rename function X to Y everywhere"). Skip grill.
- The user has explicitly said "use your best judgement". Note that as the answer to all questions; record defaults; proceed.
- The grill itself would take longer than just writing the spec and getting it reviewed. Use review as the disambiguation step instead.
