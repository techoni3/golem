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
	return {
		now: () => new Date().toISOString(),
		after: (milliseconds) => new Date(Date.now() + milliseconds).toISOString(),
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
		const created = await invokeMcpTool(mcp, "ticket_create", {
			title: "committed invalidation ticket",
			body: "private ticket prose must never cross the websocket",
			idempotency_key: "gol80:mcp:create",
		});
		assert.equal(created.isError, undefined, "MCP delegates to the gateway");
		const ticket = JSON.parse(created.content[0].text).result;
		const delta = await nextFrame(socket);
		assert.equal(delta.payload.kind, "delta");
		assert.deepEqual(delta.payload.delta, { kind: "invalidation", category: "tracker" });
		assert.doesNotMatch(JSON.stringify(delta), /private ticket prose|gol80-principal-a-token/u, "frame is opaque");

		const updated = await request(origin, tokenA, `/api/v1/tracker/tickets/${ticket.id}`, {
			method: "PATCH",
			body: JSON.stringify({ expected_revision: ticket.revision, title: "canonical revision advance", idempotency_key: "gol80:http:update" }),
		});
		assert.equal(updated.status, 200, "bearer HTTP mutation succeeds");
		const revisionAfterWrite = writer.committedPublicationStorage().projectRevision(projectA);
		assert.ok(revisionAfterWrite > 0, "canonical project revision advances in SQLite");
		const stale = await request(origin, tokenA, `/api/v1/tracker/tickets/${ticket.id}`, {
			method: "PATCH",
			body: JSON.stringify({ expected_revision: ticket.revision, title: "stale", idempotency_key: "gol80:http:stale" }),
		});
		assert.equal(stale.status, 409, "stale CAS is rejected");
		assert.equal(writer.committedPublicationStorage().projectRevision(projectA), revisionAfterWrite, "stale write emits no invalidation");

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
		assert.equal(writer.committedPublicationStorage().projectRevision(projectA), revisionAfterWrite, "rolled-back domain write emits no invalidation");

		const gate = await request(origin, tokenA, "/api/v1/management/gates", {
			method: "POST",
			body: JSON.stringify({ kind: "approval", question: "GOL-80 gate", assignee: "ses_gol80_a", idempotency_key: "gol80:gate" }),
		});
		assert.equal(gate.status, 201, "management write uses the same transaction owner");
		const asset = await request(origin, tokenA, "/api/v1/management/assets", {
			method: "POST",
			body: JSON.stringify({ ticket_id: ticket.id, relative_path: "evidence.png", mime_type: "image/png", content_base64: Buffer.from("asset bytes").toString("base64"), idempotency_key: "gol80:asset" }),
		});
		assert.equal(asset.status, 201, `asset metadata write is committed with an invalidation: ${JSON.stringify(asset.body)}`);

		const envelope = await request(origin, tokenA, "/api/v1/delivery/envelopes", {
			method: "POST",
			body: JSON.stringify({ id: "env_gol80_settlement", idempotency_key: "gol80:delivery", recipient_id: "recipient_gol80", kind: "ticket_dispatch", payload: { ticket: ticket.id } }),
		});
		assert.equal(envelope.status, 201, "delivery enqueue is committed");
		const claim = control.services.delivery.claim("ses_gol80_a", 1)[0];
		assert.ok(claim, "the real delivery service claims the HTTP-created envelope");
		assert.equal(claim.prepare().kind, "deliver", "delivery rechecks the canonical endpoint before settlement");
		assert.equal(claim.acknowledge("ack_gol80", {}), true, "delivery acknowledgement is committed");
		const settlementEnvelope = await request(origin, tokenA, "/api/v1/delivery/envelopes", {
			method: "POST",
			body: JSON.stringify({ id: "env_gol80_delivered", idempotency_key: "gol80:delivery:delivered", recipient_id: "recipient_gol80", kind: "ticket_dispatch", payload: { ticket: ticket.id } }),
		});
		assert.equal(settlementEnvelope.status, 201);
		const settlementClaim = control.services.delivery.claim("ses_gol80_a", 1)[0];
		assert.ok(settlementClaim);
		assert.equal(settlementClaim.prepare().kind, "deliver");
		assert.equal(settlementClaim.delivered().status, "delivered", "delivery settlement is committed");

		// Let the owner drain the preceding same-project writes before opening
		// the observation window; the following assertion then attributes any
		// frame only to the foreign-project mutation.
		await new Promise((resolve) => setTimeout(resolve, 120));
		const absence = noFrame(socket, 220);
		const projectBWrite = await request(origin, tokenB, "/api/v1/tracker/tickets", { method: "POST", body: JSON.stringify({ title: "private B", idempotency_key: "gol80:project-b" }) });
		assert.equal(projectBWrite.status, 201);
		await absence;
		assert.ok(writer.committedPublicationStorage().projectRevision(projectA) > revisionAfterWrite, "management, asset, and delivery paths advance the project revision");
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
