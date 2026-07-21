import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createFetchApiClient } from "../../packages/api-client/dist/index.js";
import {
	PiNextTurnInbox,
	createPiControlApi,
	pullForRealUserTurn,
	settleAfterPiAgentStart,
} from "../../packages/adapters/pi/dist/index.js";
import {
	composeControlPlaneTrackerCoreServices,
	composeControlPlaneTrackerServices,
} from "../../apps/control-plane/dist/tracker.js";
import { openControlPlanePersistence } from "../../apps/control-plane/dist/persistence.js";
import { startControlPlane } from "../../apps/control-plane/dist/server.js";
import { createTemporaryHome } from "@golem/testkit";

const binding = Object.freeze({
	projectId: "prj_00000000-0000-4000-8000-000000000051",
	sessionId: "ses_00000000-0000-4000-8000-000000000051",
	generationId: "gen_00000000-0000-4000-8000-000000000051",
	endpointId: "ep_00000000-0000-4000-8000-000000000051",
	// Runtime wire fences are strings; tracker delivery persists the same issued
	// endpoint fence as an integer. The adapter carries its canonical string
	// representation, while control-plane eligibility owns the numeric form.
	ownerFence: "1",
	producerInstanceId: "prod_00000000-0000-4000-8000-000000000051",
});

function fixtureClock() {
	let current = "2026-07-21T00:00:00.000Z";
	return Object.freeze({
		now: () => current,
		after: (milliseconds) =>
			new Date(Date.parse(current) + milliseconds).toISOString(),
	});
}

function headers(token) {
	return {
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
		"x-golem-caller-project": binding.projectId,
		"x-golem-caller-session": "ses_00000000-0000-4000-8000-000000000052",
		"x-golem-caller-actor": "act_00000000-0000-4000-8000-000000000052",
	};
}

async function enqueue(origin, token, id) {
	const response = await fetch(`${origin}/api/v1/delivery/envelopes`, {
		method: "POST",
		headers: headers(token),
		body: JSON.stringify({
			id,
			idempotency_key: `idempotency-${id}`,
			recipient_id: binding.sessionId,
			kind: "ticket_dispatch",
			payload: { text: `Pi durable ${id}` },
		}),
	});
	assert.equal(response.status, 201, await response.text());
}

/** J4: real HTTP + SQLite delivery and Pi's local crash/replay boundary. */
export async function exercisePiNextTurnCrashReplay() {
	const home = createTemporaryHome("golem-pi-next-turn-");
	const token = "golem-pi-next-turn-token-000000000000";
	const staticDirectory = path.join(home.root, "static");
	fs.mkdirSync(staticDirectory, { recursive: true });
	fs.writeFileSync(path.join(staticDirectory, "index.html"), "<!doctype html><title>pi</title>\n");
	let fence = 1;
	const clock = fixtureClock();
	const writer = openControlPlanePersistence(
		{
			runtimePath: home.runtimeDb,
			trackerPath: home.trackerDb,
			lockPath: path.join(home.root, "owner.lock"),
		},
		{ clock, ownerId: "pi-next-turn-journey" },
	);
	const core = composeControlPlaneTrackerCoreServices({ writer, clock });
	const services = composeControlPlaneTrackerServices({
		writer,
		clock,
		eligibility: {
			resolve(recipientId) {
				if (recipientId !== binding.sessionId) return undefined;
				return {
					recipientId,
					generationId: binding.generationId,
					endpointId: binding.endpointId,
					ownerFence: fence,
					readiness: "ready",
					mode: "next_turn",
					capabilities: [
						{
							capability: "delivery",
							qualification: "supported",
							observedAt: clock.now(),
						},
					],
				};
			},
		},
	});
	let service;
	const trace = [];
	try {
		service = await startControlPlane({
			token,
			stateDirectory: path.join(home.root, "control-plane"),
			staticDirectory,
			trackerCore: core,
			trackerServices: services,
		});
		const transport = createFetchApiClient(service.origin, {
				bearerToken: token,
				caller: { projectId: binding.projectId, sessionId: binding.sessionId },
			});
		const api = createPiControlApi({
			...transport,
			async request(input) {
				const response = await transport.request(input);
				trace.push({ path: input.path, status: response.status, body: response.body });
				return response;
			},
		});
		let now = 1_000;
		const inbox = new PiNextTurnInbox({
			home: home.golemHome,
			binding,
			now: () => now,
			claimLeaseMs: 100,
		});
		await enqueue(service.origin, token, "pi-crash-51");
		assert.equal(inbox.diagnostics().pending, 0, "queued delivery does not manufacture an unsolicited Pi turn");
		const first = await pullForRealUserTurn({ control: api, inbox, binding });
		assert.equal(first.length, 1, `only a real input boundary pulls the claimed envelope: ${JSON.stringify(trace)}`);
		assert.equal(first[0].text, "Pi durable pi-crash-51");
		now += 101;
		assert.deepEqual(inbox.recover(), { reclaimed: 1, deadLettered: 0 }, "killed Pi processing returns exactly one leased file to pending");
		const replay = inbox.claimForRealUserTurn();
		assert.equal(replay.length, 1);
		assert.equal(replay[0].attempt, 2, "replayed next-turn delivery preserves its bounded attempt");
		try {
			await settleAfterPiAgentStart({ control: api, inbox, turns: replay });
		} catch (error) {
			throw new Error(`Pi settlement failed: ${error instanceof Error ? error.message : String(error)}; trace=${JSON.stringify(trace.map((row) => ({ path: row.path, status: row.status, code: row.body?.code })))}`);
		}
		assert.equal(inbox.diagnostics().acknowledgements, 0, "typed ack/delivered settlement removes only the current local acknowledgement");

		await enqueue(service.origin, token, "pi-stale-51");
		fence = 2;
		assert.deepEqual(await pullForRealUserTurn({ control: api, inbox, binding }), [], "prepare rejects a changed endpoint fence before Pi can render a stale prompt");
		assert.equal(inbox.diagnostics().pending, 0, "stale claim never reaches local pending transport");
		return "real Fastify/SQLite delivery waits for user input, recovers one killed Pi processing lease, settles a terminal typed acknowledgement, and rejects a changed endpoint fence";
	} finally {
		if (service) await service.close();
		await writer.close();
		home.cleanup();
		assert.equal(fs.existsSync(home.root), false, "Pi J4 journey leaves no shared-home state");
	}
}
