import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { invokeMcpTool } from "../../packages/mcp-adapter/dist/index.js";
import { createFetchApiClient } from "../../packages/api-client/dist/index.js";
import { composeControlPlaneTrackerCoreServices, composeControlPlaneTrackerServices } from "../../apps/control-plane/dist/tracker.js";
import { openControlPlanePersistence } from "../../apps/control-plane/dist/persistence.js";
import { startControlPlane } from "../../apps/control-plane/dist/server.js";
import { createTemporaryHome } from "@golem/testkit";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function fixtureClock() {
	let current = "2026-07-21T00:00:00.000Z";
	return Object.freeze({
		now: () => current,
		after: (milliseconds) => new Date(Date.parse(current) + milliseconds).toISOString(),
		advance: (milliseconds) => { current = new Date(Date.parse(current) + milliseconds).toISOString(); return current; },
	});
}

async function withControlPlane(run, eligibility = undefined) {
	const home = createTemporaryHome("golem-gol43-api-");
	const staticRoot = path.join(home.root, "static");
	fs.mkdirSync(staticRoot, { recursive: true });
	fs.writeFileSync(path.join(staticRoot, "index.html"), "<!doctype html><title>typed-api</title>\n");
	const token = "golem-gol43-api-token-000000000000";
	const clock = fixtureClock();
	const writer = openControlPlanePersistence({
		runtimePath: home.runtimeDb,
		trackerPath: home.trackerDb,
		lockPath: path.join(home.root, "owner.lock"),
	}, { clock, ownerId: "gol43-api-journey" });
	const core = composeControlPlaneTrackerCoreServices({ writer, clock });
	const services = composeControlPlaneTrackerServices({
		writer,
		clock,
		eligibility: eligibility ?? { resolve: () => undefined },
	});
	let service;
	try {
		service = await startControlPlane({ token, stateDirectory: path.join(home.root, "control-plane"), staticDirectory: staticRoot, trackerCore: core, trackerServices: services });
		return await run({ home, token, clock, writer, core, services, service, origin: service.origin });
	} finally {
		if (service) await service.close();
		await writer.close();
		home.cleanup();
		assert.equal(fs.existsSync(home.root), false, "typed API journey removes temporary GOLEM_HOME");
	}
}

function headers(token, caller = { project: "prj_gol43", session: "ses_gol43", actor: "ses_gol43" }) {
	return {
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
		"x-golem-caller-project": caller.project,
		"x-golem-caller-session": caller.session,
		"x-golem-caller-actor": caller.actor,
	};
}

async function json(response) {
	return { status: response.status, body: await response.json() };
}

export async function exerciseTrackerHttpMcpParity() {
	return withControlPlane(async ({ token, service, origin }) => {
		const caller = { projectId: "prj_gol43", sessionId: "ses_gol43" };
		const client = createFetchApiClient(origin, { bearerToken: token, caller });
		const created = await invokeMcpTool(client, "ticket_create", { title: "typed parity ticket", body: "MCP delegates through the typed tracker API." });
		assert.equal(created.isError, undefined, "MCP create delegates successfully");
		const createdBody = JSON.parse(created.content[0].text);
		assert.equal(createdBody.status, "completed");
		const ticket = createdBody.result;
		assert.equal(ticket.project_id, "prj_gol43");
		const listed = await json(await fetch(`${origin}/api/v1/tracker/tickets`, { headers: headers(token) }));
		assert.equal(listed.status, 200);
		assert.equal(listed.body.schema_version, "golem.api-page/v1");
		assert.equal(listed.body.items.some((item) => item.id === ticket.id), true, "HTTP list sees MCP-created ticket");
		const legacy = await json(await fetch(`${origin}/api/tickets`, { headers: { authorization: `Bearer ${token}` } }));
		assert.equal(legacy.status, 200, "legacy route remains available as a delegate");
		assert.equal(legacy.body.some((item) => item.id === ticket.id), true, "legacy and typed views converge");
		const conflict = await json(await fetch(`${origin}/api/v1/tracker/tickets/${ticket.id}`, { method: "PATCH", headers: headers(token), body: JSON.stringify({ expected_revision: 1, title: "stale" }) }));
		assert.equal(conflict.status, 409, "stale optimistic revision is rejected");
		const forged = await json(await fetch(`${origin}/api/v1/tracker/tickets`, { method: "POST", headers: headers(token), body: JSON.stringify({ title: "must reject", actor: "human:forged" }) }));
		assert.equal(forged.status, 403, "request JSON cannot forge actor identity");
		assert.equal(JSON.stringify(forged.body).includes("human:forged"), false, "forged identity is not echoed");
		assert.equal(service.origin, origin);
		return "real HTTP + storage-free MCP delegation share typed tracker results, legacy parity, CAS conflicts, and explicit caller rejection";
	});
}

export async function exerciseDeliveryApiFenceRecheck() {
	const fences = new Map([["recipient-gol43", 1]]);
	const eligibility = {
		resolve(recipientId) {
			const fence = fences.get(recipientId);
			if (fence === undefined) return undefined;
			return { recipientId, generationId: "gen_gol43", endpointId: "endpoint_gol43", ownerFence: fence, readiness: "ready", mode: "next_turn", capabilities: [{ capability: "delivery", qualification: "supported", observedAt: "2026-07-21T00:00:00.000Z" }] };
		},
	};
	return withControlPlane(async ({ token, origin }) => {
		const envelope = await json(await fetch(`${origin}/api/v1/delivery/envelopes`, { method: "POST", headers: headers(token), body: JSON.stringify({ id: "env_gol43", idempotency_key: "idem_gol43", recipient_id: "recipient-gol43", kind: "ticket_dispatch", payload: { ticket: "GOL-43" } }) }));
		assert.equal(envelope.status, 201);
		const claims = await json(await fetch(`${origin}/api/v1/delivery/claims`, { method: "POST", headers: headers(token), body: JSON.stringify({ worker_id: "ses_gol43", limit: 1 }) }));
		assert.equal(claims.status, 200);
		const claim = claims.body.items[0];
		assert.equal(typeof claim.claimToken, "string");
		fences.set("recipient-gol43", 2);
		const stale = await json(await fetch(`${origin}/api/v1/delivery/claims/${encodeURIComponent(claim.claimToken)}/prepare`, { method: "POST", headers: headers(token), body: "{}" }));
		assert.equal(stale.status, 409, "queued fence change is rejected before transport");
		assert.equal(stale.body.result.kind, "stale");
		return "real HTTP delivery enqueue/claim rechecks canonical endpoint fence and refuses stale work before any adapter boundary";
	}, eligibility);
}
