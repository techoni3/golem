import test from "node:test";

import { runLauncherResolutionReplay } from "./launcher/replay.mjs";

test("J7 deterministic launcher resolution preserves configuration and capability truth", async () => {
	await runLauncherResolutionReplay();
});
