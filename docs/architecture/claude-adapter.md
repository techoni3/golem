# Claude adapter boundary

`packages/adapters/claude` is the storage-free Claude Code adapter. Hook payloads are reduced to validated `@golem/contracts` runtime signals; prompt text, credentials, and arbitrary hook fields never cross the adapter boundary. The injected signal sink owns durable ingestion and the canonical project/session/generation facts.

The channel owner claims a generation-scoped `native_channel` endpoint through the injected endpoint port. A valid protocol/session/secret handshake only moves the endpoint to `held_waiting`; readiness becomes `ready` after an addressed `golem.claude.consumed/v1` marker with Claude/model versions. Fences and endpoint responses remain canonical service authority, and release is routed through the same port.

`qualifyClaude` separates launchability from delivery: an unavailable executable is `unsupported`; a launchable process without real addressed consumption is `unknown`/`pull_only`; only observed consumption is `supported`/`ready`. The qualification runner probes `claude --version` with a redacted environment and never claims model or channel success. Render and launch contributions are declarative; compiler output remains generated from `substrate/` and user settings are not rewritten.
