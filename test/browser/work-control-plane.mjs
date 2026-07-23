import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import {
	assertContained,
	createTemporaryHome,
	redactDiagnostic,
	spawnGrouped,
	stopProcessGroup,
	waitFor,
} from "@golem/testkit";

import { acquireChrome } from "../../dashboard/scripts/_chrome.mjs";
import { createFetchApiClient } from "../../packages/api-client/dist/index.js";
import { createSessionService } from "../../packages/runtime/dist/index.js";
import { openControlPlanePersistence } from "../../apps/control-plane/dist/persistence.js";
import {
	composeControlPlaneTrackerCoreServices,
} from "../../apps/control-plane/dist/tracker.js";

const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const serviceProgram = path.join(
	repositoryRoot,
	"apps/control-plane/dist/main.js",
);
const mountRoot = path.join(
	repositoryRoot,
	"test/browser/work-control-plane",
);
const controlToken = "gol75_control_bearer_SECRET_000000000000";
const projectId = "prj_00000000-0000-4000-8000-000000000075";
const foreignProjectId = "prj_00000000-0000-4000-8000-000000000175";
const sessionId = "ses_00000000-0000-4000-8000-000000000075";
const generationId = "gen_00000000-0000-4000-8000-000000000075";
const operatorBindingId = "bnd_gol75_operator";
const viewerSession = "gol75_viewer_cookie_SECRET";
const viewerCsrf = "gol75_viewer_csrf_SECRET";
const expiredSession = "gol75_expired_cookie_SECRET";
const expiredCsrf = "gol75_expired_csrf_SECRET";
const foreignTitle = "GOL75_FOREIGN_SCOPE_SECRET";
const foreignBody = "GOL75_PRIVATE_PROMPT_SECRET";

function pathsFor(home) {
	return Object.freeze({
		runtimePath: path.join(home.golemHome, "runtime.db"),
		trackerPath: path.join(home.golemHome, "tracker.db"),
		lockPath: path.join(home.golemHome, "runtime.db.owner.lock"),
	});
}

function runtimeSignal(observedAt) {
	return {
		schema_version: "golem.runtime-signal/v1",
		event_id: "evt_00000000-0000-4000-8000-000000000075",
		event_kind: "session.started",
		producer: "gol75-browser-runner",
		producer_instance_id:
			"prod_00000000-0000-4000-8000-000000000075",
		producer_sequence: 1,
		harness: "codex",
		correlation_id: "cor_00000000-0000-4000-8000-000000000075",
		deduplication_key: "gol75-session-started",
		clocks: {
			source_observed_at: observedAt,
			received_at: observedAt,
			materialized_at: observedAt,
		},
		provenance: {
			source: "journey",
			confidence: "verified",
			evidence_id: "gol75",
		},
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

async function seed(home) {
	const now = new Date().toISOString();
	const owner = openControlPlanePersistence(pathsFor(home), {
		ownerId: "gol75-browser-seed",
	});
	try {
		owner.runtimeProjectStorage().observe({
			projectId,
			name: "GOL-75 browser project",
			location: {
				locationId: "loc_00000000-0000-4000-8000-000000000075",
				canonicalPath: path.join(home.root, "project"),
				relation: "main",
				source: "register",
				evidence: { journey: true },
				observedAt: now,
			},
			source: "register",
			eventId: "evt_00000000-0000-4000-8000-000000000175",
			deduplicationKey: "gol75-project",
			payload: { kind: "project.observed" },
			provenance: { source: "journey", confidence: "verified" },
			occurredAt: now,
		});
		const sessions = createSessionService({
			projects: owner.runtimeProjectStorage(),
			sessions: owner.runtimeSessionStorage(),
		});
		assert.equal(
			sessions.apply(runtimeSignal(now)).disposition,
			"accepted",
			"fixture materializes one canonical runtime session",
		);
		const endpoints = owner.runtimeEndpointStorage();
		const claim = endpoints.claim({
			generationId,
			routeKind: "delivery",
			ownerInstanceId: "gol75-browser-owner",
			deliveryMode: "native_channel",
			readiness: "ready",
			controlState: "enabled",
			leaseMs: 10 * 60_000,
		});
		assert(claim.endpointId && claim.ownerFence);
		const endpoint = {
			endpointId: claim.endpointId,
			generationId,
			ownerInstanceId: "gol75-browser-owner",
			ownerFence: claim.ownerFence,
		};
		assert.equal(
			endpoints.reportHealth({ ...endpoint, state: "healthy" }).disposition,
			"accepted",
		);
		assert.equal(
			endpoints.probe({ ...endpoint, consumerReady: true }).disposition,
			"accepted",
		);
		assert.equal(
			endpoints.reportReadiness({
				...endpoint,
				deliveryMode: "native_channel",
				readiness: "ready",
			}).disposition,
			"accepted",
		);
		assert.equal(
			endpoints.reportDelivery({
				...endpoint,
				status: "delivered",
				readiness: "ready",
			}).disposition,
			"accepted",
		);
		assert.equal(
			endpoints.reportCapability({
				...endpoint,
				capability: {
					capability: "delivery",
					adapterId: "gol75-browser-runner",
					adapterVersion: "1.0.0",
					qualification: "supported",
					deliveryMode: "native_channel",
					readiness: "ready",
					evidenceKind: "observed",
					observedAt: now,
				},
				evidence: { consumed: true },
			}).disposition,
			"accepted",
		);

		const clock = {
			now: () => new Date().toISOString(),
			after: (milliseconds) =>
				new Date(Date.now() + milliseconds).toISOString(),
		};
		const core = composeControlPlaneTrackerCoreServices({ writer: owner, clock });
		const ticket = core.tickets.create({
			projectId,
			kind: "work-item",
			title: "GOL-75 canonical browser dispatch",
			assignee: sessionId,
			actor: "act_gol75_operator",
		});
		const spec = core.tickets.create({
			projectId,
			kind: "spec",
			title: "GOL-55 canonical browser spec",
			actor: "act_gol75_operator",
		});
		const question = core.tickets.create({
			projectId,
			kind: "question",
			title: "GOL-55 bounded browser question",
			parentId: spec.id,
			actor: "act_gol75_operator",
		});
		const foreignTicket = core.tickets.create({
			projectId: foreignProjectId,
			kind: "work-item",
			title: foreignTitle,
			body: foreignBody,
			assignee: sessionId,
			actor: "act_gol75_foreign",
		});

		const principals = owner.browserPrincipalStorage();
		principals.provision({
			id: operatorBindingId,
			actorId: "act_gol75_operator",
			role: "operator",
			defaultProjectId: projectId,
			scopeProjectIds: [projectId],
		});
		principals.provision({
			id: "bnd_gol75_viewer",
			actorId: "act_gol75_viewer",
			role: "viewer",
			defaultProjectId: projectId,
			scopeProjectIds: [projectId],
		});
		principals.provision({
			id: "bnd_gol75_expired",
			actorId: "act_gol75_expired",
			role: "operator",
			defaultProjectId: projectId,
			scopeProjectIds: [projectId],
		});
		principals.bindCredential({
			bindingId: operatorBindingId,
			adapter: "bearer",
			credential: controlToken,
		});
		const viewerExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
		assert.equal(
			principals.createBrowserSession({
				bindingId: "bnd_gol75_viewer",
				session: viewerSession,
				csrf: viewerCsrf,
				expiresAt: viewerExpiresAt,
				now,
			}),
			true,
		);
		const expiredAtMs = Date.now() + 750;
		assert.equal(
			principals.createBrowserSession({
				bindingId: "bnd_gol75_expired",
				session: expiredSession,
				csrf: expiredCsrf,
				expiresAt: new Date(expiredAtMs).toISOString(),
				now,
			}),
			true,
		);
		return Object.freeze({
			ticket,
			spec,
			question,
			foreignTicket,
			endpointId: claim.endpointId,
			expiredAtMs,
		});
	} finally {
		await owner.close();
	}
}

async function bundleMount(home) {
	const staticRoot = path.join(home.root, "work-control-plane-static");
	fs.mkdirSync(staticRoot, { recursive: true });
	fs.copyFileSync(
		path.join(mountRoot, "index.html"),
		path.join(staticRoot, "index.html"),
	);
	await build({
		absWorkingDir: repositoryRoot,
		entryPoints: [path.join(mountRoot, "client-entry.js")],
		outfile: path.join(staticRoot, "app.js"),
		bundle: true,
		format: "esm",
		platform: "browser",
		target: ["chrome120"],
		sourcemap: false,
		legalComments: "none",
		logLevel: "silent",
	});
	return staticRoot;
}

function exited(group) {
	return group.child.exitCode !== null || group.child.signalCode !== null;
}

function parseReady(output) {
	for (const line of output.split("\n")) {
		try {
			const message = JSON.parse(line);
			if (message.type === "ready" && typeof message.origin === "string")
				return message;
		} catch {
			// Bounded process diagnostics are reported only on failure.
		}
	}
	return undefined;
}

function processFailure(label, group) {
	return new Error(
		`${label}; command=${group.command}; stdout=${group.stdout()}; stderr=${group.stderr()}`,
	);
}

async function startService(home, staticRoot, port) {
	const group = spawnGrouped(process.execPath, [serviceProgram], {
		cwd: repositoryRoot,
		env: {
			...home.env,
			GOLEM_CONTROL_PLANE_TOKEN: controlToken,
			GOLEM_CONTROL_PLANE_PORT: String(port ?? 0),
			GOLEM_CONTROL_PLANE_REPLAY_WINDOW: "2",
			GOLEM_CONTROL_PLANE_STATIC_ROOT: staticRoot,
			GOLEM_BROWSER_LOCAL_OPERATOR_BINDING_ID: operatorBindingId,
		},
	});
	try {
		const ready = await waitFor(() => {
			const message = parseReady(group.stdout());
			if (message) return message;
			if (exited(group))
				return {
					failure: processFailure(
						"work control plane exited before readiness",
						group,
					),
				};
			return undefined;
		}, "work control plane readiness");
		if ("failure" in ready) throw ready.failure;
		return { group, origin: ready.origin, instanceId: ready.instance_id };
	} catch (error) {
		await stopProcessGroup(group);
		throw error;
	}
}

function portOf(origin) {
	const port = Number(new URL(origin).port);
	assert(Number.isInteger(port) && port > 0);
	return port;
}

function isPortListening(port) {
	return new Promise((resolve) => {
		const socket = net.createConnection({ host: "127.0.0.1", port });
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(value);
		};
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
		setTimeout(() => finish(false), 150);
	});
}

function cookie(session, origin) {
	return {
		name: "golem_control_plane_session",
		value: session,
		url: origin,
		httpOnly: true,
		secure: false,
		sameSite: "Strict",
	};
}

function collectFiles(root) {
	if (!fs.existsSync(root)) return [];
	const files = [];
	const visit = (directory) => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const candidate = path.join(directory, entry.name);
			if (entry.isDirectory()) visit(candidate);
			else files.push(candidate);
		}
	};
	visit(root);
	return files.sort();
}

function scanArtifacts(root, sensitiveValues) {
	for (const file of collectFiles(root)) {
		assertContained(root, file);
		const value = fs.readFileSync(file).toString("latin1");
		for (const sensitive of sensitiveValues)
			if (sensitive)
				assert.equal(
					value.includes(sensitive),
					false,
					`${path.basename(file)} excludes seeded sensitive material`,
				);
	}
}

function recordStep(steps, input) {
	const methods = new Set(["GET", "POST", "PATCH", "WS", "PROCESS"]);
	const outcomes = new Set([
		"ok",
		"queued",
		"pending",
		"settled",
		"forbidden",
		"not_found",
		"expired",
		"resynced",
		"replayed",
	]);
	assert(methods.has(input.method));
	assert(outcomes.has(input.outcome));
	steps.push(
		Object.freeze({
			action: String(input.action).slice(0, 64),
			method: input.method,
			route: String(input.route).slice(0, 96),
			status: Number(input.status),
			revision: String(input.revision ?? "unchanged").slice(0, 32),
			outcome: input.outcome,
		}),
	);
}

async function retainFailureArtifacts({
	artifactRoot,
	page,
	steps,
	error,
	temporaryRoot,
	sensitiveValues,
	childLogs,
}) {
	fs.mkdirSync(artifactRoot, { recursive: true });
	const diagnostic = redactDiagnostic(
		`${error instanceof Error ? error.stack ?? error.message : String(error)}\n${childLogs}`,
		temporaryRoot,
		sensitiveValues,
	);
	const records = [
		{
			schema_version: "golem.browser-control-failure/v1",
			kind: "diagnostic",
			diagnostic,
		},
		...steps.map((step) => ({
			schema_version: "golem.browser-control-failure/v1",
			kind: "step",
			...step,
		})),
	];
	fs.writeFileSync(
		path.join(artifactRoot, "failure.jsonl"),
		`${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
		{ mode: 0o600 },
	);
	if (page) {
		await page.evaluate(() => {
			document.documentElement.innerHTML =
				'<head><meta charset="utf-8"><title>Sanitized failure</title></head><body style="background:#111827;color:#f8fafc;font-family:system-ui;padding:2rem"><main><h1>Browser-control journey failed</h1><p>See the allowlisted diagnostic record.</p></main></body>';
		});
		await page.screenshot({
			path: path.join(artifactRoot, "failure.png"),
			fullPage: true,
		});
	}
	assert.equal(
		collectFiles(artifactRoot).some((file) => file.endsWith(".zip")),
		false,
		"failure policy retains no raw trace archive",
	);
	scanArtifacts(artifactRoot, sensitiveValues);
}

function assertSafeSurface(value, sensitiveValues, label) {
	const serialized = JSON.stringify(value);
	for (const sensitive of sensitiveValues)
		if (sensitive)
			assert.equal(
				serialized.includes(sensitive),
				false,
				`${label} excludes ${sensitive}`,
			);
	for (const key of [
		"recipient_id",
		"session_id",
		"generation_id",
		"endpoint",
		"fence",
		"claim_owner",
		"claim_token",
		"acknowledgement_id",
		"envelope_id",
		"payload",
	]) {
		assert.equal(
			serialized.includes(`"${key}"`),
			false,
			`${label} excludes ${key}`,
		);
	}
}

async function bearerCreate(api, index) {
	const response = await api.request({
		method: "POST",
		path: "/api/v1/tracker/tickets",
		body: {
			kind: "work-item",
			title: `GOL-75 external change ${index}`,
			idempotency_key: `gol75:external:${index}`,
		},
	});
	assert.equal(response.status, 201);
	assert.equal(response.body.status, "completed");
	return response.body.result;
}

async function runWorkControlPlane() {
	const home = createTemporaryHome("golem-gol75-browser-control-");
	const artifactRoot = path.join(
		os.tmpdir(),
		`golem-work-control-artifacts-${process.pid}-${Date.now()}`,
	);
	const steps = [];
	const contexts = [];
	let staticRoot;
	let seedData;
	let service;
	let chrome;
	let page;
	let servicePort;
	let operatorCsrf;
	let success = false;
	let evidence;
	let failure;
	const sensitiveValues = new Set([
		controlToken,
		viewerSession,
		viewerCsrf,
		expiredSession,
		expiredCsrf,
		foreignProjectId,
		foreignTitle,
		foreignBody,
		sessionId,
		generationId,
		home.root,
	]);
	try {
		seedData = await seed(home);
		sensitiveValues.add(seedData.foreignTicket.id);
		sensitiveValues.add(seedData.endpointId);
		staticRoot = await bundleMount(home);
		const bundle = fs.readFileSync(path.join(staticRoot, "app.js"), "utf8");
		for (const sensitive of sensitiveValues)
			assert.equal(
				bundle.includes(sensitive),
				false,
				"test mount bundle contains no seeded credential or scoped value",
			);

		service = await startService(home, staticRoot);
		servicePort = portOf(service.origin);
		recordStep(steps, {
			action: "start compiled control plane",
			method: "PROCESS",
			route: "apps/control-plane/dist/main.js",
			status: 0,
			revision: "new_instance",
			outcome: "ok",
		});
		chrome = await acquireChrome();
		const context = await chrome.browser.newContext();
		contexts.push(context);
		page = await context.newPage();
		page.setDefaultTimeout(8_000);
		const browserRequests = [];
		const headerReads = [];
		const browserErrors = [];
		page.on("request", (request) => {
			browserRequests.push({
				method: request.method(),
				url: request.url(),
			});
			headerReads.push(
				request.allHeaders().then((headers) => {
					const csrf = headers["x-golem-csrf"];
					if (csrf) {
						operatorCsrf = csrf;
						sensitiveValues.add(csrf);
					}
					return headers;
				}),
			);
		});
		page.on("pageerror", (error) => browserErrors.push(error.name));
		page.on("console", (message) => {
			if (
				message.type() === "error" &&
				!/Failed to load resource/iu.test(message.text()) &&
				!/WebSocket connection to .* failed/iu.test(message.text())
			)
				browserErrors.push("console_error");
		});

		await page.goto(service.origin, { waitUntil: "domcontentloaded" });
		await page
			.locator("#work-status[data-ready='true']")
			.waitFor({ state: "visible" });
		await page
			.locator("#board-connection[data-connection='connected']")
			.waitFor();
		await page
			.locator("#operations-connection[data-connection='connected']")
			.waitFor();
		await page
			.locator(`[data-ticket-id="${seedData.ticket.id}"]`)
			.waitFor();
		assert.equal(
			await page.getByRole("heading", { name: "Work control plane" }).count(),
			1,
		"real page mounts the public browser client",
		);
		const shipped = await (await fetch(`${service.origin}/app.js`)).text();
		assert.equal(shipped.includes(controlToken), false);
		recordStep(steps, {
			action: "bootstrap and render board",
			method: "GET",
			route: "/api/v1/projections/tracker.board",
			status: 200,
			revision: "canonical",
			outcome: "ok",
		});

		const detail = await page.evaluate(
			(id) => globalThis.workControl.detail(id),
			seedData.ticket.id,
		);
		assert.equal(detail.item.opaque_id, seedData.ticket.id);
		await page.locator("#detail-item").waitFor();
		assert.match(
			await page.locator("#detail-item").innerText(),
			new RegExp(`^${seedData.ticket.id}\\b`, "u"),
		);
		recordStep(steps, {
			action: "render typed detail",
			method: "GET",
			route: "/api/v1/browser/work/items/:opaque_id",
			status: 200,
			revision: String(detail.item.revision),
			outcome: "ok",
		});

		const created = await page.evaluate(() =>
			globalThis.workControl.command({
				kind: "ticket.create",
				ticket_kind: "work-item",
				title: "GOL-75 browser-created ticket",
				priority: "P1",
				idempotency_key: "gol75:browser:create",
			}),
		);
		assert.equal(created.result.kind, "ticket");
		const createdTicket = created.result.ticket;
		await page
			.locator(`[data-ticket-id="${createdTicket.opaque_id}"]`)
			.waitFor();
		const updated = await page.evaluate(
			(input) => globalThis.workControl.command(input),
			{
				kind: "ticket.update",
				opaque_id: createdTicket.opaque_id,
				expected_revision: createdTicket.revision,
				priority: "P0",
				idempotency_key: "gol75:browser:update",
			},
		);
		assert.equal(updated.result.ticket.priority, "P0");
		recordStep(steps, {
			action: "browser create and update",
			method: "POST",
			route: "/api/v1/browser/work/commands",
			status: 200,
			revision: String(updated.result.ticket.revision),
			outcome: "ok",
		});

		const dispatchInput = {
			kind: "dispatch",
			opaque_id: seedData.ticket.id,
			expected_revision: seedData.ticket.revision,
			idempotency_key: "gol75:browser:dispatch",
		};
		const dispatched = await page.evaluate(
			(input) => globalThis.workControl.command(input),
			dispatchInput,
		);
		assert.equal(dispatched.result.disposition, "queued");
		const replay = await page.evaluate(
			(input) => globalThis.workControl.command(input),
			dispatchInput,
		);
		assert.deepEqual(replay, dispatched, "one browser command key replays exactly");
		await page
			.locator(
				`[data-operation-id="${dispatched.command_id}"][data-settlement="pending"]`,
			)
			.waitFor();
		const pendingState = await page.evaluate(() =>
			globalThis.workControl.state(),
		);
		assert.equal(
			pendingState.projections["communication.operations"].items.filter(
				(item) => item.opaque_id === dispatched.command_id,
			).length,
			1,
			"idempotent replay remains one projected operation",
		);
		recordStep(steps, {
			action: "canonical browser dispatch",
			method: "POST",
			route: "/api/v1/browser/work/commands",
			status: 200,
			revision: String(dispatched.resource_revision),
			outcome: "pending",
		});

		const commandRequestsBeforeForgery = browserRequests.filter(
			(request) =>
				request.method === "POST" &&
				new URL(request.url).pathname === "/api/v1/browser/work/commands",
		).length;
		const typedForgery = await page.evaluate(async (input) => {
			try {
				await globalThis.workControl.command(input);
				return { accepted: true };
			} catch (error) {
				return { accepted: false, name: error?.name ?? "Error" };
			}
		}, {
			...dispatchInput,
			idempotency_key: "gol75:forged:typed",
			session_id: sessionId,
			fence: "forged",
		});
		assert.equal(typedForgery.accepted, false);
		assert.equal(
			browserRequests.filter(
				(request) =>
					request.method === "POST" &&
					new URL(request.url).pathname ===
						"/api/v1/browser/work/commands",
			).length,
			commandRequestsBeforeForgery,
			"strict public client rejects forged targeting before network",
		);

		const operatorCookies = await context.cookies(service.origin);
		const operatorCookie = operatorCookies.find(
			(value) => value.name === "golem_control_plane_session",
		);
		assert(operatorCookie?.httpOnly);
		sensitiveValues.add(operatorCookie.value);
		await Promise.all(headerReads);
		assert(operatorCsrf, "page mutation exposes a private CSRF request header only");

		const viewer = await chrome.browser.newContext();
		contexts.push(viewer);
		await viewer.addCookies([cookie(viewerSession, service.origin)]);
		const viewerRead = await viewer.request.get(
			`${service.origin}/api/v1/projections/tracker.board`,
			{ headers: { origin: service.origin } },
		);
		assert.equal(viewerRead.status(), 200);
		const viewerWrite = await viewer.request.post(
			`${service.origin}/api/v1/browser/work/commands`,
			{
				headers: {
					origin: service.origin,
					"x-golem-csrf": viewerCsrf,
				},
				data: {
					kind: "ticket.create",
					title: "viewer must not create",
					idempotency_key: "gol75:viewer:forbidden",
				},
			},
		);
		assert.equal(viewerWrite.status(), 403);
		recordStep(steps, {
			action: "viewer mutation denied",
			method: "POST",
			route: "/api/v1/browser/work/commands",
			status: 403,
			outcome: "forbidden",
		});

		await waitFor(
			() => (Date.now() > seedData.expiredAtMs ? true : undefined),
			"expired browser session clock",
		);
		const expired = await chrome.browser.newContext();
		contexts.push(expired);
		await expired.addCookies([cookie(expiredSession, service.origin)]);
		const expiredRead = await expired.request.get(
			`${service.origin}/api/v1/projections/tracker.board`,
			{ headers: { origin: service.origin } },
		);
		assert.equal(expiredRead.status(), 401);
		recordStep(steps, {
			action: "expired browser read denied",
			method: "GET",
			route: "/api/v1/projections/tracker.board",
			status: 401,
			outcome: "expired",
		});

		const foreignRead = await context.request.get(
			`${service.origin}/api/v1/browser/work/items/${seedData.foreignTicket.id}`,
			{ headers: { origin: service.origin } },
		);
		assert.equal(foreignRead.status(), 404);
		const forgedHeader = await context.request.post(
			`${service.origin}/api/v1/browser/work/commands`,
			{
				headers: {
					origin: service.origin,
					"x-golem-csrf": operatorCsrf,
					"x-golem-role": "operator",
					"x-golem-project": foreignProjectId,
					"x-golem-fence": "forged",
				},
				data: {
					kind: "ticket.create",
					title: "forged header must not create",
					idempotency_key: "gol75:forged:headers",
				},
			},
		);
		assert.equal(forgedHeader.status(), 403);
		const forgedBody = await context.request.post(
			`${service.origin}/api/v1/browser/work/commands`,
			{
				headers: {
					origin: service.origin,
					"x-golem-csrf": operatorCsrf,
				},
				data: {
					kind: "dispatch",
					opaque_id: seedData.ticket.id,
					expected_revision: seedData.ticket.revision,
					idempotency_key: "gol75:forged:body",
					session_id: sessionId,
					fence: "forged",
				},
			},
		);
		assert.equal(forgedBody.status(), 403);
		recordStep(steps, {
			action: "scope and authority forgery denied",
			method: "POST",
			route: "/api/v1/browser/work/commands",
			status: 403,
			outcome: "forbidden",
		});

		const bearer = createFetchApiClient(service.origin, {
			bearerToken: controlToken,
			caller: { projectId, sessionId },
		});
		const claims = await bearer.request({
			method: "POST",
			path: "/api/v1/delivery/claims",
			body: { limit: 20 },
		});
		assert.equal(claims.status, 200);
		const dispatchClaim = claims.body.items.find(
			(item) => item.payload.ticket_id === seedData.ticket.id,
		);
		assert(dispatchClaim);
		const prepared = await bearer.request({
			method: "POST",
			path: `/api/v1/delivery/claims/${encodeURIComponent(dispatchClaim.claimToken)}/prepare`,
			body: {},
		});
		assert.equal(prepared.status, 200);
		const acknowledged = await bearer.request({
			method: "POST",
			path: `/api/v1/delivery/claims/${encodeURIComponent(dispatchClaim.claimToken)}/ack`,
			body: {
				acknowledgement_id: "ack_gol75_browser",
				payload: {},
			},
		});
		assert.equal(acknowledged.status, 200);
		await page
			.locator(
				`[data-operation-id="${dispatched.command_id}"][data-settlement="settled"]`,
			)
			.waitFor();
		recordStep(steps, {
			action: "canonical delivery acknowledgement",
			method: "POST",
			route: "/api/v1/delivery/claims/:claim/ack",
			status: 200,
			revision: "advanced_once",
			outcome: "settled",
		});

		const ticketRead = await bearer.request({
			method: "GET",
			path: `/api/v1/tracker/tickets/${seedData.ticket.id}`,
		});
		assert.equal(ticketRead.status, 200);
		const revisionBeforeBearerUpdate = ticketRead.body.revision;
		const bearerUpdate = await bearer.request({
			method: "PATCH",
			path: `/api/v1/tracker/tickets/${seedData.ticket.id}`,
			body: {
				expected_revision: revisionBeforeBearerUpdate,
				idempotency_key: "gol75:bearer:update",
				title: "GOL-75 external bearer update",
			},
		});
		assert.equal(bearerUpdate.status, 200);
		const bearerUpdatedTicket = bearerUpdate.body.result;
		assert.equal(
			bearerUpdatedTicket.revision,
			revisionBeforeBearerUpdate + 1,
			"external bearer CAS advances the canonical ticket once",
		);
		let boardDiagnostic;
		try {
			await waitFor(async () => {
				boardDiagnostic = await page.evaluate((id) => {
					const state = globalThis.workControl.state();
					const synchronizer = state.synchronizers["tracker.tree"];
					return {
						revision: Number(
							document.querySelector(`[data-ticket-id="${id}"]`)?.dataset
								.revision ?? 0,
						),
						connection: state.connections["tracker.tree"],
						sequence: synchronizer?.sequence ?? 0,
						resource_revision: synchronizer?.resource_revision ?? 0,
						invalidation_tags: synchronizer?.invalidation_tags ?? [],
						events: state.events
							.filter((event) => event.stream === "tracker.tree")
							.slice(-8)
							.map((event) => ({
								kind: event.kind,
								source: event.source,
								tag: event.tag,
								status: event.status,
								revision: event.revision,
							})),
					};
				}, seedData.ticket.id);
				return boardDiagnostic.revision === bearerUpdatedTicket.revision
					? true
					: undefined;
			}, "external bearer tracker invalidation refetch");
		} catch (error) {
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}; board=${JSON.stringify(boardDiagnostic)}`,
			);
		}
		recordStep(steps, {
			action: "external bearer change refetched",
			method: "PATCH",
			route: "/api/v1/tracker/tickets/:id",
			status: 200,
			revision: "advanced",
			outcome: "ok",
		});

		await page.evaluate(() =>
			globalThis.workControl.pause("tracker.tree"),
		);
		const gapTickets = [];
		for (let index = 1; index <= 4; index += 1)
			gapTickets.push(await bearerCreate(bearer, index));
		await new Promise((resolve) => setTimeout(resolve, 250));
		await page.evaluate(() =>
			globalThis.workControl.resume("tracker.tree"),
		);
		await page.waitForFunction(
			() =>
				globalThis.workControl
					.state()
					.events.some(
							(event) =>
								event.kind === "invalidation" &&
								event.stream === "tracker.tree" &&
								(event.tag === "cursor_compacted" ||
									event.tag === "cursor_gap"),
					),
		);
		const lastGapTicket = gapTickets.at(-1);
		await page.waitForFunction(
			(id) =>
				globalThis.workControl
					.state()
					.projections["tracker.board"].items.some(
						(item) => item.opaque_id === id,
					),
			lastGapTicket.id,
		);
		await waitFor(
			() =>
				page.evaluate(() => {
					const state = globalThis.workControl.state();
					return state.connections["tracker.tree"] === "connected" &&
						state.synchronizers["tracker.tree"].instance_id
						? true
						: undefined;
				}),
			"fresh tracker snapshot after compacted cursor",
		);
		recordStep(steps, {
			action: "bounded replay gap refetched",
			method: "WS",
			route: "/api/v1/ws?stream=tracker.tree",
			status: 101,
			revision: "authoritative",
			outcome: "resynced",
		});

		const beforeRestart = await page.evaluate(() =>
			globalThis.workControl.state(),
		);
		const oldInstance =
			beforeRestart.synchronizers["tracker.tree"].instance_id;
		assert(oldInstance, "pre-restart tracker stream owns a current instance");
		await stopProcessGroup(service.group);
		service = undefined;
		await waitFor(
			async () => (!(await isPortListening(servicePort)) ? true : undefined),
			"old control-plane listener shutdown",
		);
		service = await startService(home, staticRoot, servicePort);
		assert.notEqual(service.instanceId, oldInstance);
		let restartDiagnostic;
		try {
			await waitFor(async () => {
				restartDiagnostic = await page.evaluate(() => {
					const state = globalThis.workControl.state();
					return {
						connection: state.connections["tracker.tree"],
						synchronizer: state.synchronizers["tracker.tree"],
						events: state.events
							.filter((event) => event.stream === "tracker.tree")
							.slice(-12)
							.map((event) => ({
								kind: event.kind,
								source: event.source,
								tag: event.tag,
								status: event.status,
								revision: event.revision,
							})),
					};
				});
				return restartDiagnostic.connection === "connected" &&
					restartDiagnostic.synchronizer.instance_id !== oldInstance &&
					restartDiagnostic.events.some(
						(event) =>
							event.kind === "invalidation" &&
							event.tag === "instance_changed",
					)
					? true
					: undefined;
			}, "browser instance-change resync", 12_000);
		} catch (error) {
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}; restart=${JSON.stringify(restartDiagnostic)}`,
			);
		}
		await page
			.locator(
				`[data-operation-id="${dispatched.command_id}"][data-settlement="settled"]`,
			)
			.waitFor();
		recordStep(steps, {
			action: "service restart replaced epoch",
			method: "WS",
			route: "/api/v1/ws",
			status: 101,
			revision: "new_instance",
			outcome: "resynced",
		});

		const state = await page.evaluate(() => globalThis.workControl.state());
		const projectionResponse = await context.request.get(
			`${service.origin}/api/v1/projections/communication.operations`,
			{ headers: { origin: service.origin } },
		);
		assert.equal(projectionResponse.status(), 200);
		const projectionBody = await projectionResponse.json();
		const safeValues = [...sensitiveValues].filter(
			(value) => value !== operatorCsrf && value !== operatorCookie.value,
		);
		assertSafeSurface(state, safeValues, "DOM client state");
		assertSafeSurface(
			projectionBody,
			safeValues,
			"authoritative communication HTTP",
		);
		const pageText = await page.locator("body").innerText();
		for (const sensitive of safeValues)
			assert.equal(
				pageText.includes(sensitive),
				false,
				"DOM excludes seeded private and foreign values",
			);
		const requestHeaders = await Promise.all(headerReads);
		assert.equal(
			requestHeaders.some((headers) => "authorization" in headers),
			false,
			"browser page never receives or sends a bearer",
		);
		assert.equal(
			browserRequests.every(
				(request) => new URL(request.url).origin === service.origin,
			),
			true,
			"browser page stays same-origin",
		);
		assert.deepEqual(browserErrors, [], "browser page emits no console/page error");

		await page.evaluate((values) => {
			const hostile = document.createElement("p");
			hostile.textContent = values.join(" ");
			document.body.append(hostile);
		}, [...sensitiveValues]);
		await retainFailureArtifacts({
			artifactRoot,
			page,
			steps,
			error: new Error(
				`artifact drill ${[...sensitiveValues].join(" ")}`,
			),
			temporaryRoot: home.root,
			sensitiveValues: [...sensitiveValues],
			childLogs: `${service.group.stdout()}\n${service.group.stderr()}`,
		});
		const artifactNames = collectFiles(artifactRoot).map((file) =>
			path.basename(file),
		);
		assert.deepEqual(
			artifactNames,
			["failure.jsonl", "failure.png"],
			"failure policy retains only allowlisted JSONL and sanitized screenshot",
		);
		assert.match(
			fs.readFileSync(path.join(artifactRoot, "failure.jsonl"), "utf8"),
			/\$REDACTED|\$TEMP_ROOT/u,
		);
		fs.rmSync(artifactRoot, { recursive: true, force: true });
		assert.equal(
			fs.existsSync(artifactRoot),
			false,
			"successful journey retains no browser artifact",
		);
		success = true;
		evidence =
			"compiled control-plane child plus public GOL-74 client in ephemeral headless Chrome prove same-origin cookie/CSRF authority, browser create/update/canonical dispatch, safe pending-to-settled HTTP refetch, viewer/expired/foreign/forged denial, bounded-gap and instance restart resync, and allowlist-only failure artifacts";
	} catch (error) {
		try {
			await retainFailureArtifacts({
				artifactRoot,
				page,
				steps,
				error,
				temporaryRoot: home.root,
				sensitiveValues: [...sensitiveValues],
				childLogs: service
					? `${service.group.stdout()}\n${service.group.stderr()}`
					: "",
			});
		} catch {
			// Preserve the original failure if artifact capture itself is unavailable.
		}
		failure = new Error(
			`${redactDiagnostic(
				error instanceof Error ? error.stack ?? error.message : String(error),
				home.root,
				[...sensitiveValues],
			)}; sanitized_artifacts=${artifactRoot}`,
		);
	} finally {
		for (const context of contexts.reverse()) {
			try {
				await context.close();
			} catch {
				// Cleanup continues through every owned resource.
			}
		}
		if (chrome) {
			const profile = path.join(
				os.tmpdir(),
				`golem-chrome-headless-${chrome.port}-${process.pid}`,
			);
			await chrome.cleanup();
			await waitFor(
				async () => (!(await isPortListening(chrome.port)) ? true : undefined),
				"headless Chrome shutdown",
			).catch(() => undefined);
			try {
				fs.rmSync(profile, {
					recursive: true,
					force: true,
					maxRetries: 10,
					retryDelay: 100,
				});
			} catch (error) {
				if (!failure)
					failure = new Error(
						`headless Chrome profile cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
					);
			}
		}
		if (service) await stopProcessGroup(service.group);
		if (servicePort)
			await waitFor(
				async () =>
					!(await isPortListening(servicePort)) ? true : undefined,
				"control-plane shutdown",
			).catch(() => undefined);
		home.cleanup();
	}
	if (failure) throw failure;
	assert.equal(success, true);
	assert.equal(fs.existsSync(home.root), false, "temporary home is removed");
	assert.equal(
		fs.existsSync(artifactRoot),
		false,
		"success leaves no retained artifact directory",
	);
	return evidence;
}

async function runWorkManagementDashboard() {
	const home = createTemporaryHome("golem-gol55-work-management-");
	const artifactRoot = path.join(
		os.tmpdir(),
		`golem-work-management-artifacts-${process.pid}-${Date.now()}`,
	);
	const staticRoot = path.join(
		repositoryRoot,
		"dashboard/dist/control-plane",
	);
	const contexts = [];
	const steps = [];
	let service;
	let servicePort;
	let chrome;
	let page;
	let failure;
	let success = false;
	const sensitiveValues = new Set([
		controlToken,
		viewerSession,
		viewerCsrf,
		expiredSession,
		expiredCsrf,
		foreignProjectId,
		foreignTitle,
		foreignBody,
		sessionId,
		generationId,
		home.root,
	]);
	try {
		assert.equal(
			fs.existsSync(path.join(staticRoot, "index.html")),
			true,
			"typed dashboard build exists before the browser journey",
		);
		const seedData = await seed(home);
		sensitiveValues.add(seedData.foreignTicket.id);
		sensitiveValues.add(seedData.endpointId);
		service = await startService(home, staticRoot);
		servicePort = portOf(service.origin);
		const bearer = createFetchApiClient(service.origin, {
			bearerToken: controlToken,
			caller: { projectId, sessionId },
		});
		const seededRole = await bearer.request({
			method: "POST",
			path: "/api/v1/management/roles",
			body: {
				name: "Browser project operator",
				definition: { purpose: "GOL-55 browser journey" },
			},
		});
		assert.equal(seededRole.status, 201);
		const seededAsset = await bearer.request({
			method: "POST",
			path: "/api/v1/management/assets",
			body: {
				ticket_id: seedData.ticket.id,
				relative_path: "gol55-preview.png",
				mime_type: "image/png",
				content_base64: Buffer.from([137, 80, 78, 71]).toString("base64"),
			},
		});
		assert.equal(seededAsset.status, 201);

		chrome = await acquireChrome();
		const context = await chrome.browser.newContext();
		contexts.push(context);
		page = await context.newPage();
		page.setDefaultTimeout(10_000);
		const browserErrors = [];
		const browserRequests = [];
		page.on("request", (request) => browserRequests.push(request.url()));
		page.on("pageerror", (error) => browserErrors.push(error.name));
		page.on("console", (message) => {
			if (
				message.type() === "error" &&
				!/Failed to load resource/iu.test(message.text()) &&
				!/WebSocket connection to .* failed/iu.test(message.text())
			)
				browserErrors.push("console_error");
		});

		await page.goto(`${service.origin}/tracker`, {
			waitUntil: "domcontentloaded",
		});
		await page.getByTestId("tracker-dispatch-ui").waitFor();
		await page
			.locator("[data-testid='work-connection'][data-state='connected']")
			.waitFor();
		await page
			.locator(`[data-ticket-id="${seedData.ticket.id}"]`)
			.waitFor();

		const composer = page
			.locator("details")
			.filter({ hasText: "Create a typed ticket" });
		await composer.locator("summary").click();
		await composer.getByLabel("Ticket title").fill(
			"GOL-55 browser-created work item",
		);
		await composer.getByLabel("Labels").fill("browser, parity");
		await composer.getByLabel("Wave").fill("11");
		await composer
			.getByLabel("Body")
			.fill("Browser-created context and acceptance evidence.");
		await composer.getByRole("button", { name: "Create ticket" }).click();
		await page.waitForURL(/\/tickets\/[A-Za-z][A-Za-z0-9_-]*$/u);
		const createdId = new URL(page.url()).pathname.split("/").at(-1);
		assert(createdId, "create command navigates to the canonical detail URL");
		const dialog = page.getByRole("dialog");
		await dialog
			.getByRole("heading", { name: `Ticket ${createdId}` })
			.waitFor();
		const updateForm = dialog
			.locator("form")
			.filter({ hasText: "Update fields" });
		await updateForm.getByLabel("Replacement title").fill(
			"GOL-55 browser-updated work item",
		);
		await updateForm.getByRole("button", { name: "Apply update" }).click();
		try {
			await updateForm
				.locator("[role='alert']")
				.filter({ hasText: "Command completed" })
				.waitFor();
		} catch (error) {
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}; update_dialog=${JSON.stringify(await dialog.innerText())}`,
			);
		}

		const currentRead = await bearer.request({
			method: "GET",
			path: `/api/v1/tracker/tickets/${createdId}`,
		});
		assert.equal(currentRead.status, 200);
		const externalUpdate = await bearer.request({
			method: "PATCH",
			path: `/api/v1/tracker/tickets/${createdId}`,
			body: {
				expected_revision: currentRead.body.revision,
				title: "GOL-55 external conflict advance",
				idempotency_key: "gol55:external:conflict",
			},
		});
		assert.equal(externalUpdate.status, 200);
		await updateForm.getByLabel("Replacement title").fill(
			"GOL-55 retained conflict draft",
		);
		await updateForm.getByRole("button", { name: "Apply update" }).click();
		await updateForm.getByText(/draft is retained/iu).waitFor();
		assert.equal(
			await updateForm.getByLabel("Replacement title").inputValue(),
			"GOL-55 retained conflict draft",
			"conflict retains the operator draft",
		);
		await dialog
			.locator("dt", { hasText: "Revision" })
			.locator("..")
			.locator("dd")
			.filter({ hasText: String(externalUpdate.body.result.revision) })
			.waitFor();
		await updateForm.getByRole("button", { name: "Apply update" }).click();
		await updateForm
			.locator("[role='alert']")
			.filter({ hasText: "Command completed" })
			.waitFor();

		const transitionForm = dialog
			.locator("form")
			.filter({ hasText: "Request phase transition" });
		await transitionForm.getByLabel("Target phase").click();
		await page.getByRole("option", { name: "Building", exact: true }).click();
		await transitionForm
			.getByRole("button", { name: "Request transition" })
			.click();
		await transitionForm
			.locator("[role='alert']")
			.filter({ hasText: "Command completed" })
			.waitFor();
		await dialog.getByText("building", { exact: true }).waitFor();

		const commentForm = dialog
			.locator("form")
			.filter({ hasText: "Add comment or reply" });
		await commentForm
			.getByRole("textbox", { name: "Comment", exact: true })
			.fill("GOL-55 browser comment");
		await commentForm.getByRole("button", { name: "Add comment" }).click();
		await commentForm
			.locator("[role='alert']")
			.filter({ hasText: "Command completed" })
			.waitFor();
		await commentForm.getByLabel("Thread").click();
		await page
			.getByRole("option")
			.filter({ hasText: "Reply to" })
			.first()
			.click();
		await commentForm
			.getByRole("textbox", { name: "Comment", exact: true })
			.fill("GOL-55 browser reply");
		await commentForm.getByRole("button", { name: "Add reply" }).click();
		await commentForm
			.locator("[role='alert']")
			.filter({ hasText: "Command completed" })
			.waitFor();

		const linkForm = dialog.locator("form").filter({ hasText: "Link ticket" });
		await linkForm.getByLabel("Target ticket ID").fill(seedData.ticket.id);
		await linkForm.getByRole("button", { name: "Add link" }).click();
		await linkForm
			.locator("[role='alert']")
			.filter({ hasText: "Command completed" })
			.waitFor();
		await dialog
			.getByRole("link", { name: seedData.ticket.id, exact: true })
			.waitFor();

		const streamForm = dialog
			.locator("form")
			.filter({ hasText: "Create stream" });
		await streamForm.getByLabel("Name").fill("GOL-55 browser stream");
		await streamForm.getByRole("button", { name: "Create stream" }).click();
		await streamForm
			.locator("[role='alert']")
			.filter({ hasText: "Command completed" })
			.waitFor();
		await dialog.getByText("GOL-55 browser stream", { exact: true }).waitFor();

		const childComposer = dialog
			.locator("details")
			.filter({ hasText: "Create a child ticket" });
		await childComposer.locator("summary").click();
		await childComposer
			.getByLabel("Ticket title")
			.fill("GOL-55 browser child");
		await childComposer.getByRole("button", { name: "Create ticket" }).click();
		await page.waitForURL(
			(url) =>
				url.pathname.startsWith("/tickets/") &&
				url.pathname.split("/").at(-1) !== createdId,
		);
		const childId = new URL(page.url()).pathname.split("/").at(-1);
		assert(childId && childId !== createdId);
		await page
			.getByRole("dialog")
			.getByText(`Parent: ${createdId}`, { exact: false })
			.waitFor();

		await page.goto(`${service.origin}/tickets/${seedData.ticket.id}`, {
			waitUntil: "domcontentloaded",
		});
		const dispatchDialog = page.getByRole("dialog");
		await dispatchDialog
			.getByRole("heading", { name: `Ticket ${seedData.ticket.id}` })
			.waitFor();
		const assetSection = dispatchDialog
			.locator("section")
			.filter({ hasText: "Safe assets" });
		await assetSection.getByRole("button", { name: "Read asset" }).click();
		await assetSection.getByRole("img").waitFor();
		const dispatchSection = dispatchDialog
			.locator("section")
			.filter({ hasText: "Dispatch" });
		await dispatchSection
			.getByRole("button", { name: "Dispatch ticket" })
			.click();
		await dispatchSection
			.locator("[role='alert']")
			.filter({ hasText: "Command completed" })
			.waitFor();
		const operationId = await dispatchSection
			.locator("dt", { hasText: "Operation" })
			.locator("..")
			.locator("dd")
			.innerText();
		assert(operationId, "dispatch exposes only its durable operation id");

		await page.goto(`${service.origin}/review`, {
			waitUntil: "domcontentloaded",
		});
		await page.getByTestId("roles-gates-ideas-ui").waitFor();
		const operationRow = page
			.locator("li")
			.filter({ hasText: operationId });
		await operationRow.waitFor();
		await operationRow.getByText("pending", { exact: true }).waitFor();

		const claims = await bearer.request({
			method: "POST",
			path: "/api/v1/delivery/claims",
			body: { limit: 20 },
		});
		assert.equal(claims.status, 200);
		const dispatchClaim = claims.body.items.find(
			(item) => item.payload.ticket_id === seedData.ticket.id,
		);
		assert(dispatchClaim);
		const prepared = await bearer.request({
			method: "POST",
			path: `/api/v1/delivery/claims/${encodeURIComponent(dispatchClaim.claimToken)}/prepare`,
			body: {},
		});
		assert.equal(prepared.status, 200);
		const acknowledged = await bearer.request({
			method: "POST",
			path: `/api/v1/delivery/claims/${encodeURIComponent(dispatchClaim.claimToken)}/ack`,
			body: {
				acknowledgement_id: "ack_gol55_dashboard",
				payload: {},
			},
		});
		assert.equal(acknowledged.status, 200);
		await operationRow.getByText("settled", { exact: true }).waitFor();

		const gateQuestion = "Approve the GOL-55 bounded browser cutover?";
		const gateForm = page
			.locator("form")
			.filter({ hasText: "Create gate" });
		await gateForm.getByLabel("Question").fill(gateQuestion);
		await gateForm.getByRole("button", { name: "Create gate" }).click();
		await gateForm
			.locator("[role='alert']")
			.filter({ hasText: "Command completed" })
			.waitFor();
		const gates = await bearer.request({
			method: "GET",
			path: "/api/v1/management/gates",
		});
		assert.equal(gates.status, 200);
		assert(
			gates.body.result.some((gate) => gate.question === gateQuestion),
			"gate command persists through the typed management service",
		);
		await page
			.getByRole("heading", { name: "Roles", exact: true })
			.waitFor();
		await page
			.getByRole("heading", { name: "Ideas", exact: true })
			.waitFor();
		const roleRow = page
			.locator("li")
			.filter({ hasText: "Browser project operator" });
		await roleRow.waitFor();
		await roleRow
			.getByRole("button", { name: "Assign project role" })
			.click();
		await page
			.locator("[role='alert']")
			.filter({ hasText: "Command completed" })
			.last()
			.waitFor();

		const ideaForm = page.locator("form").filter({ hasText: "Capture an idea" });
		await ideaForm.getByLabel("Idea").fill("GOL-55 browser promoted idea");
		await ideaForm.getByRole("button", { name: "Add idea" }).click();
		const promotedIdeaRow = page
			.locator("li")
			.filter({ hasText: "GOL-55 browser promoted idea" });
		await promotedIdeaRow.waitFor();
		await promotedIdeaRow.getByRole("button", { name: "Promote" }).click();
		await promotedIdeaRow.getByText("promoted", { exact: true }).waitFor();

		await ideaForm.getByLabel("Idea").fill("GOL-55 browser popped idea");
		await ideaForm.getByRole("button", { name: "Add idea" }).click();
		const poppedIdeaRow = page
			.locator("li")
			.filter({ hasText: "GOL-55 browser popped idea" });
		await poppedIdeaRow.waitFor();
		await poppedIdeaRow.getByRole("button", { name: "Pop" }).click();
		await poppedIdeaRow.getByText("popped", { exact: true }).waitFor();

		await page.getByRole("link", { name: "Specs", exact: true }).click();
		await page.getByTestId("specs-ui").waitFor();
		const specRow = page.locator("li", {
			has: page.getByRole("link", {
				name: seedData.spec.id,
				exact: true,
			}),
		});
		const questionRow = page.locator("li", {
			has: page.getByRole("link", {
				name: seedData.question.id,
				exact: true,
			}),
		});
		await specRow.waitFor();
		await questionRow.waitFor();
		await questionRow
			.getByText(`Child of ${seedData.spec.id}`, { exact: false })
			.waitFor();

		const requestedPaths = browserRequests.map(
			(value) => new URL(value).pathname,
		);
		assert.equal(
			requestedPaths.some((value) =>
				["/api/ideas", "/api/roles", "/api/v1/management/ideas"].includes(
					value,
				),
			),
			false,
			"typed UI never queries an unapproved role or idea endpoint",
		);
		const authorityRequests = browserRequests.filter((value) =>
			new URL(value).pathname.startsWith("/api/"),
		);
		assert.equal(
			authorityRequests.every(
				(value) => new URL(value).origin === service.origin,
			),
			true,
			"every dashboard authority request remains same-origin",
		);
		assert.deepEqual(browserErrors, [], "dashboard emits no console/page error");
		success = true;
	} catch (error) {
		try {
			await retainFailureArtifacts({
				artifactRoot,
				page,
				steps,
				error,
				temporaryRoot: home.root,
				sensitiveValues: [...sensitiveValues],
				childLogs: service
					? `${service.group.stdout()}\n${service.group.stderr()}`
					: "",
			});
		} catch {
			// Preserve the original failure when diagnostic capture is unavailable.
		}
		failure = new Error(
			`${redactDiagnostic(
				error instanceof Error ? error.stack ?? error.message : String(error),
				home.root,
				[...sensitiveValues],
			)}; sanitized_artifacts=${artifactRoot}`,
		);
	} finally {
		for (const context of contexts.reverse()) {
			try {
				await context.close();
			} catch {
				// Cleanup continues through every owned browser resource.
			}
		}
		if (chrome) {
			const profile = path.join(
				os.tmpdir(),
				`golem-chrome-headless-${chrome.port}-${process.pid}`,
			);
			await chrome.cleanup();
			await waitFor(
				async () => (!(await isPortListening(chrome.port)) ? true : undefined),
				"headless Chrome shutdown",
			).catch(() => undefined);
			fs.rmSync(profile, {
				recursive: true,
				force: true,
				maxRetries: 10,
				retryDelay: 100,
			});
		}
		if (service) await stopProcessGroup(service.group);
		if (servicePort)
			await waitFor(
				async () =>
					!(await isPortListening(servicePort)) ? true : undefined,
				"control-plane shutdown",
			).catch(() => undefined);
		home.cleanup();
	}
	if (failure) throw failure;
	assert.equal(success, true);
	assert.equal(fs.existsSync(home.root), false, "temporary home is removed");
	assert.equal(
		fs.existsSync(artifactRoot),
		false,
		"success retains no browser artifact",
	);
	return "compiled dashboard plus the GOL-75 control-plane fixture prove typed ticket body/labels/wave, comments/replies/links/children/streams, conflict retention, legal transition, scoped asset read, project-role assignment, gate/idea actions, canonical dispatch settlement, bounded spec relationships, same-origin authority, and owned-resource cleanup";
}

export async function exerciseWorkControlPlane() {
	return runWorkControlPlane();
}

export async function exerciseBrowserControlAuthorityDispatch() {
	return runWorkControlPlane();
}

export async function exerciseBrowserControlRestartResync() {
	return runWorkControlPlane();
}

export async function exerciseWorkManagementDashboard() {
	return runWorkManagementDashboard();
}

export async function exerciseTrackerDispatchUi() {
	return runWorkManagementDashboard();
}

export async function exerciseRolesGatesIdeasUi() {
	return runWorkManagementDashboard();
}
