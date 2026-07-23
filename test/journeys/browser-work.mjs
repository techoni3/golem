import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import WebSocket from "ws";

import { createBrowserControlPlaneClient } from "../../packages/api-client/dist/index.js";

import { createBrowserPrincipalResolver } from "../../apps/control-plane/dist/auth.js";
import { createBrowserWorkServices } from "../../apps/control-plane/dist/browser-work-services.js";
import { openControlPlanePersistence } from "../../apps/control-plane/dist/persistence.js";
import { startControlPlane } from "../../apps/control-plane/dist/server.js";
import {
	composeControlPlaneCommandGateway,
	composeControlPlaneManagementServices,
	composeControlPlaneTrackerCoreServices,
	composeControlPlaneTrackerServices,
} from "../../apps/control-plane/dist/tracker.js";
import { createTemporaryHome } from "@golem/testkit";

const projectA = "prj_browser_work_alpha";
const projectB = "prj_browser_work_beta";

function clock() {
	let now = "2026-07-23T12:00:00.000Z";
	return {
		now: () => Date.parse(now),
		iso: () => now,
		advance(milliseconds) {
			now = new Date(Date.parse(now) + milliseconds).toISOString();
			return now;
		},
	};
}

function headers(origin, session, csrf) {
	return {
		origin,
		cookie: `golem_control_plane_session=${session}`,
		...(csrf ? { "x-golem-csrf": csrf } : {}),
		"content-type": "application/json",
	};
}

async function json(origin, route, options = {}) {
	const response = await fetch(`${origin}${route}`, options);
	return { status: response.status, body: await response.json() };
}

function nextFrame(socket) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error("browser work WebSocket timed out"));
		}, 4_000);
		const message = (raw) => {
			cleanup();
			resolve(String(raw));
		};
		const error = (reason) => {
			cleanup();
			reject(reason);
		};
		const cleanup = () => {
			clearTimeout(timeout);
			socket.off("message", message);
			socket.off("error", error);
		};
		socket.on("message", message);
		socket.on("error", error);
	});
}

function noFrame(socket, milliseconds = 175) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup();
			resolve();
		}, milliseconds);
		const message = (raw) => {
			cleanup();
			reject(new Error(`foreign browser invalidation leaked: ${String(raw)}`));
		};
		const error = (reason) => {
			cleanup();
			reject(reason);
		};
		const cleanup = () => {
			clearTimeout(timeout);
			socket.off("message", message);
			socket.off("error", error);
		};
		socket.on("message", message);
		socket.on("error", error);
	});
}

function closedSocket(socket) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error("browser-only WebSocket was not rejected"));
		}, 4_000);
		const close = (code) => {
			cleanup();
			resolve(code);
		};
		const message = (raw) => {
			cleanup();
			reject(new Error(`bearer fallback leaked a frame: ${String(raw)}`));
		};
		const error = (reason) => {
			cleanup();
			reject(reason);
		};
		const cleanup = () => {
			clearTimeout(timeout);
			socket.off("close", close);
			socket.off("message", message);
			socket.off("error", error);
		};
		socket.on("close", close);
		socket.on("message", message);
		socket.on("error", error);
	});
}

function session(storage, bindingId, name, fixtureClock, expiresAt) {
	const value = `browser_${name}_session`;
	const csrf = `browser_${name}_csrf_012345678901234567890123`;
	assert.equal(
		storage.createBrowserSession({
			bindingId,
			session: value,
			csrf,
			expiresAt,
			now: fixtureClock.iso(),
		}),
		true,
		"durable browser session must be issued",
	);
	return { session: value, csrf };
}

function compose(writer, fixtureClock, home) {
	const appClock = {
		now: () => fixtureClock.iso(),
		after: (milliseconds) =>
			new Date(fixtureClock.now() + milliseconds).toISOString(),
	};
	const core = composeControlPlaneTrackerCoreServices({ writer, clock: appClock });
	const management = composeControlPlaneManagementServices({
		writer,
		clock: appClock,
		assetRoot: path.join(home.root, "assets"),
		tickets: core.tickets,
	});
	return {
		core,
		management,
		services: composeControlPlaneTrackerServices({
			writer,
			clock: appClock,
			eligibility: { resolve: () => undefined },
		}),
		gateway: composeControlPlaneCommandGateway({
			writer,
			clock: appClock,
			core,
		}),
		browserWork: createBrowserWorkServices({
			core,
			management,
			projectRevision: (projectId) =>
				writer.committedPublicationStorage().projectRevision(projectId),
		}),
	};
}

function bindings(writer, fixtureClock) {
	const storage = writer.browserPrincipalStorage();
	for (const [id, actorId, role, projectId] of [
		["browser_work_alpha", "actor_browser_alpha", "operator", projectA],
		["browser_work_beta", "actor_browser_beta", "operator", projectB],
		["browser_work_viewer", "actor_browser_viewer", "viewer", projectA],
	])
		storage.provision({
			id,
			actorId,
			role,
			defaultProjectId: projectId,
			scopeProjectIds: [projectId],
		});
	storage.bindCredential({
		bindingId: "browser_work_alpha",
		adapter: "bearer",
		credential: "browser-work-openapi-token",
	});
	const expiresAt = new Date(fixtureClock.now() + 60_000).toISOString();
	return {
		storage,
		resolver: createBrowserPrincipalResolver({
			storage,
			clock: { now: () => fixtureClock.now() },
		}),
		alpha: session(storage, "browser_work_alpha", "alpha", fixtureClock, expiresAt),
		beta: session(storage, "browser_work_beta", "beta", fixtureClock, expiresAt),
		viewer: session(storage, "browser_work_viewer", "viewer", fixtureClock, expiresAt),
	};
}

async function start(home, writer, fixtureClock) {
	const staticDirectory = path.join(home.root, "static");
	fs.mkdirSync(staticDirectory, { recursive: true });
	fs.writeFileSync(path.join(staticDirectory, "index.html"), "<!doctype html><title>browser-work</title>");
	const composed = compose(writer, fixtureClock, home);
	const identity = bindings(writer, fixtureClock);
	const service = await startControlPlane({
		token: "golem-browser-work-route-token-000000000000",
		stateDirectory: path.join(home.root, "control-plane"),
		staticDirectory,
		trackerCore: composed.core,
		trackerServices: composed.services,
		management: composed.management,
		commandGateway: composed.gateway,
		browserWork: composed.browserWork,
		committedPublications: writer.committedPublicationStorage(),
		principalResolver: identity.resolver,
		projection: {
			read: () => ({}),
			revision: (_stream, projectId) =>
				projectId ? writer.committedPublicationStorage().projectRevision(projectId) : 0,
		},
	});
	return { service, ...composed, ...identity };
}

export async function exerciseBrowserWorkOpaqueProjection() {
	const home = createTemporaryHome("golem-gol81-projection-");
	const fixtureClock = clock();
	let writer;
	let control;
	let socket;
	const hostile = [
		"prompt: private browser work instruction",
		"cookie: browser_alpha_session",
		"csrf: browser_alpha_csrf_012345678901234567890123",
		"bearer: browser-bearer-secret",
		"fence: owner-fence-secret",
		"/private/browser-work-storage-path",
		"command prose must not cross browser work",
	];
	try {
		writer = openControlPlanePersistence({
			runtimePath: home.runtimeDb,
			trackerPath: home.trackerDb,
			lockPath: path.join(home.root, "owner.lock"),
		}, { ownerId: "gol81-projection", clock: { now: () => fixtureClock.iso() } });
		control = await start(home, writer, fixtureClock);
		const alphaTicket = control.core.tickets.create({
			projectId: projectA,
			title: hostile[0],
			body: hostile.join(" "),
			actor: "actor_browser_alpha",
		});
		const betaTicket = control.core.tickets.create({
			projectId: projectB,
			title: hostile[0],
			body: hostile.join(" "),
			actor: "actor_browser_beta",
		});
		for (let index = 0; index < 100; index += 1)
			control.core.tickets.create({
				projectId: projectA,
				title: `bounded page ${index}`,
				actor: "actor_browser_alpha",
			});
		control.management.controls.request({
			projectId: projectA,
			command: hostile[6],
			payload: { note: hostile[0] },
			actor: "actor_browser_alpha",
			idempotencyKey: "gol81:control",
		});
		control.management.communications.create({
			projectId: projectA,
			kind: "brief",
			command: hostile[6],
			payload: { note: hostile[0] },
			actor: "actor_browser_alpha",
			idempotencyKey: "gol81:communication",
		});
		const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
		const asset = control.management.assets.put({
			projectId: projectA,
			ticketId: alphaTicket.id,
			relativePath: "preview.png",
			mimeType: "image/png",
			bytes: image,
			actor: "actor_browser_alpha",
		});

		const origin = control.service.origin;
		const alphaHeaders = headers(origin, control.alpha.session);
		const betaHeaders = headers(origin, control.beta.session);
		const browserClient = createBrowserControlPlaneClient(origin, {
			headers: { cookie: alphaHeaders.cookie, origin },
		});
		const legacyRuntime = await browserClient.projection("runtime.live");
		assert.equal(legacyRuntime.stream, "runtime.live");
		assert.equal(
			legacyRuntime.schema_version,
			"golem.control-plane-projection/v1",
			"generated client retains the legacy runtime projection path",
		);
		const typedBrowserBoard = await browserClient.browserWorkProjection("tracker.board");
		assert.equal(typedBrowserBoard.stream, "tracker.board");
		const bearerOnly = {
			origin,
			authorization: "Bearer browser-work-openapi-token",
			cookie: "golem_control_plane_session=invalid_browser_session",
		};
		const bearerProjection = await json(origin, "/api/v1/projections/tracker.board", {
			headers: bearerOnly,
		});
		assert.equal(bearerProjection.status, 401, "bearer cannot rescue browser projection");
		let firstBoard;
		for (const stream of [
			"tracker.board",
			"tracker.tree",
			"management.controls",
			"communication.operations",
		]) {
			const response = await json(origin, `/api/v1/projections/${stream}`, {
				headers: alphaHeaders,
			});
			assert.equal(response.status, 200, `${stream} is a browser-session projection`);
			assert.equal(response.body.stream, stream);
			assert.doesNotMatch(JSON.stringify(response.body), new RegExp(`${betaTicket.id}|${hostile.join("|")}`, "u"));
			if (stream === "tracker.board") {
				firstBoard = response.body;
				assert.equal(response.body.items.length, 100, "board page is bounded");
				assert.equal(response.body.next_cursor, "bwp_1");
				const secondPage = await json(
					origin,
					`/api/v1/projections/${stream}?cursor=${response.body.next_cursor}`,
					{ headers: alphaHeaders },
				);
				assert.equal(secondPage.status, 200);
				assert.equal(secondPage.body.items.length, 1);
				assert.equal(secondPage.body.next_cursor, null);
			}
		}
		const detail = await json(origin, `/api/v1/browser/work/items/${alphaTicket.id}`, {
			headers: alphaHeaders,
		});
		assert.equal(detail.status, 200);
		assert.equal(detail.body.item.opaque_id, alphaTicket.id);
		assert.doesNotMatch(JSON.stringify(detail.body), new RegExp(hostile.join("|"), "u"));
		const foreignDetail = await json(origin, `/api/v1/browser/work/items/${betaTicket.id}`, {
			headers: alphaHeaders,
		});
		assert.equal(foreignDetail.status, 404, "foreign detail is indistinguishable from absence");
		assert.equal(JSON.stringify(foreignDetail.body).includes(betaTicket.id), false);
		const assetResponse = await json(
			origin,
			`/api/v1/browser/work/items/${alphaTicket.id}/assets/${asset.id}`,
			{ headers: alphaHeaders },
		);
		assert.equal(assetResponse.status, 200);
		assert.equal(assetResponse.body.asset.opaque_id, asset.id);
		assert.equal(assetResponse.body.asset.byte_size, image.byteLength);
		assert.equal(
			Buffer.from(assetResponse.body.content_base64, "base64").byteLength,
			assetResponse.body.asset.byte_size,
			"management asset read preserves byte-size integrity",
		);
		assert.equal(JSON.stringify(assetResponse.body).includes("preview.png"), false);
		assert.equal(JSON.stringify(assetResponse.body).includes("storage-path"), false);
		const foreignAsset = await json(
			origin,
			`/api/v1/browser/work/items/${alphaTicket.id}/assets/${asset.id}`,
			{ headers: betaHeaders },
		);
		assert.equal(foreignAsset.status, 404, "foreign asset is indistinguishable from absence");
		assert.equal(JSON.stringify(foreignAsset.body).includes(alphaTicket.id), false);
		assert.equal(JSON.stringify(foreignAsset.body).includes(asset.id), false);
		const bearerSocket = new WebSocket(
			`${origin.replace("http", "ws")}/api/v1/ws?stream=tracker.tree`,
			{ headers: { ...bearerOnly, host: new URL(origin).host } },
		);
		assert.equal(await closedSocket(bearerSocket), 1008, "bearer cannot rescue browser WS");

		socket = new WebSocket(`${origin.replace("http", "ws")}/api/v1/ws?stream=tracker.tree`, {
			headers: { cookie: alphaHeaders.cookie, origin },
		});
		const snapshot = browserClient.parseBrowserWorkWebSocketFrame(
			await nextFrame(socket),
		);
		assert.equal(snapshot.payload.kind, "snapshot");
		assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(hostile.join("|"), "u"));
		control.core.tickets.update({
			id: betaTicket.id,
			expectedRevision: betaTicket.revision,
			patch: { title: "beta-only" },
			actor: "actor_browser_beta",
		});
		await noFrame(socket);
		const boardAfterForeignMutation = await json(
			origin,
			"/api/v1/projections/tracker.board",
			{ headers: alphaHeaders },
		);
		assert.equal(boardAfterForeignMutation.status, 200);
		assert.deepEqual(
			boardAfterForeignMutation.body,
			firstBoard,
			"foreign mutation leaves the first scoped page, cursor, and revision unchanged",
		);
		control.core.tickets.update({
			id: alphaTicket.id,
			expectedRevision: alphaTicket.revision,
			patch: { title: "alpha-only" },
			actor: "actor_browser_alpha",
		});
		const delta = browserClient.parseBrowserWorkWebSocketFrame(await nextFrame(socket));
		assert.equal(delta.payload.kind, "delta");
		assert.deepEqual(delta.payload.delta, { kind: "invalidation", category: "tracker" });
		assert.doesNotMatch(JSON.stringify(delta), new RegExp(hostile.join("|"), "u"));
		const document = await json(origin, "/api/v1/openapi.json", {
			headers: { authorization: "Bearer browser-work-openapi-token" },
		});
		assert.equal(document.status, 200);
		const projectionRoute = document.body.paths["/api/v1/projections/{stream}"].get;
		const projectionStream = projectionRoute.parameters.find(
			(parameter) => parameter.name === "stream",
		);
		assert.equal(projectionRoute.security.length, 1);
		assert.deepEqual(projectionRoute.security[0], { BrowserSession: [] });
		assert.equal(projectionStream.schema.enum.includes("runtime.live"), true);
		assert.equal(projectionStream.schema.enum.includes("tracker.board"), true);
		const commandRoute = document.body.paths["/api/v1/browser/work/commands"].post;
		assert.equal(commandRoute.security.length, 1);
		assert.deepEqual(commandRoute.security[0], {
			BrowserSession: [],
			BrowserCsrf: [],
		});
		assert.equal(JSON.stringify(projectionRoute.security).includes("Bearer"), false);
		assert.equal(JSON.stringify(commandRoute.security).includes("Bearer"), false);
		assert.equal(JSON.stringify(document.body).includes(hostile[0]), false, "OpenAPI has no hostile example");
		return "real managed SQLite browser-session projections, detail, asset, and scoped WS invalidation remain bounded and opaque";
	} finally {
		socket?.close();
		if (control) await control.service.close();
		if (writer) await writer.close();
		home.cleanup();
	}
}

export async function exerciseBrowserWorkCommandAuthority() {
	const home = createTemporaryHome("golem-gol81-command-");
	const fixtureClock = clock();
	let writer;
	let control;
	try {
		writer = openControlPlanePersistence({
			runtimePath: home.runtimeDb,
			trackerPath: home.trackerDb,
			lockPath: path.join(home.root, "owner.lock"),
		}, { ownerId: "gol81-command", clock: { now: () => fixtureClock.iso() } });
		control = await start(home, writer, fixtureClock);
		const origin = control.service.origin;
		const bootstrapRequest = {
			headers: { origin, host: new URL(origin).host },
			protocol: "http",
		};
		const viewerBootstrap = createBrowserPrincipalResolver({
			storage: control.storage,
			localOperatorBindingId: "browser_work_viewer",
			clock: { now: () => fixtureClock.now() },
		});
		const operatorBootstrap = createBrowserPrincipalResolver({
			storage: control.storage,
			localOperatorBindingId: "browser_work_alpha",
			clock: { now: () => fixtureClock.now() },
		});
		assert.equal(
			viewerBootstrap.bootstrap(bootstrapRequest).ok,
			false,
			"configured viewer cannot bootstrap a browser session",
		);
		assert.equal(
			operatorBootstrap.bootstrap(bootstrapRequest).ok,
			true,
			"configured operator can bootstrap a browser session",
		);
		const operatorHeaders = headers(origin, control.alpha.session, control.alpha.csrf);
		const createBody = {
			kind: "ticket.create",
			idempotency_key: "gol81:ticket:create",
			title: "prompt text must not be reflected",
		};
		const beforeBearerCommand = writer
			.committedPublicationStorage()
			.projectRevision(projectA);
		const bearerCommand = await json(origin, "/api/v1/browser/work/commands", {
			method: "POST",
			headers: {
				origin,
				authorization: "Bearer browser-work-openapi-token",
				cookie: "golem_control_plane_session=invalid_browser_session",
				"content-type": "application/json",
			},
			body: JSON.stringify(createBody),
		});
		assert.equal(bearerCommand.status, 401, "bearer cannot rescue browser command");
		assert.equal(
			writer.committedPublicationStorage().projectRevision(projectA),
			beforeBearerCommand,
		);
		const beforeCreate = writer.committedPublicationStorage().projectRevision(projectA);
		const created = await json(origin, "/api/v1/browser/work/commands", {
			method: "POST",
			headers: operatorHeaders,
			body: JSON.stringify(createBody),
		});
		assert.equal(created.status, 200);
		assert.equal(created.body.status, "completed");
		assert.equal(created.body.result.kind, "ticket");
		assert.equal(created.body.resource_revision, beforeCreate + 1);
		assert.equal(JSON.stringify(created.body).includes(createBody.title), false);
		const interveningGate = await json(origin, "/api/v1/browser/work/commands", {
			method: "POST",
			headers: operatorHeaders,
			body: JSON.stringify({
				kind: "management.gate.create",
				idempotency_key: "gol81:gate:create",
				gate_kind: "approval",
				question: "private command prose must not be reflected",
				assignee: "human",
			}),
		});
		assert.equal(interveningGate.status, 200);
		assert.equal(interveningGate.body.result.kind, "gate");
		assert.equal(JSON.stringify(interveningGate.body).includes("private command prose"), false);
		const beforeDuplicate = writer.committedPublicationStorage().projectRevision(projectA);
		const outboxBeforeDuplicate = writer
			.committedPublicationStorage()
			.outboxCount(projectA);
		const duplicate = await json(origin, "/api/v1/browser/work/commands", {
			method: "POST",
			headers: operatorHeaders,
			body: JSON.stringify(createBody),
		});
		assert.equal(duplicate.status, 200, "identical retry returns the original outcome");
		assert.deepEqual(duplicate.body, created.body, "retry preserves the original safe response");
		assert.equal(writer.committedPublicationStorage().projectRevision(projectA), beforeDuplicate);
		assert.equal(writer.committedPublicationStorage().outboxCount(projectA), outboxBeforeDuplicate);
		const ticket = created.body.result.ticket;
		const update = await json(origin, "/api/v1/browser/work/commands", {
			method: "POST",
			headers: operatorHeaders,
			body: JSON.stringify({
				kind: "ticket.update",
				idempotency_key: "gol81:ticket:update",
				opaque_id: ticket.opaque_id,
				expected_revision: ticket.revision,
				title: "updated",
			}),
		});
		assert.equal(update.status, 200);
		const transition = await json(origin, "/api/v1/browser/work/commands", {
			method: "POST",
			headers: operatorHeaders,
			body: JSON.stringify({
				kind: "ticket.transition",
				idempotency_key: "gol81:ticket:transition",
				opaque_id: ticket.opaque_id,
				expected_revision: update.body.result.ticket.revision,
				phase: "building",
			}),
		});
		assert.equal(transition.status, 200);
		const staleBefore = writer.committedPublicationStorage().projectRevision(projectA);
		const stale = await json(origin, "/api/v1/browser/work/commands", {
			method: "POST",
			headers: operatorHeaders,
			body: JSON.stringify({
				kind: "ticket.update",
				idempotency_key: "gol81:ticket:stale",
				opaque_id: ticket.opaque_id,
				expected_revision: ticket.revision,
				title: "stale",
			}),
		});
		assert.equal(stale.status, 409);
		assert.equal(writer.committedPublicationStorage().projectRevision(projectA), staleBefore);
		const mismatch = await json(origin, "/api/v1/browser/work/commands", {
			method: "POST",
			headers: operatorHeaders,
			body: JSON.stringify({ ...createBody, title: "changed fingerprint" }),
		});
		assert.equal(mismatch.status, 409);
		const missingCsrf = await json(origin, "/api/v1/browser/work/commands", {
			method: "POST",
			headers: headers(origin, control.alpha.session),
			body: JSON.stringify(createBody),
		});
		assert.equal(missingCsrf.status, 401);
		const beforeAuthorityForgery = writer
			.committedPublicationStorage()
			.projectRevision(projectA);
		const outboxBeforeAuthorityForgery = writer
			.committedPublicationStorage()
			.outboxCount(projectA);
		for (const [field, value] of [
			["role", "viewer"],
			["project_id", projectB],
			["scope", "foreign-scope"],
			["approval", "forged-approval"],
			["fence", "forged-fence"],
		]) {
			const authorityForgery = await json(origin, "/api/v1/browser/work/commands", {
				method: "POST",
				headers: operatorHeaders,
				body: JSON.stringify({
					...createBody,
					idempotency_key: `gol81:forged:${field}`,
					[field]: value,
				}),
			});
			assert.equal(authorityForgery.status, 403, `${field} forgery is rejected before mutation`);
		}
		const unknownField = await json(origin, "/api/v1/browser/work/commands", {
			method: "POST",
			headers: operatorHeaders,
			body: JSON.stringify({
				...createBody,
				idempotency_key: "gol81:unknown-field",
				unexpected: "not-a-browser-command-field",
			}),
		});
		assert.equal(unknownField.status, 400, "unknown command field is rejected before mutation");
		assert.equal(
			writer.committedPublicationStorage().projectRevision(projectA),
			beforeAuthorityForgery,
		);
		assert.equal(
			writer.committedPublicationStorage().outboxCount(projectA),
			outboxBeforeAuthorityForgery,
		);
		const viewer = await json(origin, "/api/v1/browser/work/commands", {
			method: "POST",
			headers: headers(origin, control.viewer.session, control.viewer.csrf),
			body: JSON.stringify({ ...createBody, idempotency_key: "gol81:viewer" }),
		});
		assert.equal(viewer.status, 403);
		const forged = await json(origin, "/api/v1/browser/work/commands", {
			method: "POST",
			headers: { ...operatorHeaders, "x-golem-actor": "forged" },
			body: JSON.stringify({ ...createBody, idempotency_key: "gol81:forged" }),
		});
		assert.equal(forged.status, 403);
		const foreignTicket = control.core.tickets.create({
			projectId: projectB,
			title: "beta command target",
			actor: "actor_browser_beta",
		});
		const beforeForeignCommand = writer
			.committedPublicationStorage()
			.projectRevision(projectA);
		const foreignCommand = await json(origin, "/api/v1/browser/work/commands", {
			method: "POST",
			headers: operatorHeaders,
			body: JSON.stringify({
				kind: "ticket.update",
				idempotency_key: "gol81:foreign-command",
				opaque_id: foreignTicket.id,
				expected_revision: foreignTicket.revision,
				title: "must not disclose foreign target",
			}),
		});
		assert.equal(foreignCommand.status, 404, "foreign command target is indistinguishable from absence");
		assert.equal(JSON.stringify(foreignCommand.body).includes(foreignTicket.id), false);
		assert.equal(
			writer.committedPublicationStorage().projectRevision(projectA),
			beforeForeignCommand,
		);
		const invalidRevision = await json(origin, "/api/v1/browser/work/commands", {
			method: "POST",
			headers: operatorHeaders,
			body: JSON.stringify({
				kind: "ticket.update",
				idempotency_key: "gol81:invalid-revision",
				opaque_id: ticket.opaque_id,
				expected_revision: 0,
				title: "invalid",
			}),
		});
		assert.equal(invalidRevision.status, 400);
		const unbound = await json(origin, "/api/v1/browser/work/commands", {
			method: "POST",
			headers: headers(origin, "unknown_session", "unknown_csrf"),
			body: JSON.stringify({ ...createBody, idempotency_key: "gol81:unbound" }),
		});
		assert.equal(unbound.status, 401);
		const beforeDispatch = writer.committedPublicationStorage().projectRevision(projectA);
		const dispatch = await json(origin, "/api/v1/browser/work/commands", {
			method: "POST",
			headers: operatorHeaders,
			body: JSON.stringify({ kind: "dispatch", idempotency_key: "gol81:dispatch" }),
		});
		assert.equal(dispatch.status, 409);
		assert.equal(dispatch.body.result.kind, "unsupported");
		assert.equal(writer.committedPublicationStorage().projectRevision(projectA), beforeDispatch);
		fixtureClock.advance(61_000);
		const expired = await json(origin, "/api/v1/browser/work/commands", {
			method: "POST",
			headers: operatorHeaders,
			body: JSON.stringify({ ...createBody, idempotency_key: "gol81:expired" }),
		});
		assert.equal(expired.status, 401);
		return "real cookie+CSRF browser commands invoke the durable gateway once, preserve CAS/idempotency classification, and leave dispatch unimplemented";
	} finally {
		if (control) await control.service.close();
		if (writer) await writer.close();
		home.cleanup();
	}
}
