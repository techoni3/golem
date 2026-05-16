---
name: golem-project-bootstrap
description: Provision a fresh golem project namespace — copy the project-bootstrap template, substitute placeholders, make hooks executable, git-init, and register the project. Use when entering A.1 ideation, A.2 bring-up, or A.2-bootstrap (specs-attached). Not for retrofitting an existing codebase — that is golem-retrofit.
category: substrate
---

# golem-project-bootstrap

The CEO's namespace-provisioning procedure. Lays down a new project directory from the substrate template so every sub-agent dispatched into it journals, tracks, and notes correctly. Used at A.1 / A.2 / A.2-bootstrap. Never for an existing codebase (use `golem-retrofit`).

This skill produces an **empty harnessed namespace**. It does NOT lay down the full substrate harness content or pre-load tracker stories — that is the Substrator's job (node B.1), dispatched after this skill completes.

## Inputs

- `<name>` — a directory-safe slug for the project (kebab-case, ≤6 words). For A.1, the CEO synthesizes this from the brief; if the brief is too vague to name, ask via a gate (`respond` + gate file).
- `<pretty>` — a human-readable project name for the registry.
- `<stack_primary>` — the primary stack if known, else `tbd` (the Tech Architect sets it at B.4).
- `<date>` — today's date, `YYYY-MM-DD`.

## Procedure

Let `ROOT = ~/Documents/software/experiments/golem` and `DEST = $ROOT/golem-projects/<name>`.

**1. Create the directory and copy the template.**

```
Bash(command: "mkdir -p ROOT/golem-projects/<name>")
Bash(command: "tar -C ROOT/substrate/templates/project-bootstrap/ -cf - . | tar -C DEST/ -xf -")
```

The `tar | tar` pipe copies the template tree (including dotfiles and `.gitkeep` markers) without a `cp -r` dotfile gap.

**2. Substitute placeholders.** Every template file carrying a `{{...}}` token must be filled. The tokens:

| Placeholder | Value |
|---|---|
| `{{PROJECT_NAME}}` | `<name>` |
| `{{STACK_PRIMARY}}` | `<stack_primary>` (or `tbd`) |
| `{{DATE}}` | `<date>` |

They appear in `CLAUDE.md`, `CONTEXT.md`, `README.md`, and `docs/` template files. Use `Edit` per file — do not shell-script a bulk `sed`.

**3. Make the hooks executable.**

```
Bash(command: "chmod +x DEST/.claude/hooks/*.sh")
```

The journal / guardrail / lint hooks must be executable or Claude Code silently skips them.

**4. Initialise git and commit the bootstrap.**

```
Bash(command: "git -C DEST init -b main")
Bash(command: "git -C DEST add -A")
Bash(command: "git -C DEST commit -m 'chore: substrate bootstrap'")
```

**5. Register the project.**

```
Bash(command: "golem project register DEST --name '<pretty>'")
```

For a project provisioned outside `golem-projects/` (rare for bootstrap; normal for retrofit), append `--kind external`.

## After this skill

Control returns to the CEO journey:

- The CEO runs the **claim → cd → dispatch** block: `golem session claim <name>`, move cwd inside `DEST`, then dispatch the first sub-agent.
- A.1 → run the `golem-ideation` pipeline inside the namespace.
- A.2 → dispatch the Substrator (B.1) for the full-harness lay-down.
- A.2-bootstrap → dispatch the Substrator, then skip B.2/B.3 and enter at B.4.

## Anti-patterns

- **Running this on an existing codebase.** That overwrites real files. Use `golem-retrofit`.
- **Bulk `sed` across the tree for placeholders.** Brittle and journals as one opaque Bash call — `Edit` per file.
- **Skipping `chmod +x`.** Hooks that are not executable are silently ignored; the project then journals nothing.
- **Dispatching a sub-agent before the CEO's cwd is inside `DEST`.** Journal routing walks `$PWD` to the nearest `CLAUDE.md` — sub-agents would journal to the wrong namespace.
- **Pre-loading tracker stories here.** That is the Substrator's output, not this skill's.
