import test from "node:test";
import { runOpenCodeComposedJourney } from "./opencode-composed-journey.mjs";

test("OpenCode composed lifecycle, fenced delivery, and direct launch journey", async () => {
		await runOpenCodeComposedJourney();
});
