---
name: gates
description: Human-gate primitive — post an approval/input question comment on the active spec when work must pause for the human; legacy gate files remain readable for older gates. Read when intake requested a pause, work blocks on a credential, or scanning for open gates on resume.
---
<!-- GENERATED: skills/gates/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# gates

New gates are spec comments, not files. Prefer posting an open tracker comment on
the relevant spec ticket with:

- `tag: question`
- `status: open`
- `block_id: gate:<gate_id>`
- `author` / `requested_by`: your current session id
- body in plain language: what is blocked, what decision/input is needed, and
  what resumes after the human answers

Use the dashboard helper when available:

```bash
curl -fsS -X POST http://dashboard.golem.localhost:7420/api/projects/<project_id-or-registry-id>/gates \
  -H 'content-type: application/json' \
  -d '{"kind":"approval","spec_ticket_id":"GOL-...","requested_by":"'"${CLAUDE_CODE_SESSION_ID:-$OPENCODE_SESSION_ID}"'","ask":"Approve moving from specs to build?","next_phase":"build"}'
```

If `spec_ticket_id` is omitted, the dashboard uses the project's most recent
`in_progress` spec. If no spec can be identified, it falls back to a legacy gate
file and logs that fallback.

Two kinds:
- **approval** — pause at a milestone the user requested at intake ("check with me after specs").
- **input** — work is blocked on a value only the human can supply (API key, credential).

**Input gate body:** include the git-ignored `target_file` and required key
NAMES only. Never include secret values.

**Security rule:** secret values never enter the gate file, channel, or journal. The
gate comment lists key NAMES + the git-ignored `target_file`; the human writes VALUES into
that file directly. Confirm `target_file` is git-ignored before posting the gate. After
clearing, verify each `required_keys` entry is present and non-empty — never echo values.

**Clearing:** the human resolves the gate comment (or replies with the verdict
and then resolves it). The dashboard notifies the `requested_by` session when the
comment resolves; do not poll the spec comments as the normal resume path. Treat
resolution text as the verdict:

- approval approved → resume from `next_phase`
- input supplied → verify keys present, then resume blocked work
- denied/cancelled → hard stop or cancel that branch

Legacy gates still live at `~/.golem/gates/<project_id>/<gate_id>.md` and the
dashboard can still apply `gate_approve | gate_deny | gate_cancel` to those files.
Do not create new legacy files unless the dashboard helper reports it could not
identify a spec.
