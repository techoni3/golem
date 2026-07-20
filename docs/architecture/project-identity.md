# Stable project identity and location evidence

`packages/runtime/src/projects` is the filesystem/Git evidence adapter and
`ProjectService` command boundary. It canonicalizes an explicit cwd with
`realpath`, asks Git for `--show-toplevel` and `--git-common-dir` without shell
interpolation, and keeps discovery separate from persistence. A nested path
uses its repository root; linked worktrees use the common-dir identity key but
retain their own canonical location row.

Git roots auto-register. A non-Git directory is only registered when it has a
`.golem-project` marker or the caller uses the explicit `register` command.
`/`, the user home, and the configured Golem home are rejected as broad roots.
Ambiguous path/common-dir evidence returns a diagnostic and never merges
projects. Explain output includes only the selected root/evidence and a safe
remedy, not unrelated candidates.

The runtime owner exposes `RuntimeProjectStorage` as a typed capability. The
control-plane composition exports `composeControlPlaneProjectService`, which
adapts that capability without exposing SQLite handles or adding routes in this
wave. An observation transaction deduplicates the event, allocates an opaque
`prj_` id once, persists project/location metadata, aliases, identity keys,
state, provenance, and a management outbox effect together. A canonical path is
globally unique; a relocation explicitly attaches a second location and may
retire the old one without changing the project UUID. Manual names are marked
as `register` provenance and later hook/Git observations cannot overwrite them.
Legacy `projects.json` remains an import/compare source; no project service
write mutates it.

The two J2 journeys use real temporary Git repositories, linked worktrees,
clone relocation, independent producer processes writing the durable runtime
inbox, the actual SQLite owner, and post-write cleanup assertions.
