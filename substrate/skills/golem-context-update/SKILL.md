---
name: golem-context-update
description: How to update CONTEXT.md and docs/ARCH.md from merged state — the Documentarian's rewrite procedure. Use post-merge, when sweeping cross-cutting state changes that no single PR was scoped to capture.
expects:
  - The merged diff for the just-finished session(s).
  - Read access to journal/hook.jsonl, journal/summary.jsonl, docs/agent-notes/, docs/adr/.
  - Current state of CONTEXT.md and docs/ARCH.md.
produces:
  - Revised CONTEXT.md with new vocabulary, updated boundaries, surfaced invariants, retired ambiguities.
  - Revised docs/ARCH.md when an ADR landed or cross-cutting infra shifted.
  - Optional new normative content promoted from agent-notes (with the source notes deleted).
category: substrate
---

# golem-context-update

The Documentarian's core procedure. Working agents focus on their ticket; nobody is responsible for "did this PR shift the architecture or vocabulary?" — that question is answered here, post-merge, with the panoramic view.

This skill is invoked by the Documentarian on a post-merge sweep. It does not run during the request flow.

## What this skill writes to

- `CONTEXT.md` — vocabulary, entities & boundaries, invariants, open ambiguities. (And `docs/CONTEXT-MAP.md` if the project has split CONTEXT past the size threshold.)
- `docs/ARCH.md` — stack, service/module boundaries, cross-cutting infra, perf invariants, external deps.
- (As a side effect) deletes promoted notes from `docs/agent-notes/`.

## What this skill does NOT write to

- Source code, tests, or build config.
- ADRs themselves. ADRs are append-only, authored at the time of decision. The Documentarian *reads* ADRs to update ARCH/CONTEXT; it does not author new ones.
- The tracker.
- The journal.

## Inputs to read

In this order:
1. The **merged diff** since the last sweep. Skim for files outside `src/` that signal cross-cutting change: ADRs added, conventions added, hooks changed, schema changes.
2. **`journal/summary.jsonl`** lines since the last sweep. Look for `substrate_signals`, `human_interventions`, `notes` flagging surprises.
3. **`docs/agent-notes/`** entries. Sort by `Last verified` date; focus on those touched in this sweep window or older than ~30 days.
4. **`docs/adr/`** entries with status changed since last sweep (Proposed → Accepted, Accepted → Superseded).
5. The current state of **CONTEXT.md** and **docs/ARCH.md** — what's already captured.

## The procedure

### Step 1 — Vocabulary additions to CONTEXT.md

Walk the merged diff and journal `notes` for new domain terms used unselfconsciously. Examples: a new entity in the data model ("workspace", "tag"), a new bounded context ("billing"), a redefined term.

For each candidate term:
- If it earns the Vocabulary section's bar (used in conversation/code, non-obvious, multiple agents), add it. One sentence.
- If it's standard for the stack (`controller`, `model`), do not add.
- If it's used once and ad-hoc, do not add — leave for the next sweep.

Cross-reference ADRs by id (`See ADR-0014`).

### Step 2 — Boundary revisions to CONTEXT.md

If the merged diff added a bounded context, an entity relationship, or shifted ownership: update the entities-and-boundaries section. Update the Mermaid diagram if it exists; otherwise update prose.

### Step 3 — Invariants

If a convention or ADR locked in an invariant (e.g. "all API endpoints async"), add it to CONTEXT.md's Invariants section as one bullet.

### Step 4 — Open ambiguities

Move resolved ambiguities out of `Open ambiguities`. If the resolution earned a vocabulary entry, ensure it's there. If not, just delete the ambiguity entry.

Add new ambiguities surfaced in `notes` or `human_interventions`.

### Step 5 — ARCH.md revisions

Triggered when:
- A new ADR was Accepted in this window — reflect its decision in the relevant ARCH section.
- A cross-cutting infra change landed (auth flow change, new external dep, persistence change).
- A perf invariant was added or relaxed.

Do not duplicate ADR content into ARCH; ARCH is the synthesis. Link to the ADR.

### Step 6 — Promote agent-notes

For each agent-note:
- **Recurring or load-bearing** — promote into the right home (CONTEXT vocabulary, ARCH invariant, a new convention file under `docs/conventions/`, or — only if a new decision is implied — flag for the relevant Architect to write an ADR; do not write the ADR yourself). After promotion, **delete the source note**.
- **Still emerging** — leave. Note it in your sweep summary so the next sweep weighs it again.
- **Stale (>30 days, no recurrence)** — flag for user review (do not auto-delete unverified content).

### Step 7 — repo-map.md

If the merged diff added/removed top-level directories or significantly shifted the repo shape, update `docs/repo-map.md` per `golem-repo-map-update`.

### Step 8 — Sweep summary

Append one entry to `journal/summary.jsonl` for the sweep itself: `recipe: "doc-sweep"`, listing what was promoted, what was retired, what was flagged. The Meta-agent uses this to spot whether the sweep is keeping up.

## Anti-patterns

- **Rewriting whole files in one pass.** Surgical edits per section. Whole-file rewrites lose the existing structure and stylistic choices that the Substrator and prior sweeps established.
- **Promoting one-off notes prematurely.** A note must recur or be load-bearing. "It looked important" is not enough.
- **Authoring ADRs.** ADRs are decisions made at the time. Documentarian observes; it does not decide.
- **Touching source code.** Out of scope. Cross-cutting code shifts are observed via the merged diff; the response is in CONTEXT/ARCH/conventions, not in the code itself.
- **Skipping the source-note deletion after promotion.** The promoted note lives in the normative doc now. Leaving the original creates duplicate sources of truth.

## When this skill is wrong

- You're authoring a decision, not synthesising one — write an ADR (and the ADR is authored by the Architect making the decision, not by Documentarian).
- You're updating per-ticket state — that's the tracker.
- You're recording a session-level outcome — that's `golem-summarise-session`.
