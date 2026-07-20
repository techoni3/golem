# Real-process journey testing

`packages/testkit` owns the small, production-shaped test boundary for the selected J1–J8 journeys. It creates an isolated temporary `HOME`/`GOLEM_HOME`, allowlists only locale, timezone, temp, and executable-path environment values, starts detached child groups, and sends `SIGTERM` before a bounded `SIGKILL` fallback. Every created artifact must be contained by the supplied temporary root; cleanup removes that root.

`test/journeys/run.mjs` is the serial root runner. Its scenario registry names the journey, tier, and catastrophic regression protected by each check. It prints the versioned `golem-journey-summary/v1` projection in stable key and scenario order. Runtime port, PID, timestamp, path, UUID, and secret values are diagnostic-only: semantic comparison delegates to the GOL-24 legacy normalizer, which keeps readiness, lifecycle ordering, and identifier relationships meaningful.

The selected checks deliberately cross process, SQLite, HTTP, WebSocket, native executable, and headless Playwright boundaries. The legacy-baseline scenario is an invocation adapter over the frozen GOL-24 baseline; it is not a second implementation. The browser helper always launches headless with a fresh context and writes trace/screenshot artifacts only after a failed run.

`UNMET` is an explicit environment gate, not a pass. In particular, a sandbox that rejects `127.0.0.1` listeners with `EPERM` is reported separately from a product regression. `PASS` means the boundary actually completed; `FAIL` preserves a redacted diagnostic and a non-zero exit. The runner is serial by design so it owns no shared port, profile, user home, or process cleanup state.
