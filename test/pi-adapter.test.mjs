import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	PiLifecycleEmitter,
	PiNextTurnInbox,
	createPiControlApi,
	importLegacyPiInbox,
	pullForRealUserTurn,
	settleAfterPiAgentStart,
} from "../packages/adapters/pi/dist/index.js";
import { inspectLegacyPiInbox } from "../lib/pi-inbox.js";

const binding = Object.freeze({
	projectId: "prj_00000000-0000-4000-8000-000000000051",
	sessionId: "ses_00000000-0000-4000-8000-000000000051",
	generationId: "gen_00000000-0000-4000-8000-000000000051",
	endpointId: "ep_00000000-0000-4000-8000-000000000051",
	ownerFence: "1",
	producerInstanceId: "prod_00000000-0000-4000-8000-000000000051",
});

test("Pi lifecycle is strongly bound to one canonical generation and never advertises push", () => {
	const emitter = new PiLifecycleEmitter(binding);
	const started = emitter.emit({
		event: "started",
		observedAt: "2026-07-21T00:00:00.000Z",
		metadata: { name: "Pi session", model: "pi-model" },
	});
	assert.deepEqual(
		started.map((signal) => signal.event_kind),
		["session.started", "endpoint.claimed", "capabilities.reported"],
	);
	assert.deepEqual(started[0].payload.generation, {
		project_id: binding.projectId,
		session_id: binding.sessionId,
		generation_id: binding.generationId,
	});
	const endpoint = started[1].payload.endpoint;
	assert.equal(endpoint.delivery_mode, "next_turn");
	assert.equal(endpoint.readiness, "next_turn");
	assert.equal(endpoint.owner_fence, binding.ownerFence);
	const capability = started[2].payload.capabilities[0];
	assert.equal(capability.delivery_mode, "next_turn");
	assert.equal(capability.reason_code, "real_user_turn_required");
	assert.equal(/push/u.test(JSON.stringify(started)), false, "canonical capability facts contain no push claim");
	const resumed = emitter.emit({ event: "resumed", observedAt: "2026-07-21T00:00:01.000Z" });
	assert.equal(resumed[0].payload.kind, "session.resumed");
	assert.deepEqual(resumed[0].payload.generation, started[0].payload.generation, "resume retains the supplied generation instead of deriving a ghost alias");
});

test("Pi next-turn transport only claims on a real user turn and recovers one fenced crash safely", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "golem-pi-adapter-"));
	let now = 1_000;
	const inbox = new PiNextTurnInbox({
		home,
		binding,
		now: () => now,
		claimLeaseMs: 100,
		maxAttempts: 2,
	});
	const requests = [];
	const remote = {
		id: "delivery-51",
		claimToken: "claim-51",
		payload: { text: "Take the next real turn." },
		endpoint: { ownerFence: binding.ownerFence, generationId: binding.generationId },
	};
	const api = createPiControlApi({
		transport: "openapi-fetch",
		caller: { projectId: binding.projectId, sessionId: binding.sessionId },
		async request(input) {
			requests.push(input);
			if (input.path === "/api/v1/delivery/claims")
				return { status: 200, body: { schema_version: "golem.api-page/v1", items: [remote] } };
			if (input.path.endsWith("/prepare"))
				return { status: 200, body: { schema_version: "golem.api-command-outcome/v1", result: { kind: "deliver", envelope: remote } } };
			if (input.path.endsWith("/ack") || input.path.endsWith("/delivered"))
				return { status: 200, body: { schema_version: "golem.api-command-outcome/v1", result: {} } };
			throw new Error(`unexpected typed request ${input.path}`);
		},
	});
	try {
		assert.deepEqual(inbox.diagnostics(), {
			pending: 0,
			processing: 0,
			acknowledgements: 0,
			deadLetters: 0,
			retrying: 0,
		}, "no timer or background producer creates an unsolicited Pi turn");
		const first = await pullForRealUserTurn({ control: api, inbox, binding });
		assert.equal(first.length, 1, "the real user input boundary claims exactly one delivery");
		assert.equal(first[0].text, "Take the next real turn.");
		assert.deepEqual(inbox.diagnostics(), {
			pending: 0,
			processing: 1,
			acknowledgements: 0,
			deadLetters: 0,
			retrying: 0,
		});
		assert.equal(
			inbox.stage({ deliveryId: "delivery-51", claimToken: "claim-51", text: "Take the next real turn." }),
			"already_staged",
			"a retry cannot relink immutable published bytes while Pi owns processing",
		);
		assert.equal(inbox.diagnostics().pending, 0, "in-flight ownership prevents a second same-turn pickup");
		now += 101;
		assert.deepEqual(inbox.recover(), { reclaimed: 1, deadLettered: 0 }, "a killed extension returns its expired in-flight turn to pending exactly once");
		const second = inbox.claimForRealUserTurn();
		assert.equal(second.length, 1);
		assert.equal(second[0].attempt, 2, "replayed turn keeps a bounded attempt number");
		await settleAfterPiAgentStart({ control: api, inbox, turns: second });
		assert.deepEqual(inbox.diagnostics(), {
			pending: 0,
			processing: 0,
			acknowledgements: 0,
			deadLetters: 0,
			retrying: 0,
		}, "acknowledgement and delivery settle after Pi starts work, not before input");
		assert.deepEqual(
			requests.map((request) => request.path),
			[
				"/api/v1/delivery/claims",
				"/api/v1/delivery/claims/claim-51/prepare",
				"/api/v1/delivery/claims/claim-51/ack",
			],
			"the portable adapter uses only typed pull/prepare/terminal-ack control-plane calls",
		);
		assert.equal(requests.some((request) => /push|prompt|inject/iu.test(request.path)), false);

		const stale = new PiNextTurnInbox({
			home,
			binding: { ...binding, ownerFence: "2" },
			now: () => now,
		});
		stale.stage({ deliveryId: "stale-51", claimToken: "claim-stale", text: "must not deliver" });
		const oldFence = new PiNextTurnInbox({ home, binding, now: () => now });
		assert.deepEqual(oldFence.claimForRealUserTurn(), [], "old fence cannot pick a newly fenced next-turn item");
		assert.equal(oldFence.diagnostics().deadLetters, 1, "refused stale work remains visible as dead-letter evidence");

		const legacyPending = path.join(home, "pi-inbox", "legacy-pi-51", "pending");
		fs.mkdirSync(legacyPending, { recursive: true });
		fs.writeFileSync(path.join(legacyPending, "bound.json"), JSON.stringify({
			message_id: "legacy-51",
			text: "migrate only with strong binding",
			metadata: { claim_token: "legacy-claim", canonical_binding: {
				project_id: binding.projectId,
				session_id: binding.sessionId,
				generation_id: binding.generationId,
				endpoint_id: binding.endpointId,
				owner_fence: binding.ownerFence,
			} },
		}));
		fs.writeFileSync(path.join(legacyPending, "ambiguous.json"), JSON.stringify({ message_id: "ambiguous-51", text: "do not infer me", metadata: {} }));
		assert.deepEqual(
			inspectLegacyPiInbox({
				home,
				canonicalBinding: {
					project_id: binding.projectId,
					session_id: binding.sessionId,
					generation_id: binding.generationId,
					endpoint_id: binding.endpointId,
					owner_fence: binding.ownerFence,
				},
			}),
			{
				importable: [{ session_id: "legacy-pi-51", message_id: "legacy-51" }],
				ambiguous: [{ session_id: "legacy-pi-51", message_id: "ambiguous-51" }],
			},
			"compatibility inventory preserves ambiguous legacy files as diagnostics",
		);
		assert.deepEqual(
			importLegacyPiInbox({ home, legacySessionId: "legacy-pi-51", binding, inbox: oldFence }),
			{ imported: ["legacy-51"], ambiguous: ["ambiguous"] },
			"only an exact generation/fence binding imports into the canonical Pi queue",
		);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
		assert.equal(fs.existsSync(home), false, "the Pi journey removes its isolated GOLEM_HOME");
	}
});
