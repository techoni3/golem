# Release readiness checklist

Candidate: `@laveesingh/golem` 5.1.1, GOL-59/GOL-60 rebuild gate.
Certified toolchain: Node.js 24.18.x, npm 11.16.x, TypeScript 7.0.2 with
private codegen TypeScript 5.9.3.

This is a reproducible verification record, not a publication or tag. A release
is eligible only when every required command below exits zero and the generated
GOL-60 report records no required parity gap.

## Package contract

- The positive tarball allowlist contains compiled release ESM, CLI/runtime
  helpers, static dashboard, substrate/manifests/shims, the relocatable MCP
  artifact, documentation, and licenses.
- Private workspace source/symlinks, TypeScript, OpenAPI codegen, dev tools,
  Playwright, `mcp/channel`, nested `node_modules`, and checkout paths are
  absent.
- Postinstall validates Node, artifact checksums, exact
  `better-sqlite3@12.11.1`, and an in-memory query. It remains stopped and does
  not create Golem state.
- Setup, harness render/install, service control, data migration/cutover,
  package update, and rollback are explicit operations.

## Mechanical gate

```sh
npm ci
npm run build
npm run check
npm run api:check
npm run verify:package
npm run verify:render
npm run test:journey -- --scenario install-update-rollback
npm run docs:check
npm pack --dry-run
golem sync --check --all
git diff --check
```

The final J1–J8 orchestration additionally runs:

```sh
npm run test:acceptance -- --matrix J1,J2,J3,J4,J5,J6,J7,J8 --artifact packed
npm run test:browser -- --project acceptance
npm run test:legacy-baseline
npm run parity:report -- --require-zero-gaps
```

Evidence records exact commands, exit codes, decisive scenario counts/logs,
artifact SHA-256, Node/addon/SQLite/platform versions, failure-only sanitized
browser artifacts, and residual risks. Tests use disposable homes, caches,
ports, databases, configs, services, and renders.

## Support boundaries

Cold macOS arm64 and x64 jobs must independently load the exact native addon
and exercise SQLite WAL/restart/integrity. Air-gapped native installation is
unsupported unless the matching prebuild or compiler toolchain is already
cached. A missing harness binary, credential, daemon, model, or verified
consumption path is reported as unavailable/unqualified; it is never converted
into a fabricated pass.
