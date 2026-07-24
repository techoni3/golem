import test from "node:test";

import {
	runCanonicalCutoverCrashRollback,
	runLegacyWriterGuard,
} from "./replay.mjs";

test("C4 cutover resumes after crash and rolls back without loss", async () => {
	await runCanonicalCutoverCrashRollback();
});

test("C4 preflight and retired legacy writer guards fail closed", async () => {
	await runLegacyWriterGuard();
});
