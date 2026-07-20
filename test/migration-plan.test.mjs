import test from "node:test";

import { runMigrationPlanReplay } from "./migration/replay.mjs";

test("J7 deterministic migration audit keeps legacy homes immutable", async () => {
	await runMigrationPlanReplay();
});
