import test from "node:test";

import { runMigrationApplyReplay } from "./migration/apply-replay.mjs";

test("J7 migration apply imports only strong evidence and restores after failure", async () => {
	await runMigrationApplyReplay();
});
