import { registerScenario } from "@golem/testkit";

export const scenarios = [
	registerScenario({
		id: "domain-replay",
		journey: "J2",
		tier: "pr",
		regression: "cross-harness identity, lifecycle, ordering, fencing, or readiness drift creates ghosts or stale owners",
	}),
	registerScenario({
		id: "launcher-resolution-matrix",
		journey: "J7",
		tier: "pr",
		regression: "launch precedence, capability qualification, or JSONC preservation drifts before process spawn",
	}),
	registerScenario({
		id: "testkit-smoke",
		journey: "J3",
		tier: "pr",
		regression: "child restart loses SQLite-backed state or leaks a process group",
	}),
	registerScenario({
		id: "testkit-fake-harness",
		journey: "J5",
		tier: "pr",
		regression: "native harness argv, stdin, crash, duplicate output, or signal handling drifts",
	}),
	registerScenario({
		id: "native-spawn-safety",
		journey: "J5",
		tier: "integration",
		regression: "recursive or unsafe binary discovery, shell expansion, secret leakage, signal loss, or a leaked native child group",
	}),
	registerScenario({
		id: "launcher-signal-cleanup",
		journey: "J5",
		tier: "integration",
		regression: "signal, resize, timeout, or native descendant cleanup leaves an orphaned or misreported harness process",
	}),
	registerScenario({
		id: "testkit-semantic-parity",
		journey: "J6",
		tier: "pr",
		regression: "volatile observations hide a changed readiness or identity fact",
	}),
	registerScenario({
		id: "testkit-cleanup-drill",
		journey: "J3",
		tier: "integration",
		regression: "a failed assertion leaks child descendants or writes outside a temporary home",
	}),
	registerScenario({
		id: "sqlite-owner-migration-recovery",
		journey: "J3",
		tier: "pr",
		regression: "two SQLite writers, migration drift, or a crash loses a committed runtime event or makes tracker recovery unsafe",
	}),
	registerScenario({
		id: "materializer-crash-matrix",
		journey: "J3",
		tier: "pr",
		regression: "concurrent runtime producers, a killed materializer, or duplicate delivery loses canonical state or emits a second outbox effect",
	}),
	registerScenario({
		id: "dashboard-down-inbox-replay",
		journey: "J1",
		tier: "pr",
		regression: "a temporary management/tracker outage drops durable runtime work instead of bounded, idempotent replay",
	}),
	registerScenario({
		id: "delivery-queue-crash-matrix",
		journey: "J4",
		tier: "pr",
		regression: "a claimed durable envelope can be double-settled, lose a retry, or survive a child crash without replay",
	}),
	registerScenario({
		id: "bus-offline-replay",
		journey: "J4",
		tier: "pr",
		regression: "offline subscriptions lose ordered cursor replay, passive slots start unsolicited turns, or pruning drops manual interest",
	}),
	registerScenario({
		id: "testkit-browser",
		journey: "J8",
		tier: "release",
		regression: "browser checks reuse a signed-in profile or retain success artifacts",
	}),
	registerScenario({
		id: "control-plane-auth-ws-lifecycle",
		journey: "J6",
		tier: "integration",
		regression: "the typed control plane accepts an unsafe caller, loses revision resync, serves no dashboard shell, or leaks its service lock",
	}),
	registerScenario({
		id: "legacy-parity-baseline",
		journey: "J4",
		tier: "integration",
		regression: "legacy dashboard/SQLite/REST/WebSocket/MCP dispatch parity disappears before cutover",
	}),
	registerScenario({
		id: "render-mcp-closure",
		journey: "J1",
		tier: "integration",
		regression: "a render drifts, clobbers a tampered target, rolls back poorly, or ships an MCP that needs the checkout dependency tree",
	}),
];
