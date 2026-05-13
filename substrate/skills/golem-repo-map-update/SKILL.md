---
name: golem-repo-map-update
description: How to maintain docs/repo-map.md — the agent's table of contents for the repo. Use at bring-up (initial generation), on structural changes (incremental), or on Documentarian sweeps (full diff-and-update).
expects:
  - The project root with a working file tree.
  - Knowledge of the project's stack conventions (where source lives).
produces:
  - A revised docs/repo-map.md reflecting the current top-of-tree shape.
category: substrate
---

# golem-repo-map-update

`docs/repo-map.md` is the **agent's table of contents** for the repo. Lets an agent answer "where would I find X?" without grepping the whole tree. Smaller agents (Reviewer, Test Writer) often read repo-map first, then the specific files they need.

## What goes in repo-map.md

- Each meaningful top-level directory: a short description of what it contains.
- Each meaningful subdirectory under `src/`: one-liner on its responsibility.
- Pointers to the canonical file for important concepts ("HTTP middleware lives at `src/api/middleware/`").

## What does NOT go in repo-map.md

- Per-file documentation. That's overkill; the file's name + structure is the doc.
- Architecture decisions. Those are ADRs / ARCH.md.
- Domain definitions. Those are CONTEXT.md.
- Stack conventions. Those are `docs/conventions/`.

The map is shallow — usually two levels deep, three at most. If you find yourself wanting four, the section probably wants its own README.

## Three maintenance modes

| Mode | Trigger | Owner | Scope |
|---|---|---|---|
| Bring-up | Substrator runs at project init | Substrator (with Tech Architect's scaffold) | Stub the structure; fill once Tech Architect has scaffolded |
| Structural change | Incremental, in the same commit that adds/moves a top-level dir | Engineer / Tech Architect | The affected section only |
| Documentarian sweep | Post-merge | Documentarian | Diff-and-update across changed paths |

## Procedure: bring-up (Substrator)

Substrator generates the stub before Tech Architect scaffolds, so the file exists with empty sections. Once Tech Architect has scaffolded (creating `src/`, `tests/`, etc.), the Substrator (or the Tech Architect, in the same scaffold commit) fills in the per-directory descriptions.

Stub shape lives in the project-bootstrap template; do not redesign per project — extend it.

## Procedure: structural change (Engineer / Tech Architect)

When the commit adds, removes, renames, or significantly resizes a top-level dir:

1. Identify the affected section in `docs/repo-map.md`.
2. Update one section, surgically. Do not rewrite the whole file.
3. Include the change in the same commit as the structural change. Repo-map drift across commits is a strong friction signal.

If you are adding a single file under an existing well-described directory, you likely do not need to update repo-map. Only structural changes warrant an entry.

## Procedure: Documentarian sweep

1. Compute the diff of paths since the last sweep (added / removed / renamed top-level dirs and significant subdirs).
2. For each changed path, reconcile against repo-map.
3. If multiple incremental updates have left repo-map fragmented or stale, do a full regeneration: walk the tree to depth 2-3 and rewrite per-section descriptions, keeping the prior wording where the meaning is unchanged.

## Style

- Per-directory: one or two sentences.
- Per-subdirectory: one sentence.
- Lead with the *responsibility*, not the *implementation*. Good: "HTTP layer. Endpoints, request/response models." Bad: "Contains FastAPI routers and Pydantic models with @app.post decorators."
- Cross-reference where useful: `(see ARCH.md § Persistence)`.

## Anti-patterns

- **Generating from a tree dump.** A `tree` output is not a repo-map; the responsibilities are missing.
- **Per-file entries.** Repo-map is shallow. Per-file detail belongs in the file.
- **Drift across commits.** The map should stay in sync with the same commit that ships the structural change.
- **Restating ARCH.md.** Repo-map is "where things are"; ARCH is "what they are". Different layers; do not duplicate.
- **Documenting hypothetical structure.** Map what exists now, not what might be there next sprint.

## When this skill is wrong

- You're describing the system's architecture or invariants — that's ARCH.md.
- You're describing how decisions were made — that's an ADR.
- You're describing how to operate in the codebase (linting, naming, testing) — that's `docs/conventions/`.
