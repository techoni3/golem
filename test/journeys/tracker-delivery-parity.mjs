import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import WebSocket from "ws";

import { createFetchApiClient } from "../../packages/api-client/dist/index.js";
import { invokeMcpTool } from "../../packages/mcp-adapter/dist/index.js";
import {
	BrowserWorkWebSocketFrameSchema,
} from "@golem/contracts";
import { createSessionService } from "@golem/runtime";
import { createTemporaryHome } from "@golem/testkit";
import { createBrowserPrincipalResolver } from "../../apps/control-plane/dist/auth.js";
import { createBrowserWorkServices } from "../../apps/control-plane/dist/browser-work-services.js";
import { openControlPlanePersistence } from "../../apps/control-plane/dist/persistence.js";
import { startControlPlane } from "../../apps/control-plane/dist/server.js";
import {
	composeControlPlaneCommandGateway,
	composeControlPlaneEndpointEligibility,
	composeControlPlaneManagementServices,
	composeControlPlaneTicketDispatchService,
	composeControlPlaneTrackerCoreServices,
	composeControlPlaneTrackerServices,
} from "../../apps/control-plane/dist/tracker.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const projectId = "prj_00000000-0000-4000-8000-000000000082";
const foreignProjectId = "prj_00000000-0000-4000-8000-000000000083";
const sessionId = "ses_00000000-0000-4000-8000-000000000082";
const generationId = "gen_00000000-0000-4000-8000-000000000082";
const token = "golem-gol82-ticket-dispatch-token-000000";
const browserSession = "gol82_browser_session";
const browserCsrf = "gol82_browser_csrf_012345678901234567890";
const foreignSession = "gol82_foreign_browser_session";
const foreignCsrf = "gol82_foreign_browser_csrf_012345678901234";

function clock() {
	let value = "2026-07-23T16:00:00.000Z";
	return {
		now: () => value,
		after: (milliseconds) => new Date(Date.parse(value) + milliseconds).toISOString(),
		advance: (milliseconds) => {
			value = new Date(Date.parse(value) + milliseconds).toISOString();
			return value;
		},
	};
}

function runtimeSignal(sequence) {
	return {
		schema_version: "golem.runtime-signal/v1",
		event_id: `evt_00000000-0000-4000-8000-${String(8200 + sequence).padStart(12, "0")}`,
		event_kind: "session.started",
		producer: "gol82-journey",
		producer_instance_id: "prod_00000000-0000-4000-8000-000000000082",
		producer_sequence: sequence,
		harness: "codex",
		correlation_id: "cor_00000000-0000-4000-8000-000000000082",
		deduplication_key: `gol82-session-${sequence}`,
		clocks: {
			source_observed_at: "2026-07-23T16:00:00.000Z",
			received_at: "2026-07-23T16:00:00.000Z",
			materialized_at: "2026-07-23T16:00:00.000Z",
		},
		provenance: { source: "journey", confidence: "verified", evidence_id: "gol82" },
		clear_fields: [],
		payload: {
			kind: "session.started",
			generation: {
				project_id: projectId,
				session_id: sessionId,
				generation_id: generationId,
			},
			metadata: { role: "builder" },
		},
	};
}

function browserHeaders(origin, session = browserSession, csrf = browserCsrf) {
	return {
		origin,
		cookie: `golem_control_plane_session=${session}`,
		"x-golem-csrf": csrf,
		"content-type": "application/json",
	};
}

function bearerHeaders() {
	return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function json(origin, route, options = {}) {
	const response = await fetch(`${origin}${route}`, options);
	return { status: response.status, body: await response.json() };
}

function nextFrame(socket) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("browser delivery frame timed out")), 4_000);
		const onMessage = (raw) => {
			clearTimeout(timer);
			socket.off("error", onError);
			resolve(String(raw));
		};
		const onError = (error) => {
			clearTimeout(timer);
			socket.off("message", onMessage);
			reject(error);
		};
		socket.once("message", onMessage);
		socket.once("error", onError);
	});
}

function noFrame(socket, milliseconds = 175) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			socket.off("message", onMessage);
			resolve();
		}, milliseconds);
		const onMessage = (raw) => {
			clearTimeout(timer);
			reject(new Error(`off-scope delivery timing leaked: ${String(raw)}`));
		};
		socket.once("message", onMessage);
	});
}

function queueCounts(home) {
	const database = new Database(home.trackerDb, { readonly: true, fileMustExist: true });
	try {
		const envelopes = database
			.prepare("SELECT COUNT(*) AS count FROM tracker_envelopes")
			.get().count;
		const queue = database
			.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'dispatch_queue'")
			.get().count
			? database.prepare("SELECT COUNT(*) AS count FROM dispatch_queue").get().count
			: 0;
		return { envelopes: Number(envelopes), dispatchQueue: Number(queue) };
	} finally {
		database.close();
	}
}

function seed(writer, fixtureClock) {
	writer.runtimeProjectStorage().observe({
		projectId,
		name: "GOL-82 dispatch journey",
		location: {
			locationId: "loc_00000000-0000-4000-8000-000000000082",
			canonicalPath: "/tmp/gol82-dispatch",
			relation: "main",
			source: "register",
			evidence: { journey: true },
			observedAt: fixtureClock.now(),
		},
		source: "register",
		eventId: "evt_00000000-0000-4000-8000-000000000082",
		deduplicationKey: "gol82-project",
		payload: { kind: "project.observed" },
		provenance: { source: "journey", confidence: "verified" },
		occurredAt: fixtureClock.now(),
	});
	assert.equal(
		createSessionService({
			projects: writer.runtimeProjectStorage(),
			sessions: writer.runtimeSessionStorage(),
		}).apply(runtimeSignal(1)).disposition,
		"accepted",
	);
	const endpoints = writer.runtimeEndpointStorage();
	const claim = endpoints.claim({
		generationId,
		routeKind: "delivery",
		ownerInstanceId: "gol82-delivery-owner",
		deliveryMode: "native_channel",
		readiness: "ready",
		controlState: "enabled",
		leaseMs: 60_000,
	});
	assert(claim.endpointId && claim.ownerFence, "fixture owns a canonical fenced endpoint");
	const identity = {
		endpointId: claim.endpointId,
		generationId,
		ownerInstanceId: "gol82-delivery-owner",
		ownerFence: claim.ownerFence,
	};
	assert.equal(endpoints.reportHealth({ ...identity, state: "healthy" }).disposition, "accepted");
	assert.equal(endpoints.probe({ ...identity, consumerReady: true }).disposition, "accepted");
	assert.equal(endpoints.reportReadiness({ ...identity, deliveryMode: "native_channel", readiness: "ready" }).disposition, "accepted");
	assert.equal(endpoints.reportDelivery({ ...identity, status: "delivered", readiness: "ready" }).disposition, "accepted");
	assert.equal(
		endpoints.reportCapability({
			...identity,
			capability: {
				capability: "delivery",
				adapterId: "gol82-journey",
				adapterVersion: "1.0.0",
				qualification: "supported",
				deliveryMode: "native_channel",
				readiness: "ready",
				evidenceKind: "observed",
				observedAt: fixtureClock.now(),
			},
			evidence: { consumed: true },
		}).disposition,
		"accepted",
	);
	const principals = writer.browserPrincipalStorage();
	for (const [id, actorId, project] of [
		["gol82_browser", "act_gol82_browser", projectId],
		["gol82_foreign", "act_gol82_foreign", foreignProjectId],
	])
		principals.provision({
			id,
			actorId,
			role: "operator",
			defaultProjectId: project,
			scopeProjectIds: [project],
		});
	principals.bindCredential({
		bindingId: "gol82_browser",
		adapter: "bearer",
		credential: token,
	});
	const expiresAt = fixtureClock.after(60_000);
	assert.equal(principals.createBrowserSession({ bindingId: "gol82_browser", session: browserSession, csrf: browserCsrf, expiresAt, now: fixtureClock.now() }), true);
	assert.equal(principals.createBrowserSession({ bindingId: "gol82_foreign", session: foreignSession, csrf: foreignCsrf, expiresAt, now: fixtureClock.now() }), true);
}

function compose(writer, fixtureClock, home) {
	const appClock = { now: () => fixtureClock.now(), after: (milliseconds) => fixtureClock.after(milliseconds) };
	const core = composeControlPlaneTrackerCoreServices({ writer, clock: appClock });
	const eligibility = composeControlPlaneEndpointEligibility({ endpoints: writer.runtimeEndpointStorage(), clock: appClock });
	const services = composeControlPlaneTrackerServices({ writer, clock: appClock, eligibility });
	const management = composeControlPlaneManagementServices({ writer, clock: appClock, assetRoot: path.join(home.root, "assets"), tickets: core.tickets });
	const gateway = composeControlPlaneCommandGateway({ writer, clock: appClock, core });
	return {
		core,
		services,
		management,
		gateway,
		ticketDispatch: composeControlPlaneTicketDispatchService({ writer, core, services, eligibility }),
		browserWork: createBrowserWorkServices({
			core,
			management,
			projectRevision: (id) => writer.committedPublicationStorage().projectRevision(id),
		}),
	};
}

async function start(home, writer, fixtureClock) {
	const staticDirectory = path.join(home.root, "static");
	fs.mkdirSync(staticDirectory, { recursive: true });
	fs.writeFileSync(path.join(staticDirectory, "index.html"), "<!doctype html><title>GOL-82</title>");
	const composed = compose(writer, fixtureClock, home);
	const principalResolver = createBrowserPrincipalResolver({
		storage: writer.browserPrincipalStorage(),
		clock: { now: () => Date.parse(fixtureClock.now()) },
	});
	const service = await startControlPlane({
		token,
		stateDirectory: path.join(home.root, "control-plane"),
		staticDirectory,
		trackerCore: composed.core,
		trackerServices: composed.services,
		management: composed.management,
		commandGateway: composed.gateway,
		ticketDispatch: composed.ticketDispatch,
		browserWork: composed.browserWork,
		committedPublications: writer.committedPublicationStorage(),
		principalResolver,
		projection: { read: () => ({}), revision: (_stream, id) => id ? writer.committedPublicationStorage().projectRevision(id) : 0 },
	});
	return { service, ...composed };
}

function ticket(core, title, assignee = sessionId) {
	return core.tickets.create({
		projectId,
		kind: "work-item",
		title,
		assignee,
		actor: "act_gol82_browser",
	});
}

export async function exerciseBrowserTrackerDeliveryParity() {
	const home = createTemporaryHome("golem-gol82-browser-delivery-");
	const fixtureClock = clock();
	let writer;
	let control;
	let socket;
	let foreignSocket;
	try {
		writer = openControlPlanePersistence({ runtimePath: home.runtimeDb, trackerPath: home.trackerDb, lockPath: path.join(home.root, "owner.lock") }, { ownerId: "gol82-browser", clock: fixtureClock });
		seed(writer, fixtureClock);
		control = await start(home, writer, fixtureClock);
		const origin = control.service.origin;
		const browserTicket = ticket(control.core, "browser canonical dispatch");
		const bearerTicket = ticket(control.core, "bearer canonical dispatch");
		const mcpTicket = ticket(control.core, "mcp canonical dispatch");
		const browserBody = { kind: "dispatch", opaque_id: browserTicket.id, expected_revision: browserTicket.revision, idempotency_key: "gol82:browser" };
		const browser = await json(origin, "/api/v1/browser/work/commands", { method: "POST", headers: browserHeaders(origin), body: JSON.stringify(browserBody) });
		assert.equal(browser.status, 200);
		assert.deepEqual(browser.body.result.disposition, "queued");
		assert.equal(browser.body.result.operation_id, browser.body.command_id);
		const bearerBody = { expected_revision: bearerTicket.revision, idempotency_key: "gol82:bearer" };
		const bearer = await json(origin, `/api/v1/tracker/tickets/${bearerTicket.id}/dispatch`, { method: "POST", headers: bearerHeaders(), body: JSON.stringify(bearerBody) });
		assert.equal(bearer.status, 201);
		assert.equal(bearer.body.result.disposition, "queued");
		const mcp = await invokeMcpTool(
			createFetchApiClient(origin, { bearerToken: token, caller: { projectId, sessionId } }),
			"ticket_dispatch",
			{ id: mcpTicket.id, session_id: sessionId, expected_revision: mcpTicket.revision, idempotency_key: "gol82:mcp" },
		);
		assert.equal(mcp.isError, undefined);
		assert.equal(JSON.parse(mcp.content[0].text).result.disposition, "queued");
		assert.deepEqual(queueCounts(home), { envelopes: 3, dispatchQueue: 0 }, "browser, bearer, and MCP each queue only canonical envelopes");

		const foreignTicket = control.core.tickets.create({ projectId: foreignProjectId, kind: "work-item", title: "foreign", assignee: sessionId, actor: "act_gol82_foreign" });
		const foreign = await json(origin, "/api/v1/browser/work/commands", { method: "POST", headers: browserHeaders(origin), body: JSON.stringify({ kind: "dispatch", opaque_id: foreignTicket.id, expected_revision: foreignTicket.revision, idempotency_key: "gol82:foreign" }) });
		assert.equal(foreign.status, 404, "cross-scope browser target is non-disclosing");
		assert.equal(JSON.stringify(foreign.body).includes(foreignTicket.id), false);
		const beforeForgery = queueCounts(home);
		for (const key of ["session_id", "generation_id", "endpoint", "fence", "readiness", "acknowledgement_id", "settlement"]) {
			const forged = await json(origin, "/api/v1/browser/work/commands", { method: "POST", headers: browserHeaders(origin), body: JSON.stringify({ ...browserBody, idempotency_key: `gol82:forged:${key}`, [key]: "forged" }) });
			assert.equal(forged.status, key === "session_id" || key === "fence" ? 403 : 400, `${key} rejects before mutation`);
		}
		assert.deepEqual(queueCounts(home), beforeForgery);

		socket = new WebSocket(`${origin.replace("http", "ws")}/api/v1/ws?stream=communication.operations`, { headers: { origin, cookie: `golem_control_plane_session=${browserSession}` } });
		foreignSocket = new WebSocket(`${origin.replace("http", "ws")}/api/v1/ws?stream=communication.operations`, { headers: { origin, cookie: `golem_control_plane_session=${foreignSession}` } });
		BrowserWorkWebSocketFrameSchema.parse(JSON.parse(await nextFrame(socket)));
		BrowserWorkWebSocketFrameSchema.parse(JSON.parse(await nextFrame(foreignSocket)));
		const claims = await json(origin, "/api/v1/delivery/claims", { method: "POST", headers: bearerHeaders(), body: JSON.stringify({ limit: 10 }) });
		const claim = claims.body.items.find((item) => item.payload.ticket_id === browserTicket.id);
		assert.ok(claim, "browser dispatch has a real claimable canonical envelope");
		const prepared = await json(origin, `/api/v1/delivery/claims/${encodeURIComponent(claim.claimToken)}/prepare`, { method: "POST", headers: bearerHeaders(), body: "{}" });
		assert.equal(prepared.status, 200);
		const beforeAck = writer.committedPublicationStorage().projectRevision(projectId);
		const acknowledged = await json(origin, `/api/v1/delivery/claims/${encodeURIComponent(claim.claimToken)}/ack`, { method: "POST", headers: bearerHeaders(), body: JSON.stringify({ acknowledgement_id: "ack_gol82_browser", payload: {} }) });
		assert.equal(acknowledged.status, 200, "settlement remains the later canonical callback");
		assert.equal(writer.committedPublicationStorage().projectRevision(projectId), beforeAck + 1);
		const delta = BrowserWorkWebSocketFrameSchema.parse(JSON.parse(await nextFrame(socket)));
		assert.equal(delta.payload.kind, "delta");
		await noFrame(foreignSocket);

		await control.service.close();
		control = undefined;
		await writer.close();
		writer = openControlPlanePersistence({ runtimePath: home.runtimeDb, trackerPath: home.trackerDb, lockPath: path.join(home.root, "owner.lock") }, { ownerId: "gol82-browser-restart", clock: fixtureClock });
		const restarted = await start(home, writer, fixtureClock);
		control = restarted;
		const replay = await json(restarted.service.origin, "/api/v1/browser/work/commands", { method: "POST", headers: browserHeaders(restarted.service.origin), body: JSON.stringify(browserBody) });
		assert.deepEqual(replay.body, browser.body, "restart duplicate replays the original durable browser outcome");
		assert.deepEqual(queueCounts(home), { envelopes: 3, dispatchQueue: 0 });
		return "real managed SQLite browser cookie/CSRF, bearer HTTP, MCP, restart replay, canonical claim/ack callback, and scoped WebSocket invalidation converge on tracker_envelopes without legacy dispatch_queue";
	} finally {
		if (socket) socket.terminate();
		if (foreignSocket) foreignSocket.terminate();
		if (control) await control.service.close();
		if (writer) await writer.close();
		home.cleanup();
		assert.equal(fs.existsSync(home.root), false, "GOL-82 browser parity leaves no shared state");
	}
}

export async function exerciseTicketDispatchHttpMcpParity() {
	const home = createTemporaryHome("golem-gol82-http-mcp-");
	const fixtureClock = clock();
	let writer;
	let control;
	try {
		writer = openControlPlanePersistence({ runtimePath: home.runtimeDb, trackerPath: home.trackerDb, lockPath: path.join(home.root, "owner.lock") }, { ownerId: "gol82-http-mcp", clock: fixtureClock });
		seed(writer, fixtureClock);
		control = await start(home, writer, fixtureClock);
		const origin = control.service.origin;
		const pullTicket = ticket(control.core, "pull-only ticket");
		const endpoint = writer.runtimeEndpointStorage().list(generationId)[0];
		assert(endpoint, "fixture endpoint exists");
		assert.equal(writer.runtimeEndpointStorage().reportReadiness({ endpointId: endpoint.endpointId, generationId, ownerInstanceId: "gol82-delivery-owner", ownerFence: endpoint.ownerFence, deliveryMode: "pull", readiness: "pull_only" }).disposition, "accepted");
		const pull = await json(origin, `/api/v1/tracker/tickets/${pullTicket.id}/dispatch`, { method: "POST", headers: bearerHeaders(), body: JSON.stringify({ expected_revision: pullTicket.revision, idempotency_key: "gol82:pull" }) });
		assert.equal(pull.status, 201);
		assert.equal(pull.body.result.disposition, "pull_only");
		assert.deepEqual(queueCounts(home), { envelopes: 1, dispatchQueue: 0 });
		const noAssignee = control.core.tickets.create({ projectId, kind: "work-item", title: "legacy assignment", actor: "act_gol82_browser" });
		const legacyMcp = await invokeMcpTool(createFetchApiClient(origin, { bearerToken: token, caller: { projectId, sessionId } }), "ticket_dispatch", { id: noAssignee.id, session_id: sessionId, expected_revision: noAssignee.revision, idempotency_key: "gol82:legacy-hint" });
		assert.equal(legacyMcp.isError, undefined);
		assert.equal(
			JSON.parse(legacyMcp.content[0].text).result.disposition,
			"pull_only",
			"legacy hint fills only an absent current assignee",
		);
		assert.equal(control.core.tickets.get(noAssignee.id)?.ticket.assignee, sessionId);
		assert.equal(control.core.tickets.get(noAssignee.id)?.ticket.dispatchedTo, sessionId);

		const ineligible = control.core.tickets.create({ projectId, kind: "work-item", title: "human assignee", assignee: "human", actor: "act_gol82_browser" });
		const beforeIneligible = queueCounts(home);
		const refused = await json(origin, `/api/v1/tracker/tickets/${ineligible.id}/dispatch`, { method: "POST", headers: bearerHeaders(), body: JSON.stringify({ expected_revision: ineligible.revision, idempotency_key: "gol82:ineligible" }) });
		assert.equal(refused.status, 201);
		assert.equal(refused.body.result.disposition, "ineligible");
		assert.deepEqual(queueCounts(home), beforeIneligible);

		const stale = await json(origin, `/api/v1/tracker/tickets/${pullTicket.id}/dispatch`, { method: "POST", headers: bearerHeaders(), body: JSON.stringify({ expected_revision: pullTicket.revision, idempotency_key: "gol82:stale" }) });
		assert.equal(stale.status, 200);
		assert.equal(stale.body.result.disposition, "stale");
		assert.deepEqual(queueCounts(home), beforeIneligible);

		const claims = await json(origin, "/api/v1/delivery/claims", { method: "POST", headers: bearerHeaders(), body: JSON.stringify({ limit: 10 }) });
		const pullClaim = claims.body.items.find((item) => item.payload.ticket_id === pullTicket.id);
		assert.ok(pullClaim);
		const prepared = await json(origin, `/api/v1/delivery/claims/${encodeURIComponent(pullClaim.claimToken)}/prepare`, { method: "POST", headers: bearerHeaders(), body: "{}" });
		assert.equal(prepared.status, 200, "pull-only classification remains a canonical queue, not synthetic success");
		const beforeFailure = writer.committedPublicationStorage().projectRevision(projectId);
		const failed = await json(origin, `/api/v1/delivery/claims/${encodeURIComponent(pullClaim.claimToken)}/fail`, { method: "POST", headers: bearerHeaders(), body: JSON.stringify({ error: "delivery failed" }) });
		assert.equal(failed.status, 200);
		assert.equal(writer.committedPublicationStorage().projectRevision(projectId), beforeFailure + 1, "later failure callback alone publishes its committed delta");
		const nextTurnTicket = ticket(control.core, "next-turn ticket");
		assert.equal(
			writer.runtimeEndpointStorage().reportReadiness({
				endpointId: endpoint.endpointId,
				generationId,
				ownerInstanceId: "gol82-delivery-owner",
				ownerFence: endpoint.ownerFence,
				deliveryMode: "next_turn",
				readiness: "next_turn",
			}).disposition,
			"accepted",
		);
		const nextTurn = await json(
			origin,
			`/api/v1/tracker/tickets/${nextTurnTicket.id}/dispatch`,
			{
				method: "POST",
				headers: bearerHeaders(),
				body: JSON.stringify({
					expected_revision: nextTurnTicket.revision,
					idempotency_key: "gol82:next-turn",
				}),
			},
		);
		assert.equal(nextTurn.status, 201);
		assert.equal(nextTurn.body.result.disposition, "next_turn");
		assert.deepEqual(queueCounts(home), { envelopes: 3, dispatchQueue: 0 });
		return "real managed SQLite bearer and MCP adapters share ticket dispatch classification, trusted legacy hint reconciliation, ineligible/stale no-envelope behavior, and later fail callback publication";
	} finally {
		if (control) await control.service.close();
		if (writer) await writer.close();
		home.cleanup();
		assert.equal(fs.existsSync(home.root), false, "GOL-82 HTTP/MCP parity leaves no shared state");
	}
}
