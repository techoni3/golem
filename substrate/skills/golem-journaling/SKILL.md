---
name: golem-journaling
description: How the project's two journals work — mechanical (hook.jsonl) and semantic (summary.jsonl). Use when reading or maintaining the journal, or deciding what belongs in it.
expects:
  - Project root with a journal/ directory.
produces:
  - Understanding of who reads/writes which journal, and the JSONL schemas.
category: substrate
---

# golem-journaling

The journal architecture in one page. Two files, two purposes, two writers, never confused.

## The two files

| File | Written by | Read by | Schema |
|---|---|---|---|
| `journal/hook.jsonl` | The `journal-event.sh` hook on SessionStart / UserPromptSubmit / SessionEnd | Documentarian (post-merge), Meta-agent (cadence) | `{ts, event, session_id, cwd, payload}` per line |
| `journal/summary.jsonl` | The working agent via `golem-summarise-session`, or `journal-summarise.sh` (degraded marker) | Documentarian, Meta-agent | See `golem-summarise-session` for full schema |

Both are append-only. Both are JSONL — one JSON object per line, no commas between, no array wrapper.

## Why two files

- **Mechanical** (`hook.jsonl`) is the unsynthesised stream of "something happened" — cheap, lossless, machine-written. Useful for forensics ("when did the session start? what tool calls did we see?") and for backfilling missing semantic lines.
- **Semantic** (`summary.jsonl`) is the synthesised "what did we mean to do, and how did it go" — written by the agent that has the context. One line per session. This is the Meta-agent's primary signal.

You cannot derive the semantic journal from the mechanical one; the agent's intent and surprises are not in the hook payload. You cannot derive the mechanical journal from the semantic one; one line per session is too coarse for forensics.

## Who writes when

```
SessionStart                  → hook appends to hook.jsonl
UserPromptSubmit              → hook appends to hook.jsonl
…working agents do work…
working agent's last tool call → invokes golem-summarise-session, appends to summary.jsonl
SessionEnd                    → hook appends to hook.jsonl
                              → hook checks summary.jsonl tail; if reflex was missed,
                                appends a {status: "missing-reflex"} marker
```

If the closing reflex fired, the SessionEnd hook is silent. If it didn't, a marker line goes in so the Documentarian sees a trailhead instead of silence.

## Who reads when

**Working agents at runtime do not read either journal.** This is a deliberate constraint. In-session collaboration goes through the ticket's hand-off log, not through the journal. The journal is for cross-session reflection.

- **Documentarian** reads both post-merge to update CONTEXT, ARCH, conventions, repo-map, and to backfill any `missing-reflex` lines from `hook.jsonl`.
- **Meta-agent** reads both on cadence across projects to surface patterns: substrate drift, missing skills, recurring friction, candidates for promotion.

## What does NOT belong in the journal

- The conversation itself. The journal is a structured side-channel; the working harness keeps the conversation.
- Per-ticket state. Tickets live in the golem tracker (dashboard SQLite DB) and are accessed via the tracker MCP tools.
- Per-decision rationales. Those are ADRs.
- Vocabulary or invariants. Those are CONTEXT and ARCH.

If a fact wants to live in the journal but already has a better home, it goes there instead.

## Maintenance

Both files are append-only by convention. They grow forever. Rotate or compact only when they cause real friction (tens of MB) — the Meta-agent flags this.

Both are gitignored. They are local-only by design (per `.gitignore`); they do not sync via git.

## When this skill is wrong

- You're trying to use the journal for in-session communication. Use the ticket hand-off log.
- You're trying to derive the project's architecture from the journal. Use ARCH.md.
