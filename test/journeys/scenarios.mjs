import { registerScenario } from "@golem/testkit";

export const scenarios = [
	registerScenario({
		id: "domain-replay",
		journey: "J2",
		tier: "pr",
		regression: "cross-harness identity, lifecycle, ordering, fencing, or readiness drift creates ghosts or stale owners",
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
		id: "testkit-browser",
		journey: "J8",
		tier: "release",
		regression: "browser checks reuse a signed-in profile or retain success artifacts",
	}),
	registerScenario({
		id: "legacy-parity-baseline",
		journey: "J4",
		tier: "integration",
		regression: "legacy dashboard/SQLite/REST/WebSocket/MCP dispatch parity disappears before cutover",
	}),
];
