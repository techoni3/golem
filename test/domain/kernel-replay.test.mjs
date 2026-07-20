import test from "node:test";

import { runDomainReplay } from "./replay.mjs";

test("J2 deterministic domain replay prevents identity, lifecycle, and readiness regressions", () => {
	runDomainReplay();
});
