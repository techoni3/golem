import path from "node:path";

import { composeControlPlaneTrackerServices } from "../../apps/control-plane/dist/tracker.js";
import { openControlPlanePersistence } from "../../apps/control-plane/dist/persistence.js";

const now = process.env.GOLEM_TRACKER_FIXTURE_NOW;
const trackerPath = process.env.GOLEM_TRACKER_DB;
const root = process.env.GOLEM_TRACKER_FIXTURE_ROOT;
const worker = process.env.GOLEM_TRACKER_FIXTURE_WORKER;
if (!now || !trackerPath || !root || !worker || !process.send) process.exit(64);
const clock = { now: () => now, after: (milliseconds) => new Date(Date.parse(now) + milliseconds).toISOString() };
const owner = openControlPlanePersistence({ runtimePath: path.join(root, `${worker}.runtime.db`), trackerPath, lockPath: path.join(root, `${worker}.owner.lock`) }, { clock, ownerId: worker });
const services = composeControlPlaneTrackerServices({ writer: owner, clock, eligibility: { resolve: (recipientId) => ({ recipientId, generationId: `gen_${recipientId}`, endpointId: `endpoint_${recipientId}`, ownerFence: 1, readiness: "ready", mode: "next_turn", capabilities: [{ capability: "delivery", qualification: "supported", observedAt: now }] }) } });
process.send({ type: "READY", worker });
process.once("message", async (message) => {
	if (message?.type !== "RELEASE") return;
	const [claim] = services.delivery.claim(worker, 1, 5_000);
	process.send?.({ type: "CLAIM", worker, claimed: Boolean(claim), id: claim?.envelope.id ?? null });
	if (!claim) { await owner.close(); process.exit(0); }
	await new Promise(() => {});
});
