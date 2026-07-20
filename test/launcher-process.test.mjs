import test from "node:test";

import {
	exerciseLauncherSignalCleanup,
	exerciseNativeSpawnSafety,
} from "./journeys/native-spawn-safety.mjs";

test("J5 fake native process safely discovers, spawns, signals, and cleans up", async () => {
	await exerciseNativeSpawnSafety();
	await exerciseLauncherSignalCleanup();
});
