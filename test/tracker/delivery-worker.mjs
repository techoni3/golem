import path from "node:path";

import { composeControlPlaneTrackerServices } from "../../apps/control-plane/dist/tracker.js";
import { openControlPlanePersistence } from "../../apps/control-plane/dist/persistence.js";

const now = process.env.GOLEM_TRACKER_FIXTURE_NOW;
const runtimePath = process.env.GOLEM_RUNTIME_DB;
const trackerPath = process.env.GOLEM_TRACKER_DB;
const recipientId = process.env.GOLEM_TRACKER_FIXTURE_RECIPIENT;

if (!now || !runtimePath || !trackerPath || !recipientId) {
	process.stderr.write("delivery worker requires temporary database paths, recipient, and fixture clock\n");
	process.exit(64);
}

const at = (milliseconds) => new Date(Date.parse(now) + milliseconds).toISOString();
const endpoint = {
	recipientId,
	generationId: `gen_${recipientId}`,
	endpointId: `endpoint_${recipientId}`,
	ownerFence: 1,
	readiness: "ready",
	mode: "next_turn",
	capabilities: [
		{ capability: "delivery", qualification: "supported", observedAt: now },
	],
};
const owner = openControlPlanePersistence(
	{ runtimePath, trackerPath, lockPath: path.join(path.dirname(runtimePath), "owner.lock") },
	{ clock: { now: () => now, after: at }, ownerId: "delivery-crash-worker" },
);
const services = composeControlPlaneTrackerServices({
	writer: owner,
	eligibility: { resolve: (candidate) => (candidate === recipientId ? endpoint : undefined) },
	clock: { now: () => now, after: at },
});
const [claim] = services.delivery.claim("crash-worker", 1, 5_000);
if (!claim) {
	process.stderr.write("delivery worker found no envelope to claim\n");
	process.exit(65);
}
process.stdout.write(`${JSON.stringify({ envelope_id: claim.envelope.id, claim_token: claim.envelope.claimToken })}\n`);
// Deliberately bypass close(): the process boundary must leave a recoverable
// stale owner record and a replayable claimed envelope.
process.exit(0);
