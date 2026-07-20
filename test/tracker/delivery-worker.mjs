import fs from "node:fs";
import path from "node:path";

import { composeControlPlaneTrackerServices } from "../../apps/control-plane/dist/tracker.js";
import { openControlPlanePersistence } from "../../apps/control-plane/dist/persistence.js";

const now = process.env.GOLEM_TRACKER_FIXTURE_NOW;
const trackerPath = process.env.GOLEM_TRACKER_DB;
const root = process.env.GOLEM_TRACKER_FIXTURE_ROOT;
const worker = process.env.GOLEM_TRACKER_FIXTURE_WORKER;
const barrier = process.env.GOLEM_TRACKER_FIXTURE_BARRIER;
if (!now || !trackerPath || !root || !worker || !barrier) process.exit(64);
const until = Date.now() + 5_000;
while (!fs.existsSync(barrier) && Date.now() < until) {}
const clock = { now: () => now, after: (milliseconds) => new Date(Date.parse(now) + milliseconds).toISOString() };
const owner = openControlPlanePersistence({ runtimePath: path.join(root, `${worker}.runtime.db`), trackerPath, lockPath: path.join(root, `${worker}.owner.lock`) }, { clock, ownerId: worker });
try {
	const services = composeControlPlaneTrackerServices({ writer: owner, clock, eligibility: { resolve: (recipientId) => ({ recipientId, generationId: `gen_${recipientId}`, endpointId: `endpoint_${recipientId}`, ownerFence: 1, readiness: "ready", mode: "next_turn", capabilities: [{ capability: "delivery", qualification: "supported", observedAt: now }] }) } });
	const [claim] = services.delivery.claim(worker, 1, 5_000);
	process.stdout.write(`${JSON.stringify({ claimed: Boolean(claim), id: claim?.envelope.id ?? null })}\n`);
} finally { await owner.close(); }
