---
name: gates
description: Human-gate primitive — write an approval gate to pause at a milestone the user asked for, or an input gate when a phase is blocked on a missing secret. Read when intake requested a pause, when work blocks on a credential, or when scanning for open gates on resume.
---

# gates

Gate files live OUTSIDE the repo at `~/.golem/gates/<project_id>/<gate_id>.md`
(`project_id` derivation: see journaling). Markdown with YAML frontmatter.

Two kinds:
- **approval** — pause at a milestone the user requested at intake ("check with me after specs").
- **input** — work is blocked on a value only the human can supply (API key, credential).

**Approval gate** frontmatter:
```yaml
gate_id: <label>-<YYYY-MM-DD>-<short-hash>
kind: approval
status: awaiting          # awaiting | approved | denied | cancelled
created_at: <ISO8601>
phase_just_completed: <e.g. specs>
next_phase: <e.g. build>
```

**Input gate** frontmatter:
```yaml
gate_id: input-<subject>-<YYYY-MM-DD>-<short-hash>
kind: input
status: awaiting
created_at: <ISO8601>
target_file: .env.local   # path relative to repo root; MUST be git-ignored
required_keys:            # NAMES ONLY — never values
  - STRIPE_API_KEY
```
**Security rule:** secret values never enter the gate file, channel, or journal. The
gate lists key NAMES + the git-ignored `target_file`; the human writes VALUES into that
file directly. Confirm `target_file` is git-ignored before writing the gate. After
clearing, verify each `required_keys` entry is present and non-empty — never echo values.

**Clearing:** the dashboard/channel sends `gate_approve | gate_deny | gate_cancel`
(gate_id in meta), OR the human edits `status:` in the file directly. On `approved`:
approval → resume from `next_phase`; input → verify keys present, then resume the blocked
work. `denied` → hard stop. Append `acted_at: <ISO>` once acted.
