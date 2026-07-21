import test from "node:test";
import { runOpenCodeAdapterJourney } from "./opencode-journey.mjs";

test("OpenCode provider coexistence and fenced lifecycle journey", async () => {
		await runOpenCodeAdapterJourney();
});
