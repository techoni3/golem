---
name: golem-gates
description: Human-gate primitive for the golem CEO. Use when a brief requests stops between phases ("stop after ideation", "stop after specs", "gate after tech-arch"). Defines the gate file format, how to write one, and how to clear it via channel reply or file edit. Read this when a brief contains any pause condition or when scanning for previously-written gates on resume.
category: substrate
---

# golem-gates

Pause-points between phases of a journey, when the user wants human approval before the CEO proceeds. Used only by the CEO persona — sub-agents never write or clear gates.

## Gate file shape

One file per gate, in the project (or ideas) workspace at `docs/agent-notes/gates/<gate-id>.md`.

```yaml
---
gate_id: after-ideation-2026-05-11-a1b2
phase_just_completed: ideation
next_phase: bring-up
status: awaiting        # awaiting | approved | denied | cancelled
created_at: 2026-05-11T17:00:00Z
brief_ref: docs/agent-notes/ceo-handoff-2026-05-11.md
journey_id: J-2026-05-11-a1b2
---

# Awaiting approval — ideation complete, before bring-up

## What just finished
<one paragraph: what artefacts the prior phase produced and where they live>

## Where to look
- <path 1>
- <path 2>

## On approval, what runs next
<one paragraph: which sub-agents/teams the CEO will dispatch>

## To approve / deny / cancel
Either:
- Reply through a configured channel: `approve <gate_id>`, `deny <gate_id>`, or `cancel <gate_id>`.
- Edit this file: set `status: approved | denied | cancelled` and relaunch `golem-ceo`.
```

The `gate_id` should be stable, descriptive, and unique within the workspace. Convention: `<boundary>-<YYYY-MM-DD>-<short-hash>`.

## When to write a gate

In the persona's per-brief flow, after a phase completes:

1. Read the brief posture (parsed at brief-classification time):
   - `stop-after: <phase>` → after the named phase, write a **terminal gate** (write the gate file, run the closing reflex, yield; do not auto-continue even on approval).
   - `gates: [after-X, after-Y]` → after each listed phase, write a **pause gate** (yield, resume on approval).
   - Neither → no gates, proceed straight to next phase.
2. Compose the `gate_id`, fill the file body using the template above.
3. Append a hand-off log entry on the current ticket (if any): `gate-written: <gate_id>`.
4. Close with `golem-summarise-session` and yield.

## How to clear a gate

On every CEO turn, before classifying the new user message, run the **gate scan**:

```
1. List docs/agent-notes/gates/*.md across the current workspace (project or ideas dir).
2. For each gate file, read its `status` field.
3. If any file has status=approved or status=cancelled and no `acted_at` line, that gate is unacted.
4. Process unacted gates FIRST, before treating the new user message as a fresh brief.
```

For each unacted gate:

- `status: approved` → resume the journey from `next_phase`. After resuming, append `acted_at: <ISO>` to the gate file's frontmatter (preserves audit trail) and continue the autonomy loop.
- `status: cancelled` → log cancellation in the project journal, append `acted_at: <ISO>` to the gate file, do not resume that journey, then return to processing the new user message (which may be unrelated work).
- `status: denied` → same as cancelled, but treat as a hard stop: do not retry the same phase without an explicit new brief.

If a channel event arrives containing `approve <gate_id>` / `deny <gate_id>` / `cancel <gate_id>`, the CEO updates the gate file's `status` accordingly, then proceeds with the same flow (the gate is now unacted, so it gets processed before any fresh-brief logic).

## Brief-posture parsing

The CEO extracts posture from the brief at classification time. Recognised hints:

| Phrase in brief | Interpreted as |
|---|---|
| "just ideate", "explore only", "research only" | `stop-after: ideation` |
| "stop after specs", "produce specs only", "no implementation" | `stop-after: specs` |
| "spec only, then check with me", "pause before tech" | `gates: [after-specs]` |
| "check in after each phase", "human gate at every step" | `gates: [after-ideation, after-specs, after-tech-arch]` |
| "go end-to-end", "fully autonomous", "don't stop" | `gates: []` |
| (no posture hint) | default — no gates, continuous autonomy |

When posture is ambiguous, the CEO writes the inferred posture into the journey hand-off memo and proceeds — does NOT ask the user. The user can correct via gate or channel reply.

## What this skill is NOT

- It does not implement timeouts — gates wait indefinitely until cleared.
- It does not negotiate which boundaries get gates — the persona owns that mapping (informed by brief posture).
- It does not relay permission prompts back through channels — that is Claude Code's `permission_relay` channel capability, separate from this skill.
- It does not work for sub-agents or teammates — only the CEO main thread reads/writes gates. Sub-agents that finish a phase append a hand-off log entry; the CEO sees that entry and writes the gate.
