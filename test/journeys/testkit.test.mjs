import test from "node:test";

import { diagnosticFor, exerciseBrowser, exerciseCleanupDrill, exerciseFakeHarness, exerciseSemanticParity, exerciseSmoke, isLoopbackUnavailable } from "./exercise.mjs";

async function journey(t, exercise) {
	try {
		await exercise();
	} catch (error) {
		if (isLoopbackUnavailable(error)) {
			t.skip(`UNMET sandbox loopback gate: ${diagnosticFor(error)}`);
			return;
		}
		throw error;
	}
}

test("J3 real service keeps SQLite state across a process restart and kills its child group", async (t) => {
	await journey(t, exerciseSmoke);
});

test("J5 native fixture preserves argv, stdin, crash, delayed readiness, duplicate output, and SIGTERM", async (t) => {
	await journey(t, exerciseFakeHarness);
});

test("J6 semantic parity normalizes GOL-24 volatility without hiding readiness changes", async (t) => {
	await journey(t, exerciseSemanticParity);
});

test("J3 forced assertion cleanup contains artifacts and terminates descendants", async (t) => {
	await journey(t, exerciseCleanupDrill);
});

test("J8 headless Playwright uses a fresh context and keeps success artifacts empty", async (t) => {
	await journey(t, exerciseBrowser);
});
