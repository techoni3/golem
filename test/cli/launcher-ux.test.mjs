import test from "node:test";
import { exerciseCompactLauncherMatrix } from "../journeys/compact-launcher-matrix.mjs";

test("GOL-53 compact launcher UX matrix", async () => {
	await exerciseCompactLauncherMatrix();
});
