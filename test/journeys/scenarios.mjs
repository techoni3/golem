import { registerScenario } from "@golem/testkit";

export const scenarios = [
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
];
