import test from "node:test";
import { runOpenCodeComposedJourney } from "./opencode-composed-journey.mjs";
import {
	runOpenCodeAdapterJourney,
	runOpenCodeResumeBridgeJourney,
} from "./opencode-journey.mjs";

test("OpenCode adapter maps lifecycle, config, providers, and child exclusion", async () => {
	await runOpenCodeAdapterJourney();
});

test("OpenCode adapter retries a fenced bridge and rejects stale delivery", async () => {
	await runOpenCodeResumeBridgeJourney();
});

test("OpenCode composed lifecycle, fenced delivery, and direct launch journey", async () => {
		await runOpenCodeComposedJourney();
});
