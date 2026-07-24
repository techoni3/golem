# Release readiness checklist

Verified 2026-07-13 for `@laveesingh/golem` 5.0.16 on Node.js 22.22.3 and npm
10.9.8. This is a verification record, not a publication or tag.

## Verdict

**Release-ready.** The isolated test, production dashboard, browser, packed
install/render, and native-harness matrix passes. The public support boundaries
are in the README support matrix.

## Mechanical checklist

- [x] `npm test` — exit 0; session facts/endpoint leases (16 assertions), Codex
  native 0.144.1 and bundled MCP, Pi Tier B/pickup and TrackerDB lease journeys,
  OpenCode shim/passive delivery, compiler enforcement, and channel tracker
  journey all passed.
- [x] `npm run dashboard:build` — exit 0; Vite transformed 3,699 modules and
  produced the local production bundle.
- [x] `npm run test:dashboard:browser` — exit 0; isolated ephemeral Chrome and
  a dynamically allocated dashboard port passed the seeded journey, including
  dispatch, sanitization, modal accessibility, session facts, and all 76 dist
  assets free of runtime CDN/Babel references.
- [x] `npm run test:release` — exit 0; a fresh tarball was installed under a
  temporary HOME/GOLEM_HOME/XDG_CONFIG_HOME, then Claude Code, marketplace,
  OpenCode, Codex, and Pi renders completed on isolated port 17421.
- [x] `npm pack --dry-run --json` — 249 files; LICENSE, README, PRIVACY,
  SECURITY, CONTRIBUTING, dashboard production output, and CLI entry point are
  present.
- [x] Repository scans — no `/Users/...` developer paths in public source/docs,
  no runtime CDN/Babel references in `dashboard/dist`, no common private-key,
  AWS, GitHub-token, or OpenAI-key signatures, and `git diff --check` passed.

## Environment and residual non-blockers

- Claude Code 2.1.207, OpenCode 1.17.18, and Codex CLI 0.144.1 were present.
- Pi was not installed, so the portable Tier B adapter and production pickup
  contract were exercised by the isolated journey rather than a native Pi CLI.
- Substrate lint emitted three existing orphan-skill warnings for
  `get-consult`, `journaling`, and `provide-consult`; enforcement and tests
  still passed.
- The working tree and this report commit pass `git diff --check`. Running it
  across the complete umbrella range reports trailing spaces embedded in
  generated Vite vendor assets; these are build output, not source or a
  release-behavior failure.
