---
name: codex-cli-upgrade
description: Read after a Codex CLI upgrade breaks golem — "Codex App Server is disabled", schema leaves changed, or every hook exits 1. Covers re-pinning the App Server schema contract and restaging the codex plugin. Not for substrate or skill edits, use golem:skill-authoring.
---

# Upgrading the Codex CLI under golem

A Codex upgrade can break golem in **two independent ways**. They have different symptoms, different
fixes, and neither one fixes the other. Work out which you have before changing anything.

| Symptom | Cause | Section |
|---|---|---|
| `Codex App Server is disabled: … schema leaves changed` | golem drives the App Server protocol directly and the protocol moved | § Re-pin the contract |
| Every hook reports `hook exited with code 1` | Codex's version-keyed plugin cache has no dir for the newly declared version | § Restage the plugin |
| Global rules missing from a Codex session | `$CODEX_HOME/AGENTS.md` block never rendered | `golem sync --target codex` |

## Re-pin the contract

`lib/codex-app-server-contract.js` pins a SHA per App Server schema leaf. It regenerates the schema
from the installed CLI on **every supervisor launch** and refuses to start if any leaf moved. That is
deliberate: golem sends `thread/start`, `thread/resume`, `turn/start`, `turn/steer` and answers
approval requests by hand, so a silently reshaped protocol means silently wrong frames.

**The CLI version is recorded, not gated.** An exact-version check used to run first and was removed
— it gated on a proxy for the thing the very next check measures directly, so every CLI update failed
even when the protocol was byte-identical. Do not reintroduce it.

```bash
node scripts/regen-codex-contract.mjs           # report which leaves moved
node scripts/regen-codex-contract.mjs --write   # re-pin, after reviewing
```

**The review between those two commands is the whole point.** Re-pinning without it converts a real
protocol break into a silent one. For each changed leaf, check the surface golem actually uses:

- `v2/ThreadStartParams` / `v2/ThreadResumeParams` — golem sends `cwd`, `sandbox`, `approvalPolicy`,
  `approvalsReviewer`, and `threadId` on resume. Confirm they still exist and that nothing golem
  omits became **required**.
- `v2/TurnStartParams` — golem sends `input` and `threadId`.
- `ExecCommandApprovalResponse` / `ApplyPatchApprovalResponse` — golem replies `{ decision }` with
  the plain strings `approved` / `denied` / `abort`. Confirm `ReviewDecision` still accepts a bare
  string; new object variants alongside it are fine.
- `ServerRequest` — golem recognises both the modern `item/*/requestApproval` names and the legacy
  `execCommandApproval` / `applyPatchApproval`. An unrecognised approval method is auto-declined, so
  a rename here breaks approvals **without any error**.

Additive change — new optional fields — is the normal case and is safe. A field becoming required, a
method being renamed, or an enum losing a value is not: fix `lib/codex-supervisor.js` first, then
re-pin.

Verify the gate actually passes before declaring done:

```bash
node -e 'import("./lib/codex-app-server-contract.js").then(({verifyCodexAppServerContract})=>console.log(verifyCodexAppServerContract({})))'
```

## Restage the plugin

Codex caches plugins under `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/`, keyed by the
version in the render's `.codex-plugin/plugin.json`. `golem sync` stamps that from the root
`package.json`. Bumping the golem version therefore points `${PLUGIN_ROOT}` at a cache dir Codex has
not staged, and **every hook fails with exit 1** — the hook script is fine, the path does not exist.

`codex plugin marketplace upgrade` does not help: it only refreshes **Git** marketplaces, and
golem-workspace is `local`.

```bash
codex plugin remove golem@golem-workspace && codex plugin add golem@golem-workspace
ls ~/.codex/plugins/cache/golem-workspace/golem/    # must list the current version
```

## Full sequence

```bash
node scripts/regen-codex-contract.mjs             # review the diff first
node scripts/regen-codex-contract.mjs --write
golem sync --target codex                         # bundle + $CODEX_HOME/AGENTS.md block
golem sync --target cc && golem sync --target cc --out ./plugin --force
npm test && npm run check
codex plugin remove golem@golem-workspace && codex plugin add golem@golem-workspace
```

## Gotchas

- **`~/.codex/AGENTS.md` is shared with the human.** golem owns only the marked block; text outside
  it is theirs. Adoption appends, never truncates — do not "clean up" that file by hand.
- **A passing `npm test` does not cover this.** `test/codex-supervisor.test.mjs` and
  `test/codex-app-server-spike.test.mjs` are deliberately outside the `npm test` list because they
  spawn real App Servers. Run them explicitly after re-pinning, and expect them to be slow.
- `test/codex-supervisor.test.mjs` has a known pre-existing failure at the
  `dispatchable by recency` assertion, unrelated to the contract. It was masked for a long time by
  the old version gate. Do not read it as your regression.
- **349 schemas are generated; 30 are pinned.** The contract tracks only the surface golem uses.
  A leaf appearing or vanishing outside that set is not golem's problem.
- The supervisor regenerates the schema on every launch by design — a cached fingerprint would turn
  the gate into a hint.
