import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import WebSocket from "ws";

import { createFetchApiClient } from "../../packages/api-client/dist/index.js";
import { invokeMcpTool } from "../../packages/mcp-adapter/dist/index.js";
import { createBrowserPrincipalResolver } from "../../apps/control-plane/dist/auth.js";
import {
	composeControlPlaneCommandGateway,
	composeControlPlaneManagementServices,
	composeControlPlaneTrackerCoreServices,
	composeControlPlaneTrackerServices,
} from "../../apps/control-plane/dist/tracker.js";
import { openControlPlanePersistence } from "../../apps/control-plane/dist/persistence.js";
import { startControlPlane } from "../../apps/control-plane/dist/server.js";
import { createTemporaryHome } from "@golem/testkit";

const tokenA = "golem-gol80-principal-a-token-000000000000";
const tokenB = "golem-gol80-principal-b-token-000000000000";
const projectA = "prj_gol80_a";
const projectB = "prj_gol80_b";

function clock() {
	let current = "2026-07-23T12:00:00.000Z";
	return {
		now: () => current,
		after: (milliseconds) => new Date(Date.parse(current) + milliseconds).toISOString(),
		advance: (milliseconds) => {
			current = new Date(Date.parse(current) + milliseconds).toISOString();
			return current;
		},
	};
}

function headers(token) {
	return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function request(origin, token, route, options = {}) {
	const response = await fetch(`${origin}${route}`, {
		...options,
		headers: { ...headers(token), ...(options.headers ?? {}) },
	});
	return { status: response.status, body: await response.json() };
}

function nextFrame(socket) {
	return new Promise((resolve, reject) => {
		const onMessage = (raw) => {
			cleanup();
			resolve(JSON.parse(String(raw)));
		};
		const onError = (error) => {
			cleanup();
			reject(error);
		};
		const cleanup = () => {
			socket.off("message", onMessage);
			socket.off("error", onError);
		};
		socket.on("message", onMessage);
		socket.on("error", onError);
	});
}

async function noFrame(socket, milliseconds = 150) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup();
			resolve();
		}, milliseconds);
		const onMessage = (raw) => {
			cleanup();
			reject(new Error(`off-scope frame leaked: ${String(raw)}`));
		};
		const onError = (error) => {
			cleanup();
			reject(error);
		};
		const cleanup = () => {
			clearTimeout(timeout);
			socket.off("message", onMessage);
			socket.off("error", onError);
		};
		socket.on("message", onMessage);
		socket.on("error", onError);
	});
}

async function eventually(read, message) {
	const deadline = Date.now() + 2_000;
	let last;
	while (Date.now() < deadline) {
		last = read();
		if (last) return last;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`${message}; last=${String(last)}`);
}

function publicationSnapshot(writer, projectId) {
	const storage = writer.committedPublicationStorage();
	return Object.freeze({
		revision: storage.projectRevision(projectId),
		outboxRows: storage.outboxCount(projectId),
	});
}

function assertPublicationDelta(writer, projectId, before, delta, label) {
	const after = publicationSnapshot(writer, projectId);
	assert.equal(after.revision - before.revision, delta, `${label} project revision delta`);
	assert.equal(after.outboxRows - before.outboxRows, delta, `${label} outbox row delta`);
	return after;
}

function provision(writer) {
	const principals = writer.browserPrincipalStorage();
	for (const [id, actorId, projectId, token] of [
		["principal_gol80_a", "ses_gol80_a", projectA, tokenA],
		["principal_gol80_b", "ses_gol80_b", projectB, tokenB],
	]) {
		try {
			principals.provision({
				id,
				actorId,
				role: "operator",
				defaultProjectId: projectId,
				scopeProjectIds: [projectId],
			});
			principals.bindCredential({ bindingId: id, adapter: "bearer", credential: token });
		} catch (error) {
			if (!(error && typeof error === "object" && error.code === "SQLITE_CONSTRAINT_PRIMARYKEY")) throw error;
		}
	}
	return createBrowserPrincipalResolver({ storage: principals });
}

function compose(writer, fixtureClock, home) {
	const core = composeControlPlaneTrackerCoreServices({ writer, clock: fixtureClock });
	const services = composeControlPlaneTrackerServices({
		writer,
		clock: fixtureClock,
		eligibility: {
			resolve: (recipientId) => ({
				recipientId,
				generationId: "gen_gol80_delivery",
				endpointId: "endpoint_gol80_delivery",
				ownerFence: 1,
				readiness: "ready",
				mode: "next_turn",
				capabilities: [{ capability: "delivery", qualification: "supported", observedAt: fixtureClock.now() }],
			}),
		},
	});
	const management = composeControlPlaneManagementServices({
		writer,
		clock: fixtureClock,
		assetRoot: path.join(home.root, "assets"),
		tickets: core.tickets,
	});
	return {
		core,
		services,
		management,
		gateway: composeControlPlaneCommandGateway({ writer, clock: fixtureClock, core }),
	};
}

async function start(home, writer, fixtureClock) {
	const staticDirectory = path.join(home.root, "static");
	fs.mkdirSync(staticDirectory, { recursive: true });
	fs.writeFileSync(path.join(staticDirectory, "index.html"), "<!doctype html><title>GOL-80</title>");
	const composed = compose(writer, fixtureClock, home);
	const principalResolver = provision(writer);
	const service = await startControlPlane({
		token: tokenA,
		stateDirectory: path.join(home.root, "control-plane"),
		staticDirectory,
		trackerCore: composed.core,
		trackerServices: composed.services,
		management: composed.management,
		commandGateway: composed.gateway,
		committedPublications: writer.committedPublicationStorage(),
		principalResolver,
		replayWindowSize: 1,
		projection: {
			read: () => ({}),
			revision: (_stream, projectId) => projectId ? writer.committedPublicationStorage().projectRevision(projectId) : 0,
		},
	});
	return { service, ...composed };
}

test("GOL-80 committed-outbox-all-write-paths", async () => {
	const home = createTemporaryHome("golem-gol80-outbox-");
	const fixtureClock = clock();
	let writer;
	let control;
	let socket;
	try {
		writer = openControlPlanePersistence({
			runtimePath: home.runtimeDb,
			trackerPath: home.trackerDb,
			lockPath: path.join(home.root, "owner.lock"),
		}, { ownerId: "gol80-outbox", clock: fixtureClock });
		control = await start(home, writer, fixtureClock);
		const origin = control.service.origin;
		socket = new WebSocket(`${origin.replace("http", "ws")}/api/v1/ws?stream=tracker.tree`, { headers: { authorization: `Bearer ${tokenA}`, host: "127.0.0.1" } });
		const snapshot = await nextFrame(socket);
		assert.equal(snapshot.payload.kind, "snapshot");

		const mcp = createFetchApiClient(origin, { bearerToken: tokenA, caller: { projectId: projectA, sessionId: "ses_gol80_a" } });
		let publication = publicationSnapshot(writer, projectA);
		const created = await invokeMcpTool(mcp, "ticket_create", {
			title: "committed invalidation ticket",
			body: "private ticket prose must never cross the websocket",
			idempotency_key: "gol80:mcp:create",
		});
		assert.equal(created.isError, undefined, "MCP delegates to the gateway");
		const ticket = JSON.parse(created.content[0].text).result;
		publication = assertPublicationDelta(writer, projectA, publication, 1, "MCP ticket create");
		const delta = await nextFrame(socket);
		assert.equal(delta.payload.kind, "delta");
		assert.deepEqual(delta.payload.delta, { kind: "invalidation", category: "tracker" });
		assert.doesNotMatch(JSON.stringify(delta), /private ticket prose|gol80-principal-a-token/u, "frame is opaque");

		const updated = await request(origin, tokenA, `/api/v1/tracker/tickets/${ticket.id}`, {
			method: "PATCH",
			body: JSON.stringify({ expected_revision: ticket.revision, title: "canonical revision advance", idempotency_key: "gol80:http:update" }),
		});
		assert.equal(updated.status, 200, "bearer HTTP mutation succeeds");
		publication = assertPublicationDelta(writer, projectA, publication, 1, "fixed-clock bearer ticket update");
		const currentTicket = control.core.compatibility.getTicket(ticket.id);
		assert.ok(currentTicket, "updated ticket is canonical");
		const internalChangedBefore = publication;
		const internalChanged = control.core.tickets.update({
			id: ticket.id,
			expectedRevision: currentTicket.revision,
			patch: { body: "internal fixed-clock semantic update" },
			actor: "ses_gol80_a",
		});
		assert.ok(internalChanged, "internal core update succeeds at the fixed clock");
		publication = assertPublicationDelta(writer, projectA, internalChangedBefore, 1, "internal fixed-clock ticket update");
		const noOpBefore = publication;
		const noOp = control.core.tickets.update({
			id: ticket.id,
			expectedRevision: internalChanged.revision,
			patch: { body: "internal fixed-clock semantic update" },
			actor: "ses_gol80_a",
		});
		assert.ok(noOp, "internal no-op returns the canonical ticket");
		publication = assertPublicationDelta(writer, projectA, noOpBefore, 0, "true core no-op");
		const stale = await request(origin, tokenA, `/api/v1/tracker/tickets/${ticket.id}`, {
			method: "PATCH",
			body: JSON.stringify({ expected_revision: ticket.revision, title: "stale", idempotency_key: "gol80:http:stale" }),
		});
		assert.equal(stale.status, 409, "stale CAS is rejected");
		publication = assertPublicationDelta(writer, projectA, publication, 0, "stale bearer CAS");

		const rollbackBefore = publication;
		assert.throws(() => control.gateway.execute({
			commandId: "cmd_gol80_rollback",
			idempotencyKey: "gol80:rollback",
			commandKind: "ticket.comment.create",
			actorId: "ses_gol80_a",
			projectId: projectA,
			correlationId: "corr_gol80_rollback",
			scope: { resourceType: "tracker.ticket", resourceId: ticket.id },
			payload: { body: "rollback" },
			handler: () => {
				control.core.comments.add({ ticketId: ticket.id, author: "ses_gol80_a", body: "must rollback" });
				throw new Error("rollback");
			},
		}), /rollback/u);
		publication = assertPublicationDelta(writer, projectA, rollbackBefore, 0, "rolled-back gateway write");

		const legacyBefore = publication;
		const legacy = await request(origin, tokenA, "/api/tickets", {
			method: "POST",
			body: JSON.stringify({ title: "legacy committed ticket", idempotency_key: "gol80:legacy:create" }),
		});
		assert.equal(legacy.status, 200, "legacy adapter delegates to canonical storage");
		publication = assertPublicationDelta(writer, projectA, legacyBefore, 1, "legacy ticket create");

		const commentBefore = publication;
		control.core.comments.add({ ticketId: ticket.id, author: "ses_gol80_a", body: "internal canonical comment" });
		publication = assertPublicationDelta(writer, projectA, commentBefore, 1, "internal core comment create");

		const gateBefore = publication;
		const gate = await request(origin, tokenA, "/api/v1/management/gates", {
			method: "POST",
			body: JSON.stringify({ kind: "approval", question: "GOL-80 gate", assignee: "ses_gol80_a", idempotency_key: "gol80:gate" }),
		});
		assert.equal(gate.status, 201, "management write uses the same transaction owner");
		publication = assertPublicationDelta(writer, projectA, gateBefore, 1, "management gate create");
		const gateAnswerBefore = publication;
		const gateAnswer = await request(origin, tokenA, `/api/v1/management/gates/${gate.body.result.id}/verdict`, {
			method: "POST",
			body: JSON.stringify({ status: "approved", verdict: { approved: true } }),
		});
		assert.equal(gateAnswer.status, 200, "management gate semantic update succeeds at the fixed clock");
		publication = assertPublicationDelta(writer, projectA, gateAnswerBefore, 1, "management gate semantic update");
		const communicationBefore = publication;
		const communication = await request(origin, tokenA, "/api/v1/management/communications", {
			method: "POST",
			body: JSON.stringify({ kind: "brief", command: "notify", payload: { safe: true }, idempotency_key: "gol80:communication" }),
		});
		assert.equal(communication.status, 201, "communication operation is committed through management storage");
		publication = assertPublicationDelta(writer, projectA, communicationBefore, 1, "communication operation create");
		const assetBefore = publication;
		const asset = await request(origin, tokenA, "/api/v1/management/assets", {
			method: "POST",
			body: JSON.stringify({ ticket_id: ticket.id, relative_path: "evidence.png", mime_type: "image/png", content_base64: Buffer.from("asset bytes").toString("base64"), idempotency_key: "gol80:asset" }),
		});
		assert.equal(asset.status, 201, `asset metadata write is committed with an invalidation: ${JSON.stringify(asset.body)}`);
		publication = assertPublicationDelta(writer, projectA, assetBefore, 1, "asset metadata create");

		const envelopeBefore = publication;
		const envelope = await request(origin, tokenA, "/api/v1/delivery/envelopes", {
			method: "POST",
			body: JSON.stringify({ id: "env_gol80_settlement", idempotency_key: "gol80:delivery", recipient_id: "recipient_gol80", kind: "ticket_dispatch", payload: { ticket: ticket.id } }),
		});
		assert.equal(envelope.status, 201, "delivery enqueue is committed");
		publication = assertPublicationDelta(writer, projectA, envelopeBefore, 1, "HTTP delivery enqueue");
		const claimBefore = publication;
		const claim = control.services.delivery.claim("ses_gol80_a", 1)[0];
		assert.ok(claim, "the real delivery service claims the HTTP-created envelope");
		assert.equal(claim.prepare().kind, "deliver", "delivery rechecks the canonical endpoint before settlement");
		publication = assertPublicationDelta(writer, projectA, claimBefore, 0, "delivery claim/prepare");
		const acknowledgementBefore = publication;
		assert.equal(claim.acknowledge("ack_gol80", {}), true, "delivery acknowledgement is committed");
		publication = assertPublicationDelta(writer, projectA, acknowledgementBefore, 1, "successful delivery acknowledgement");
		const duplicateAcknowledgementBefore = publication;
		assert.equal(claim.acknowledge("ack_gol80", {}), true, "duplicate acknowledgement is idempotently accepted");
		publication = assertPublicationDelta(writer, projectA, duplicateAcknowledgementBefore, 0, "duplicate delivery acknowledgement");
		const deliveredEnqueueBefore = publication;
		const settlementEnvelope = await request(origin, tokenA, "/api/v1/delivery/envelopes", {
			method: "POST",
			body: JSON.stringify({ id: "env_gol80_delivered", idempotency_key: "gol80:delivery:delivered", recipient_id: "recipient_gol80", kind: "ticket_dispatch", payload: { ticket: ticket.id } }),
		});
		assert.equal(settlementEnvelope.status, 201);
		publication = assertPublicationDelta(writer, projectA, deliveredEnqueueBefore, 1, "delivered envelope enqueue");
		const settlementClaim = control.services.delivery.claim("ses_gol80_a", 1)[0];
		assert.ok(settlementClaim);
		assert.equal(settlementClaim.prepare().kind, "deliver");
		const deliveredBefore = publication;
		assert.equal(settlementClaim.delivered().status, "delivered", "delivery settlement is committed");
		publication = assertPublicationDelta(writer, projectA, deliveredBefore, 1, "delivered settlement");

		const replyParentBefore = publication;
		control.services.delivery.enqueue({
			id: "env_gol80_reply_parent",
			projectId: projectA,
			idempotencyKey: "gol80:delivery:reply-parent",
			senderId: "ses_gol80_a",
			recipientId: "recipient_gol80",
			replyToRecipientId: "recipient_gol80_reply",
			kind: "ticket_dispatch",
			payload: { ticket: ticket.id },
		});
		publication = assertPublicationDelta(writer, projectA, replyParentBefore, 1, "explicit-project reply parent enqueue");
		const replyParentClaim = control.services.delivery.claim("ses_gol80_a", 1)[0];
		assert.ok(replyParentClaim);
		assert.equal(replyParentClaim.prepare().kind, "deliver");
		const replyBefore = publication;
		replyParentClaim.reply({ id: "env_gol80_reply_child", idempotencyKey: "gol80:delivery:reply-child", payload: { accepted: true } });
		publication = assertPublicationDelta(writer, projectA, replyBefore, 1, "delivery reply enqueue");
		const replyParentDeliveredBefore = publication;
		assert.equal(replyParentClaim.delivered().status, "delivered");
		publication = assertPublicationDelta(writer, projectA, replyParentDeliveredBefore, 1, "reply parent delivered settlement");
		const replyChildClaim = control.services.delivery.claim("ses_gol80_a", 1)[0];
		assert.ok(replyChildClaim);
		assert.equal(replyChildClaim.prepare().kind, "deliver");
		const replyChildDeliveredBefore = publication;
		assert.equal(replyChildClaim.delivered().status, "delivered");
		publication = assertPublicationDelta(writer, projectA, replyChildDeliveredBefore, 1, "reply child delivered settlement");

		const failureEnqueueBefore = publication;
		control.services.delivery.enqueue({
			id: "env_gol80_retry",
			projectId: projectA,
			idempotencyKey: "gol80:delivery:retry",
			senderId: "ses_gol80_a",
			recipientId: "recipient_gol80",
			kind: "ticket_dispatch",
			payload: { ticket: ticket.id },
			maxAttempts: 2,
		});
		publication = assertPublicationDelta(writer, projectA, failureEnqueueBefore, 1, "explicit-project retry enqueue");
		const failureClaim = control.services.delivery.claim("ses_gol80_a", 1)[0];
		assert.ok(failureClaim);
		assert.equal(failureClaim.prepare().kind, "deliver");
		const retryBefore = publication;
		assert.equal(failureClaim.fail("retry once").status, "retrying");
		publication = assertPublicationDelta(writer, projectA, retryBefore, 1, "delivery retry settlement");
		fixtureClock.advance(1_000);
		const finalFailureClaim = control.services.delivery.claim("ses_gol80_a", 1)[0];
		assert.ok(finalFailureClaim);
		assert.equal(finalFailureClaim.prepare().kind, "deliver");
		const deadLetterBefore = publication;
		assert.equal(finalFailureClaim.fail("dead letter").status, "dead_letter");
		publication = assertPublicationDelta(writer, projectA, deadLetterBefore, 1, "delivery dead-letter settlement");

		const recoveryEnqueueBefore = publication;
		control.services.delivery.enqueue({
			id: "env_gol80_recovery",
			projectId: projectA,
			idempotencyKey: "gol80:delivery:recovery",
			senderId: "ses_gol80_a",
			recipientId: "recipient_gol80",
			kind: "ticket_dispatch",
			payload: { ticket: ticket.id },
		});
		publication = assertPublicationDelta(writer, projectA, recoveryEnqueueBefore, 1, "explicit-project recovery enqueue");
		assert.ok(control.services.delivery.claim("ses_gol80_a", 1, 1_000)[0]);
		fixtureClock.advance(1_001);
		const recoveryBefore = publication;
		assert.equal(control.services.delivery.recover().length, 1, "expired claim is recovered once");
		publication = assertPublicationDelta(writer, projectA, recoveryBefore, 1, "delivery lease recovery");

		// Let the owner drain the preceding same-project writes before opening
		// the observation window; the following assertion then attributes any
		// frame only to the foreign-project mutation.
		await new Promise((resolve) => setTimeout(resolve, 120));
		const absence = noFrame(socket, 220);
		const projectBWrite = await request(origin, tokenB, "/api/v1/tracker/tickets", { method: "POST", body: JSON.stringify({ title: "private B", idempotency_key: "gol80:project-b" }) });
		assert.equal(projectBWrite.status, 201);
		await absence;
		assert.ok(publication.revision > 0, "management, asset, and delivery paths advance the canonical project revision");
	} finally {
		socket?.close();
		if (control) await control.service.close();
		if (writer) await writer.close();
		home.cleanup();
	}
});

test("GOL-80 projection-ws-restart-resync", async () => {
	const home = createTemporaryHome("golem-gol80-restart-");
	const fixtureClock = clock();
	let writer;
	let first;
	let second;
	let socket;
	try {
		writer = openControlPlanePersistence({ runtimePath: home.runtimeDb, trackerPath: home.trackerDb, lockPath: path.join(home.root, "owner.lock") }, { ownerId: "gol80-restart-first", clock: fixtureClock });
		first = await start(home, writer, fixtureClock);
		const firstSocket = new WebSocket(`${first.service.origin.replace("http", "ws")}/api/v1/ws?stream=tracker.tree`, { headers: { authorization: `Bearer ${tokenA}`, host: "127.0.0.1" } });
		socket = firstSocket;
		const snapshot = await nextFrame(socket);
		const firstWrite = await request(first.service.origin, tokenA, "/api/v1/tracker/tickets", { method: "POST", body: JSON.stringify({ title: "restart one", idempotency_key: "gol80:restart:one" }) });
		assert.equal(firstWrite.status, 201);
		const firstDelta = await nextFrame(socket);
		assert.equal(firstDelta.payload.kind, "delta");
		const instance = first.service.instanceId;
		const cursor = firstDelta.sequence;
		socket.close();
		await first.service.close();
		first = undefined;
		await writer.close();
		writer = openControlPlanePersistence({ runtimePath: home.runtimeDb, trackerPath: home.trackerDb, lockPath: path.join(home.root, "owner.lock") }, { ownerId: "gol80-restart-second", clock: fixtureClock });
		second = await start(home, writer, fixtureClock);

		const restart = new WebSocket(`${second.service.origin.replace("http", "ws")}/api/v1/ws?stream=tracker.tree&instance_id=${instance}&cursor=${cursor}`, { headers: { authorization: `Bearer ${tokenA}`, host: "127.0.0.1" } });
		const restartFrame = await nextFrame(restart);
		assert.deepEqual(restartFrame.payload.kind, "resync_required");
		assert.equal(restartFrame.payload.reason, "instance_changed");
		restart.close();

		const policy = new WebSocket(`${second.service.origin.replace("http", "ws")}/api/v1/ws?stream=tracker.tree&instance_id=${second.service.instanceId}&cursor=0&policy_version=0`, { headers: { authorization: `Bearer ${tokenA}`, host: "127.0.0.1" } });
		const policyFrame = await nextFrame(policy);
		assert.equal(policyFrame.payload.kind, "resync_required");
		assert.equal(policyFrame.payload.reason, "policy_changed");
		policy.close();

		const compacted = new WebSocket(`${second.service.origin.replace("http", "ws")}/api/v1/ws?stream=tracker.tree`, { headers: { authorization: `Bearer ${tokenA}`, host: "127.0.0.1" } });
		await nextFrame(compacted);
		for (const key of ["two", "three"]) {
			const write = await request(second.service.origin, tokenA, "/api/v1/tracker/tickets", { method: "POST", body: JSON.stringify({ title: `restart ${key}`, idempotency_key: `gol80:restart:${key}` }) });
			assert.equal(write.status, 201);
			await nextFrame(compacted);
		}
		compacted.close();
		const gap = new WebSocket(`${second.service.origin.replace("http", "ws")}/api/v1/ws?stream=tracker.tree&instance_id=${second.service.instanceId}&cursor=0`, { headers: { authorization: `Bearer ${tokenA}`, host: "127.0.0.1" } });
		const gapFrame = await nextFrame(gap);
		assert.equal(gapFrame.payload.kind, "resync_required");
		assert.equal(gapFrame.payload.reason, "cursor_compacted");
		gap.close();
		const httpSnapshot = await request(second.service.origin, tokenA, "/api/v1/projections/tracker.tree", { method: "GET" });
		assert.equal(httpSnapshot.status, 200);
		assert.equal(httpSnapshot.body.resource_revision, writer.committedPublicationStorage().projectRevision(projectA), "HTTP is the canonical scoped revision source");
	} finally {
		socket?.close();
		if (first) await first.service.close();
		if (second) await second.service.close();
		if (writer) await writer.close();
		home.cleanup();
	}
});
