---
name: golem-retrofit
description: How the Substrator drops the harness onto an existing codebase without overwriting anything. Covers stack detection from manifests, generating CONTEXT/ARCH/repo-map from observed code, handling partial pre-existing substrate state, and what to inventory as triage tickets. Use when retrofitting an existing project, not bootstrapping a fresh one.
category: substrate
---

# golem-retrofit

The extraction protocol for dropping the substrate harness onto a codebase that already exists. Used by the Substrator when invoked in retrofit mode (or by the CEO via §A.4).

## The retrofit principle

**Never overwrite.** A file that already exists in the target directory is authoritative. The harness fills gaps; it does not replace prior content. This applies whether the file is a real source artefact (`src/index.ts`), a partial substrate doc (a half-filled `CLAUDE.md`), or a complete prior substrate (a project already bootstrapped by an earlier version of the substrate).

If a substrate file exists but is empty or visibly a placeholder (only "# TODO" or template placeholders), still preserve it — augment by appending, not by replacing.

## Step 1 — Audit the target

Before writing anything:

1. Walk the tree (top-level + `.claude/` + `docs/` + `journal/`). The tracker lives in the dashboard SQLite DB, not in the project tree.
2. Classify each substrate-relevant path:
   - **missing** — file is not present.
   - **stub** — file present, smaller than ~10 lines or contains only "# TODO" / unfilled template placeholders (e.g. `{{PROJECT_NAME}}` still literal).
   - **populated** — file present, real content.
3. Detect the stack from manifests:
   - `package.json` → Node/TS family; check `"type": "module"`, framework deps.
   - `pyproject.toml` / `setup.py` / `requirements.txt` → Python.
   - `go.mod` → Go.
   - `Cargo.toml` → Rust.
   - `Gemfile` → Ruby.
   - `pom.xml` / `build.gradle` → JVM.
   - Multiple manifests → record all; flag for the Tech Architect to decide the *primary* stack.
4. Detect prior substrate presence:
   - Any `journal/hook.jsonl` lines? → substrate has been live, not just installed.
   - Any existing tickets in the dashboard tracker? Query with `ticket_list` and record their states and titles so retrofit doesn't double-file.
   - Any ADR files? → record their status, do not renumber.

Write the audit to `docs/agent-notes/retrofit-audit-<date>.md`. This memo is the contract for what the rest of retrofit will or will not touch.

## Step 2 — Install missing harness files

For each substrate file listed in the project-bootstrap template:

1. Target is **missing** → copy from template, substitute placeholders (`{{PROJECT_NAME}}`, `{{STACK_PRIMARY}}` from audit, `{{DATE}}`).
2. Target is **stub** → append a `<!-- retrofit: <date> -->` marker and below it append the harness-relevant section (e.g. hooks-wiring reference for `.claude/settings.json`). Never delete what was there.
3. Target is **populated** → leave alone. If its content is incompatible with substrate conventions (e.g. a legacy `tracker/` directory left from a prior substrate version, ADR-0001 with a different shape), record the incompatibility in the audit memo — do not auto-fix.

Hooks need special care:
- `.claude/hooks/*.sh` — copy any **missing** scripts; preserve any existing ones (the user may have customised). Make all executable.
- `.claude/settings.json` — if **populated**, do not auto-merge the hooks wiring. Write the recommended JSON delta to `docs/agent-notes/retrofit-settings-merge.md` and flag for human resolution. If **missing** or **stub**, install the template version directly.

## Step 3 — Generate documentation from observed code

For files that should reflect the existing codebase (not the template's blank stubs), generate ONLY when target was missing or stub:

- `docs/repo-map.md` — walk `src/` (or the inferred source root). One section per top-level subdir, one line per significant file. Header marked **retrofit-generated**.
- `CONTEXT.md` — fill the entities / boundaries sections from observed modules. Leave vocabulary / invariants empty (Architects fill those). Marked **retrofit-generated**.
- `docs/ARCH.md` — write an "as-built" summary: stack (from manifests), service boundaries (from directory structure), key dependencies (from manifests). Marked **retrofit-generated**.
- `docs/adr/0001-stack-choice.md` — file as **Status: Accepted (retrofit)** with rationale "inherited from existing codebase as of <date>". The Tech Architect can supersede via a new ADR if a stack change is planned. If an ADR-0001 already exists, do not overwrite — note in audit memo and let Tech Architect resolve.

If any of these files were already populated, skip generation and note "preserved" in the audit memo.

## Step 4 — Inventory tickets

Create discovery tickets via `ticket_create` for what retrofit observed. Use `labels: ['retrofit', 'discovery']` and `priority: 'high'` so the CEO knows their origin.

Candidate ticket categories (cap each at ~3-4 tickets so the tracker doesn't drown):

- **Missing tests** — modules in `src/` without a `*.test.*` or `tests/*` counterpart. One ticket per significant module.
- **Missing documentation** — exported functions/classes without docstrings. Pick the most public/important ones.
- **Configuration drift** — anything retrofit could not auto-merge (settings.json populated; ADR-0001 conflicts; dashboard tracker has unexpected states or labels).
- **Stack-specific risks** — visibly outdated dependency versions, lockfile drift, security advisories obvious from manifest scan.

Hard cap: ~15 retrofit tickets total. If the audit suggests more, file ONE umbrella ticket "Retrofit found N issues; Tech Architect to triage" with a pointer to the audit memo. Beyond ~15 individual tickets, the noise outweighs the value.

If the dashboard tracker already had tickets before retrofit, do not file duplicates: check titles against the discovery list and skip overlaps.

## Step 5 — Write the retrofit hand-off

`docs/agent-notes/retrofit-handoff-<date>.md`:

```markdown
### Retrofit hand-off · <date>

**Status.** Harness retrofitted. Project ready for CEO continuation.

**Inherited.** <stack(s) from manifests>. <Notable prior substrate, e.g. partial CLAUDE.md preserved>.

**Generated.** <list of docs marked retrofit-generated>.

**Skipped (preserved).** <list of files left alone because already populated>.

**Conflicts flagged.** <list of items needing human resolution, with pointers to per-conflict memos>.

**Tracker.** <count> discovery tickets from `ticket_list` filtered by labels containing `retrofit` and `discovery`.

**Next.** CEO re-enters under §A.3 (continuation). Tech Architect should review docs marked retrofit-generated and either accept or revise via a new ADR.
```

## Partial-substrate scenarios — quick reference

| Pre-existing state | Retrofit behaviour |
|---|---|
| Empty `.claude/` dir | Install all hooks + settings.json. |
| `.claude/hooks/` has some scripts, missing journal-event.sh | Install only the missing ones. Preserve customised ones. |
| `.claude/settings.json` populated, no golem hooks wired | Do not edit. Write merge delta to `docs/agent-notes/retrofit-settings-merge.md`. Flag in handoff. |
| `CLAUDE.md` is the template's verbatim stub (placeholders unsubstituted) | Treat as stub. Substitute placeholders and append project-specific sections. |
| `CLAUDE.md` populated with real content (different conventions) | Preserve. Note divergence in audit memo. Do not file as conflict unless it actively blocks agents (e.g. wrong path conventions documented). |
| Dashboard tracker already has tickets | Preserve. Read titles via `ticket_list`; skip overlapping retrofit tickets. |
| Legacy `tracker/` directory from prior substrate | File a single conflict ticket; let Tech Architect decide whether to migrate. Do not auto-rename. |
| `journal/` exists with old entries | Preserve. Continue appending. |
| `docs/adr/` has 0001..0003 already | Preserve. Do not file your own 0001 — note in audit memo. |
| Prior bootstrap interrupted (some files written, others not, `.git` may exist) | Resume install of missing files only. Do not re-run `git init`. Commit if the working tree is dirty with retrofit changes. |

## What retrofit does NOT do

- Does NOT modify source code. Ever.
- Does NOT auto-merge `.claude/settings.json` when one already exists — flagged for human.
- Does NOT generate ARCH content beyond what's observable from manifests + directory layout. The Tech Architect produces the real ARCH.
- Does NOT run the dev-env or test suite to verify state — that's Local DevOps' job once they pick up discovery tickets.
- Does NOT fail the run on conflicts. Conflicts are recorded and continued past — the CEO routes resolution downstream.
- Does NOT rename or move existing user files to match substrate conventions.
- Does NOT re-run `git init` if `.git` already exists.
