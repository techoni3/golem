---
name: golem-gates
description: Human-gate primitive for the golem CEO. Two kinds — approval gates (posture-driven pause points between phases, e.g. "stop after ideation", "gate after tech-arch") and input gates (event-driven blockers when a phase needs a secret/API key/credential the system cannot generate). Defines both file formats, how to write each, and how to clear them via channel reply or file edit. Read this when a brief contains a pause condition, when a sub-agent returns blocked on a missing input, or when scanning for previously-written gates on resume.
category: substrate
---

# golem-gates

Human-decision pause points in a journey. Used only by the CEO persona — sub-agents never write or clear gates; a sub-agent that needs a human surfaces it in its hand-off log, and the CEO turns that into a gate.

There are **two kinds of gate**, and they behave differently:

| Kind | Trigger | Question to the human | Optional? |
|---|---|---|---|
| **approval** | A phase boundary the brief posture (or G1 default) marks | "Should the journey continue?" | Yes — posture-driven; default journeys have only G1 |
| **input** | A sub-agent returns blocked, needing a secret / API key / credential / account the system cannot generate itself | "Supply value X — work is blocked until you do" | No — mandatory whenever the need arises |

Both kinds share the gate scan and the `gates/` directory; they differ in the file `kind:` field, what clears them, and what the CEO does on clearing.

---

## Approval gates

A pause between phases, when a human should decide whether the journey continues before the next phase commits effort.

### The boundaries (G1–G5)

The CEO persona owns the *mapping* of which boundaries are gateable — see persona §4F. In summary:

| Gate | Boundary | Default |
|---|---|---|
| G1 | after A.1 ideation (the Smelter pick) — "build this idea?" | **on by default**, even with no posture hint |
| G2 | after B.2 product specs | posture-driven |
| G3 | after B.4 tech architecture | posture-driven |
| G4 | before B.7 first production deploy | posture-driven |
| G5 | after a §4C Diagnoser verdict classified `architecture` | posture-driven |

G1 is on by default because choosing *which* idea to commit build effort to is a human's call, not an orchestration decision — autonomy means "build the thing", not "decide what to build". G2–G5 fire only when the brief posture asks.

### Approval gate file shape

One file per gate at `docs/agent-notes/gates/<gate-id>.md`.

```yaml
---
gate_id: g1-after-ideation-2026-05-16-a1b2
kind: approval
phase_just_completed: ideation
next_phase: bring-up
status: awaiting        # awaiting | approved | denied | cancelled
created_at: 2026-05-16T17:00:00Z
brief_ref: docs/agent-notes/ceo-handoff-2026-05-16.md
journey_id: J-2026-05-16-a1b2
---

# Awaiting approval — ideation complete, before bring-up

## What just finished
<one paragraph: what artefacts the prior phase produced and where they live>

## Where to look
- <path 1>
- <path 2>

## On approval, what runs next
<one paragraph: which sub-agents / teams the CEO will dispatch>

## To approve / deny / cancel
Either:
- Reply through the channel: `approve <gate_id>`, `deny <gate_id>`, or `cancel <gate_id>`.
- Edit this file: set `status:` to `approved | denied | cancelled` and relaunch `golem-ceo`.
```

`gate_id` convention: `<gate-label>-<YYYY-MM-DD>-<short-hash>`, stable and unique within the workspace.

### When to write an approval gate

After a phase completes, in the persona's autonomy loop:

1. Read the brief posture (parsed at classification time — see "Brief-posture parsing" below).
2. Is the just-completed phase a gate boundary? G1 always (default-on); G2–G5 only if posture lists them.
   - `stop-after: <phase>` → write a **terminal gate**: write the file, run the closing reflex, yield; do NOT auto-continue even on approval.
   - `gates: [...]` (or G1) → write a **pause gate**: yield, resume on approval.
3. Compose the `gate_id`, fill the body from the template.
4. Append `gate-written: <gate_id>` to the current ticket's hand-off log (if any).
5. Close with `golem-summarise-session` and yield.

---

## Input gates

A blocker, not a checkpoint: a phase cannot proceed because it needs a value only a human can supply — an API key, a service credential, a cloud account, an OAuth token, a paid-tier sign-up.

### How an input gate arises

A sub-agent (commonly Local DevOps at B.5, Cloud DevOps at B.7, or an Engineer integrating a third-party API in §4D) hits a missing secret. Sub-agents cannot write gates — so the sub-agent returns a `blocked` artefact whose hand-off log names the missing input(s). The CEO reads that hand-off log entry and, instead of writing a generic escalation memo, writes an **input gate**.

### The security rule (non-negotiable)

**Secret values never travel through the channel or the journal, and never enter git.** An input gate file holds only the *names* of the required keys and the *path* of the file the human must write. The human writes the values directly into that file; the CEO never sees, transmits, or logs the values — it only verifies the keys are present.

Before writing an input gate, the CEO confirms `target_file` is git-ignored (adds it to the project `.gitignore` if not). Recommended `target_file`: a gitignored `.env.local` or `.secrets/<name>.env` at the project root.

### Input gate file shape

```yaml
---
gate_id: input-stripe-keys-2026-05-16-c3d4
kind: input
phase_blocked: B.7-cloud-devops
status: awaiting        # awaiting | approved | denied | cancelled
created_at: 2026-05-16T17:00:00Z
brief_ref: docs/agent-notes/ceo-handoff-2026-05-16.md
journey_id: J-2026-05-16-a1b2
target_file: .env.local          # path relative to project root; gitignored
required_keys:                    # NAMES ONLY — never values
  - STRIPE_API_KEY
  - STRIPE_WEBHOOK_SECRET
---

# Input required — B.7 Cloud DevOps blocked on Stripe credentials

## What is blocked
<which sub-agent / phase returned blocked, and what it cannot do without these>

## What you must provide
Write these keys into `<absolute path to target_file>`. That file is git-ignored —
the values stay on your machine and never enter git, the channel, or the journal.

- `STRIPE_API_KEY` — <what it is / where to obtain it>
- `STRIPE_WEBHOOK_SECRET` — <...>

## To clear this gate
1. Write the keys into the target file.
2. Reply through the channel `approve <gate_id>`, or set `status: approved` in this file.

The CEO then verifies the target file contains every required key and resumes the blocked phase.
```

`gate_id` convention for input gates: `input-<subject>-<YYYY-MM-DD>-<short-hash>`.

---

## The gate scan — clearing gates

On every CEO turn, before classifying the new user message, run the scan:

```
1. List docs/agent-notes/gates/*.md across the current workspace.
2. For each file, read `status` and `kind`.
3. A file with status in {approved, denied, cancelled} and NO `acted_at` line is UNACTED.
4. Process every unacted gate FIRST, before treating the new user message as a fresh brief.
```

If a channel `gate_approve` / `gate_deny` / `gate_cancel` event arrives, first write the verdict into the named gate file's `status:`, then fall into this scan (the gate is now unacted).

Acting on an unacted gate, by `kind` and `status`:

**`kind: approval`**
- `approved` → resume the journey from `next_phase`; append `acted_at: <ISO>` to the gate frontmatter; continue the autonomy loop. (For a terminal `stop-after` gate, "resume" still means: do not auto-continue — the approval only confirms the recorded outcome; treat per the brief.)
- `denied` → hard stop for that journey. Log it in the journal, append `acted_at`, do not retry the phase without a new brief.
- `cancelled` → log, append `acted_at`, drop that journey; proceed to the new user message.

**`kind: input`**
- `approved` → the human says the values are provided. **Verify before resuming:** read `target_file`; check every `required_keys` entry is present and non-empty.
  - All present → append `acted_at`, re-dispatch the `phase_blocked` sub-agent/team (its prompt now points at `target_file`), continue the loop.
  - One or more missing → the human approved before writing the file. `respond` naming exactly which keys are still missing, set `status` back to `awaiting`, do **not** append `acted_at`, close with the reflex, yield. Never read or echo the values — only check presence.
- `denied` / `cancelled` → the phase cannot proceed. Transition the associated ticket to `blocked` with a hand-off-log reason, append `acted_at`, return to the new user message.

---

## Brief-posture parsing

The CEO extracts posture from the brief at classification time. Recognised hints:

| Phrase in brief | Interpreted as |
|---|---|
| "just ideate", "explore only", "research only" | `stop-after: ideation` |
| "stop after specs", "produce specs only", "no implementation" | `stop-after: specs` |
| "spec only, then check with me", "pause before tech" | `gates: [G2]` |
| "check in after each phase", "human gate at every step" | `gates: [G2, G3, G4, G5]` |
| "approve before deploy", "gate before go-live" | `gates: [G4]` |
| "go end-to-end", "fully autonomous", "don't stop" | `gates: []` — but G1 still fires |
| (no posture hint) | default — **G1 only** (ideation→build); continuous autonomy otherwise |

G1 is not suppressible by posture short of the journey having no ideation phase (A.2 / A.3 / A.4 entry points start past ideation, so G1 never arises there). Input gates are never governed by posture — they fire whenever a sub-agent is blocked on a missing input.

When posture is ambiguous, the CEO records the inferred posture in the journey hand-off memo and proceeds — it does NOT ask the user. The user can correct via a gate reply or channel message.

---

## What this skill is NOT

- It does not implement timeouts — gates wait indefinitely until cleared.
- It does not negotiate which boundaries get approval gates — the persona (§4F) owns that mapping; this skill defines the G1–G5 boundaries and the default behaviour.
- It does not relay Claude Code permission prompts — that is the channel's `permission_relay` capability, separate from this skill.
- It does not store, transmit, or log secret values — input gates carry key *names* and a *file path* only.
- It does not work for sub-agents — only the CEO main thread reads and writes gates. A sub-agent that finishes a phase, or is blocked on an input, appends a hand-off log entry; the CEO sees it and writes the gate.
