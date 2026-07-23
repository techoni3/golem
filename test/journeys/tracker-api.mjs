import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { invokeMcpTool } from "../../packages/mcp-adapter/dist/index.js";
import { createFetchApiClient } from "../../packages/api-client/dist/index.js";
import { composeControlPlaneCommandGateway, composeControlPlaneTrackerCoreServices, composeControlPlaneTrackerServices, composeControlPlaneManagementServices } from "../../apps/control-plane/dist/tracker.js";
import { createBrowserPrincipalResolver } from "../../apps/control-plane/dist/auth.js";
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
	const principals = writer.browserPrincipalStorage();
	principals.provision({
		id: "principal_gol43_bearer",
		actorId: "ses_gol43",
		role: "operator",
		defaultProjectId: "prj_gol43",
		scopeProjectIds: ["prj_gol43"],
	});
	principals.bindCredential({
		bindingId: "principal_gol43_bearer",
		adapter: "bearer",
		credential: token,
	});
	const principalResolver = createBrowserPrincipalResolver({
		storage: principals,
		clock: { now: () => Date.parse(clock.now()) },
	});
	const services = composeControlPlaneTrackerServices({
		writer,
		clock,
		eligibility: eligibility ?? { resolve: () => undefined },
	});
	const commandGateway = composeControlPlaneCommandGateway({
		writer,
		clock,
		core,
	});
	const management = composeControlPlaneManagementServices({
		writer,
		clock,
		assetRoot: path.join(home.root, "ticket-assets"),
		tickets: core.tickets,
	});
	let service;
	try {
		service = await startControlPlane({ token, stateDirectory: path.join(home.root, "control-plane"), staticDirectory: staticRoot, trackerCore: core, trackerServices: services, commandGateway, management, principalResolver });
		return await run({ home, token, clock, writer, core, services, gateway: commandGateway, service, origin: service.origin });
	} finally {
		if (service) await service.close();
		await writer.close();
		home.cleanup();
		assert.equal(fs.existsSync(home.root), false, "typed API journey removes temporary GOLEM_HOME");
	}
}

function headers(token) {
	return {
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
	};
}

async function json(response) {
	return { status: response.status, body: await response.json() };
}

export async function exerciseTrackerHttpMcpParity() {
	return withControlPlane(async ({ token, service, writer, gateway, origin }) => {
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
		const missingRevision = await json(await fetch(`${origin}/api/v1/tracker/tickets/${ticket.id}`, { method: "PATCH", headers: headers(token), body: JSON.stringify({ title: "unconditional" }) }));
		assert.equal(missingRevision.status, 400, "typed HTTP mutation requires an explicit CAS revision");
		assert.equal(missingRevision.body.code, "tracker.revision.required");
		const fresh = await invokeMcpTool(client, "ticket_update", { id: ticket.id, expected_revision: ticket.revision, title: "fresh canonical title" });
		assert.equal(fresh.isError, undefined, "MCP CAS update delegates successfully");
		const freshTicket = JSON.parse(fresh.content[0].text).result;
		assert.equal(freshTicket.revision, ticket.revision + 1, "successful CAS advances exactly one revision");
		const auditBeforeStale = writer.trackerCoreStorage().auditCore().length;
		const conflict = await json(await fetch(`${origin}/api/v1/tracker/tickets/${ticket.id}`, { method: "PATCH", headers: headers(token), body: JSON.stringify({ expected_revision: ticket.revision, title: "stale" }) }));
		assert.equal(conflict.status, 409, "stale optimistic revision is rejected by typed HTTP CAS");
		assert.equal(conflict.body.code, "tracker.conflict", "stale CAS has the stable typed conflict code");
		const staleMcp = await invokeMcpTool(client, "ticket_update", { id: ticket.id, expected_revision: ticket.revision, title: "stale MCP" });
		assert.equal(staleMcp.isError, true, "stale MCP CAS is rejected");
		assert.equal(JSON.parse(staleMcp.content[0].text).code, "tracker.conflict", "MCP preserves the typed conflict code");
		const afterStale = await json(await fetch(`${origin}/api/v1/tracker/tickets/${ticket.id}`, { headers: headers(token) }));
		assert.equal(afterStale.status, 200);
		assert.equal(afterStale.body.title, "fresh canonical title", "stale CAS does not mutate the ticket");
		assert.equal(afterStale.body.revision, freshTicket.revision, "stale CAS does not advance revision");
		assert.equal(writer.trackerCoreStorage().auditCore().length, auditBeforeStale, "stale CAS emits no event or audit side effect");
		const forged = await json(await fetch(`${origin}/api/v1/tracker/tickets`, { method: "POST", headers: headers(token), body: JSON.stringify({ title: "must reject", actor: "human:forged" }) }));
		assert.equal(forged.status, 403, "request JSON cannot forge actor identity");
		assert.equal(JSON.stringify(forged.body).includes("human:forged"), false, "forged identity is not echoed");

		// J6 adapter-parity: every representative adapter mutation must produce
		// a durable command receipt.  Use known idempotency keys so the
		// receipt can be looked up and asserted.
		const receipts = writer.commandGatewayStorage().receipts;
		const projectId = "prj_gol43";

		// Typed adapter: comment with a known key.
		const commentKey = "j6:typed:comment:1";
		const commentCreate = await json(await fetch(`${origin}/api/v1/tracker/tickets/${ticket.id}/comments`, { method: "POST", headers: headers(token), body: JSON.stringify({ body: "gateway-backed comment", idempotency_key: commentKey }) }));
		assert.equal(commentCreate.status, 201, "typed comment create succeeds through the gateway");
		const commentReceipt = receipts.find(projectId, commentKey);
		assert.ok(commentReceipt, "typed comment produced a durable receipt");
		assert.equal(commentReceipt.command_kind, "ticket.comment.create", "receipt has the correct command kind");
		assert.equal(commentReceipt.outcome_status, "completed", "receipt outcome is completed");

		// Typed adapter: stream with a known key.
		const streamKey = "j6:typed:stream:1";
		const streamCreate = await json(await fetch(`${origin}/api/v1/tracker/streams`, { method: "POST", headers: headers(token), body: JSON.stringify({ name: "gateway-parity-stream", mode: "parallel", idempotency_key: streamKey }) }));
		assert.equal(streamCreate.status, 201, "typed stream create succeeds through the gateway");
		const streamReceipt = receipts.find(projectId, streamKey);
		assert.ok(streamReceipt, "typed stream produced a durable receipt");
		assert.equal(streamReceipt.command_kind, "stream.upsert", "stream receipt has the correct command kind");

		// Legacy adapter: ticket create with a known key.
		const legacyKey = "j6:legacy:ticket:1";
		const legacyCreate = await json(await fetch(`${origin}/api/tickets`, { method: "POST", headers: headers(token), body: JSON.stringify({ title: "legacy gateway ticket", idempotency_key: legacyKey }) }));
		assert.equal(legacyCreate.status, 200, "legacy ticket create succeeds");
		const legacyReceipt = receipts.find(projectId, legacyKey);
		assert.ok(legacyReceipt, "legacy ticket create produced a durable receipt");
		assert.equal(legacyReceipt.command_kind, "legacy.ticket.create", "legacy receipt has the correct command kind");

		// MCP adapter: ticket update with a known key.  Fetch the current
		// ticket first — preceding comment/stream mutations may have advanced
		// the revision.
		const currentTicket = await json(await fetch(`${origin}/api/v1/tracker/tickets/${ticket.id}`, { headers: headers(token) }));
		const mcpUpdateKey = "j6:mcp:update:1";
		const mcpUpdate = await invokeMcpTool(client, "ticket_update", { id: ticket.id, expected_revision: currentTicket.body.revision, title: "mcp gateway title", idempotency_key: mcpUpdateKey });
		assert.equal(mcpUpdate.isError, undefined, "MCP CAS update with idempotency key succeeds");
		const mcpReceipt = receipts.find(projectId, mcpUpdateKey);
		assert.ok(mcpReceipt, "MCP ticket update produced a durable receipt");
		assert.equal(mcpReceipt.command_kind, "ticket.update", "MCP receipt has the correct command kind");
		assert.equal(mcpReceipt.outcome_status, "completed", "MCP receipt outcome is completed");

		// Management adapter: a real bearer HTTP POST to the management
		// gate route.  The request carries no actor/project_id (those are
		// server-owned resolver fields, rejected by hasRequestAuthorityOverride);
		// the route resolves the ActorContext and uses context.actorId /
		// context.defaultProjectId for the gateway input and the gate
		// service mutation.  A known idempotency_key lets the durable
		// receipt be looked up and asserted.
		const managementKey = "j6:management:gate:1";
		const managementGate = await json(await fetch(`${origin}/api/v1/management/gates`, {
			method: "POST",
			headers: headers(token),
			body: JSON.stringify({
				kind: "approval",
				question: "J6 parity gate?",
				assignee: "ses_gol43",
				idempotency_key: managementKey,
			}),
		}));
		assert.equal(managementGate.status, 201, "management gate create succeeds through the real HTTP route");
		assert.ok(managementGate.body.result && managementGate.body.result.id, "management gate create returns a real gate id");
		const managementGateId = managementGate.body.result.id;
		const managementReceipt = receipts.find(projectId, managementKey);
		assert.ok(managementReceipt, "management gate create produced a durable receipt");
		assert.equal(managementReceipt.command_kind, "management.gate.create", "management receipt has the correct command kind");
		assert.equal(managementReceipt.outcome_status, "completed", "management receipt outcome is completed");
		// Confirm the gate was actually persisted in the management store.
		const managementGates = await json(await fetch(`${origin}/api/v1/management/gates`, { headers: headers(token) }));
		assert.equal(managementGates.status, 200, "management gate list is reachable without actor/project query");
		assert.ok(managementGates.body.result.some((gate) => gate.id === managementGateId), "the created gate is present in the management store");

		// Replay: repeat an identical management gate request and assert
		// the original outcome is returned with no new management audit
		// effect and no second gate row.
		const managementStorage = writer.managementStorage();
		const managementAuditBeforeReplay = managementStorage.auditManagement(projectId).length;
		const managementReplay = await json(await fetch(`${origin}/api/v1/management/gates`, {
			method: "POST",
			headers: headers(token),
			body: JSON.stringify({
				kind: "approval",
				question: "J6 parity gate?",
				assignee: "ses_gol43",
				idempotency_key: managementKey,
			}),
		}));
		assert.equal(managementReplay.status, 201, "identical management gate replay is accepted");
		assert.equal(managementReplay.body.result.id, managementGateId, "management replay returns the original gate id");
		assert.equal(managementStorage.auditManagement(projectId).length, managementAuditBeforeReplay, "management replay emits no new audit side effect");
		assert.equal(managementStorage.listGates(projectId).filter((gate) => gate.id === managementGateId).length, 1, "management replay does not create a second gate row");

		// Replay: repeat an identical typed comment request and assert the
		// original outcome is returned with no new audit/domain effect.
		const auditBeforeReplay = writer.trackerCoreStorage().auditCore().length;
		const commentReplay = await json(await fetch(`${origin}/api/v1/tracker/tickets/${ticket.id}/comments`, { method: "POST", headers: headers(token), body: JSON.stringify({ body: "gateway-backed comment", idempotency_key: commentKey }) }));
		assert.equal(commentReplay.status, 201, "identical comment replay is accepted");
		assert.equal(commentReplay.body.command_id, commentReceipt.command_id, "replay returns the original command_id");
		assert.equal(writer.trackerCoreStorage().auditCore().length, auditBeforeReplay, "replay emits no new audit side effect");

		// Replay: repeat an identical MCP update request with the same
		// expected_revision (fingerprint input) and assert the original
		// outcome is returned with no new audit/domain effect.
		const auditBeforeMcpReplay = writer.trackerCoreStorage().auditCore().length;
		const mcpReplay = await invokeMcpTool(client, "ticket_update", { id: ticket.id, expected_revision: currentTicket.body.revision, title: "mcp gateway title", idempotency_key: mcpUpdateKey });
		assert.equal(mcpReplay.isError, undefined, "identical MCP update replay is accepted");
		assert.equal(JSON.parse(mcpReplay.content[0].text).command_id, mcpReceipt.command_id, "MCP replay returns the original command_id");
		assert.equal(writer.trackerCoreStorage().auditCore().length, auditBeforeMcpReplay, "MCP replay emits no new audit side effect");

		assert.equal(service.origin, origin);
		return "real HTTP + storage-free MCP delegation share typed tracker results, legacy parity, CAS conflicts, explicit caller rejection, durable receipt assertions for typed/legacy/management/MCP adapters, and replay-safe idempotency";
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

/**
 * J4 durable command idempotency + CAS journey (GOL-79).  A real compiled
 * control plane with a durable command gateway performs a permitted ticket
 * mutation, is fully restarted, and replays the identical envelope to return
 * the byte-equivalent typed original outcome with exactly one domain/audit
 * side effect.  A reused key with a changed payload returns 409
 * command.idempotency_mismatch.  A missing/zero revision is 400
 * tracker.revision.required.  A stale positive revision is 409
 * tracker.conflict and leaves tracker/audit/outbox unchanged.
 */
export async function exerciseDurableCommandIdempotencyCas() {
	const home = createTemporaryHome("golem-gol79-durable-");
	const staticRoot = path.join(home.root, "static");
	fs.mkdirSync(staticRoot, { recursive: true });
	fs.writeFileSync(path.join(staticRoot, "index.html"), "<!doctype html>\n");
	const token = "golem-gol79-durable-token-0000000000";
	const clock = fixtureClock();
	const provisionPrincipal = (writer) => {
		const principals = writer.browserPrincipalStorage();
		// The binding persists across restarts; only provision on the first
		// phase.  Re-provisioning would violate the UNIQUE binding id.
		try {
			principals.provision({
				id: "principal_gol79_bearer",
				actorId: "ses_gol79",
				role: "operator",
				defaultProjectId: "prj_gol79",
				scopeProjectIds: ["prj_gol79"],
			});
			principals.bindCredential({
				bindingId: "principal_gol79_bearer",
				adapter: "bearer",
				credential: token,
			});
		} catch {
			// Binding already exists from a prior phase — the durable
			// principal survives the restart.
		}
		return createBrowserPrincipalResolver({
			storage: principals,
			clock: { now: () => Date.parse(clock.now()) },
		});
	};
	const compose = (writer, principalResolver) => {
		const core = composeControlPlaneTrackerCoreServices({ writer, clock });
		const services = composeControlPlaneTrackerServices({
			writer,
			clock,
			eligibility: { resolve: () => undefined },
		});
		const commandGateway = composeControlPlaneCommandGateway({ writer, clock, core });
		return { core, services, commandGateway };
	};

	// Phase 1: open the control plane, create a ticket with an idempotency
	// key, and record the canonical outcome + audit count.
	let writer = openControlPlanePersistence({
		runtimePath: home.runtimeDb,
		trackerPath: home.trackerDb,
		lockPath: path.join(home.root, "owner.lock"),
	}, { clock, ownerId: "gol79-phase1" });
	let principalResolver = provisionPrincipal(writer);
	let { core, services, commandGateway } = compose(writer, principalResolver);
	let service = await startControlPlane({
		token,
		stateDirectory: path.join(home.root, "control-plane"),
		staticDirectory: staticRoot,
		trackerCore: core,
		trackerServices: services,
		commandGateway,
		principalResolver,
	});
	const origin = service.origin;
	const idempotencyKey = "gol79:ticket.create:durable";
	const createdBody = await (async () => {
		const response = await fetch(`${origin}/api/v1/tracker/tickets`, {
			method: "POST",
			headers: headers(token),
			body: JSON.stringify({
				title: "durable command ticket",
				body: "GOL-79 restart-safe replay",
				idempotency_key: idempotencyKey,
				kind: "work-item",
			}),
		});
		assert.equal(response.status, 201, "durable ticket create is accepted");
		return response.json();
	})();
	assert.equal(createdBody.schema_version, "golem.api-command-outcome/v1", "gateway returns the typed outcome shape");
	assert.equal(createdBody.status, "completed", "first create completes");
	assert.equal(typeof createdBody.command_id, "string", "outcome carries the original command id");
	const originalCommandId = createdBody.command_id;
	const originalTicketId = createdBody.result.id;
	const auditAfterCreate = writer.trackerCoreStorage().auditCore().length;
	// Phase 2: full restart — close the server + persistence owner, reopen
	// a fresh owner on the same SQLite files, recompose the gateway, and
	// start a new control plane.  The durable receipt survives.
	await service.close();
	await writer.close();
	writer = openControlPlanePersistence({
		runtimePath: home.runtimeDb,
		trackerPath: home.trackerDb,
		lockPath: path.join(home.root, "owner.lock"),
	}, { clock, ownerId: "gol79-phase2" });
	principalResolver = provisionPrincipal(writer);
	({ core, services, commandGateway } = compose(writer, principalResolver));
	service = await startControlPlane({
		token,
		stateDirectory: path.join(home.root, "control-plane"),
		staticDirectory: staticRoot,
		trackerCore: core,
		trackerServices: services,
		commandGateway,
		principalResolver,
	});
	const restartedOrigin = service.origin;
	// Phase 3: replay the identical envelope — must return the byte-equivalent
	// original typed outcome without re-running the handler or emitting any
	// new audit/event/outbox side effect.
	const replayedBody = await (async () => {
		const response = await fetch(`${restartedOrigin}/api/v1/tracker/tickets`, {
			method: "POST",
			headers: headers(token),
			body: JSON.stringify({
				title: "durable command ticket",
				body: "GOL-79 restart-safe replay",
				idempotency_key: idempotencyKey,
				kind: "work-item",
			}),
		});
		assert.equal(response.status, 201, "replay of identical envelope is accepted");
		return response.json();
	})();
	assert.equal(replayedBody.command_id, originalCommandId, "replay returns the original command id, not a freshly minted one");
	assert.equal(replayedBody.status, "completed", "replay returns the original terminal status");
	assert.equal(replayedBody.result.id, originalTicketId, "replay returns the original resource id");
	assert.deepEqual(replayedBody.result, createdBody.result, "replay returns the byte-equivalent typed original outcome");
	assert.equal(writer.trackerCoreStorage().auditCore().length, auditAfterCreate, "replay emits no new audit/event/outbox side effect");

	// Phase 4: reuse the same idempotency key with a differing payload —
	// must return 409 command.idempotency_mismatch with no domain effect.
	const mismatch = await json(await fetch(`${restartedOrigin}/api/v1/tracker/tickets`, {
		method: "POST",
		headers: headers(token),
		body: JSON.stringify({
			title: "differing payload",
			body: "must be rejected",
			idempotency_key: idempotencyKey,
			kind: "work-item",
		}),
	}));
	assert.equal(mismatch.status, 409, "reuse with a differing payload is 409");
	assert.equal(mismatch.body.code, "command.idempotency_mismatch", "mismatch carries the stable typed code");
	assert.equal(writer.trackerCoreStorage().auditCore().length, auditAfterCreate, "mismatch emits no side effect");

	// Phase 5: a missing revision on a ticket update is 400
	// tracker.revision.required.
	const missingRevision = await json(await fetch(`${restartedOrigin}/api/v1/tracker/tickets/${originalTicketId}`, {
		method: "PATCH",
		headers: headers(token),
		body: JSON.stringify({ idempotency_key: "gol79:ticket.update:1", title: "unconditional" }),
	}));
	assert.equal(missingRevision.status, 400, "missing revision is 400");
	assert.equal(missingRevision.body.code, "tracker.revision.required");

	// Phase 6: a zero revision is also 400.
	const zeroRevision = await json(await fetch(`${restartedOrigin}/api/v1/tracker/tickets/${originalTicketId}`, {
		method: "PATCH",
		headers: headers(token),
		body: JSON.stringify({ idempotency_key: "gol79:ticket.update:2", expected_revision: 0, title: "zero" }),
	}));
	assert.equal(zeroRevision.status, 400, "zero revision is 400");
	assert.equal(zeroRevision.body.code, "tracker.revision.required");

	// Phase 7: a stale positive revision is 409 tracker.conflict and leaves
	// tracker/audit/outbox unchanged.  Use a positive revision that is
	// certainly stale — the current revision cannot be 999 after a single
	// create.
	const staleAuditBefore = writer.trackerCoreStorage().auditCore().length;
	const stale = await json(await fetch(`${restartedOrigin}/api/v1/tracker/tickets/${originalTicketId}`, {
		method: "PATCH",
		headers: headers(token),
		body: JSON.stringify({ idempotency_key: "gol79:ticket.update:stale", expected_revision: 999, title: "stale CAS" }),
	}));
	assert.equal(stale.status, 409, "stale positive revision is 409");
	assert.equal(stale.body.code, "tracker.conflict", "stale CAS has the stable typed conflict code");
	assert.equal(writer.trackerCoreStorage().auditCore().length, staleAuditBefore, "stale CAS emits no event or audit side effect");

	await service.close();
	await writer.close();
	home.cleanup();
	assert.equal(fs.existsSync(home.root), false, "durable command journey removes temporary GOLEM_HOME");
	return "real compiled service + managed temporary SQLite + full process restart replays a durable command receipt with the byte-equivalent original outcome, rejects a reused key with a differing payload as 409 command.idempotency_mismatch, and enforces 400/409 CAS preconditions with no side effect";
}
