# Contributing

Use Node.js 24.18.x and npm 11.16.x. Start from the single root lock:

```sh
npm ci
npm run build
npm run check
```

Root development uses TypeScript 7.0.2. The private
`tools/openapi-codegen` workspace deliberately owns TypeScript 5.9.3 and
`openapi-typescript` 7.13.0 for generator compatibility; do not add a second
lockfile or peer-bypass flag. That toolchain is development-only.

Make canonical plugin/skill changes in `substrate/`, never in generated
`plugin/` or `~/.golem/renders/` output. Build code under `apps/` and
`packages/`; `scripts/build-release-artifacts.mjs` produces the relocatable
`dist/release/` package boundary. See
`docs/contributing/development.md` and `docs/architecture/release-package.md`.

Before opening a pull request, run the narrow journey for the changed contract
plus:

```sh
npm run build
npm run check
npm run docs:check
npm pack --dry-run
git diff --check
```

Packaging changes additionally require `npm run verify:package` and
`npm run verify:render`. Use disposable `HOME`, `GOLEM_HOME`,
`XDG_CONFIG_HOME`, ports, databases, and renders. Never include secrets,
journals, tracker databases, private paths, or live-home evidence. Describe the
behavioral change, exact commands/exits, privacy or permission impact, migration
and rollback, and any residual risk.

Use focused branches and conventional commits. Parallel work uses a worktree
only when its tracker dispatch explicitly says `workspace: worktree`.
Contributions are licensed under MIT.
