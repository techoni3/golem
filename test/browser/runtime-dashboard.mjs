import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTemporaryHome } from "@golem/testkit";

import { acquireChrome } from "../../dashboard/scripts/_chrome.mjs";
import {
	BoundedReplayWindow,
	createBrowserSessionAuthority,
	startControlPlane,
} from "../../apps/control-plane/dist/index.js";
import { openControlPlanePersistence } from "../../apps/control-plane/dist/persistence.js";
import {
	createRuntimeProjectionService,
	createSessionService,
} from "../../packages/runtime/dist/index.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const staticDirectory = path.join(repositoryRoot, "dashboard/dist/control-plane");
const token = "golem-runtime-dashboard-browser-token-000000000000";
const projectId = "prj_00000000-0000-4000-8000-000000000054";
const sessionId = "ses_00000000-0000-4000-8000-000000000054";
const endedGenerationId = "gen_00000000-0000-4000-8000-000000000054";
const liveGenerationId = "gen_00000000-0000-4000-8000-000000000055";

function runtimeSignal(eventId, sequence, eventKind, generationId, payload = {}) {
	return {
		schema_version: "golem.runtime-signal/v1",
		event_id: eventId,
		event_kind: eventKind,
		producer: "runtime-dashboard-browser",
		producer_instance_id: "prod_00000000-0000-4000-8000-000000000054",
		producer_sequence: sequence,
		harness: "codex",
		correlation_id: "corr_00000000-0000-4000-8000-000000000054",
		deduplication_key: `runtime-dashboard-${sequence}`,
		clocks: {
			source_observed_at: `2026-07-21T00:00:${String(sequence).padStart(2, "0")}.000Z`,
			received_at: "2026-07-21T00:00:10.000Z",
			materialized_at: "2026-07-21T00:00:10.000Z",
		},
		provenance: { source: "browser-fixture", confidence: "verified", evidence_id: eventId },
		clear_fields: [],
		payload: {
			kind: eventKind,
			generation: { project_id: projectId, session_id: sessionId, generation_id: generationId },
			...payload,
		},
	};
}

function projectionAdapter(projection) {
	return {
		read: (stream) =>
			stream === "runtime.live" || stream === "runtime.history" || stream === "runtime.diagnostics"
				? projection.read(stream)
				: {},
		revision: (stream) =>
			stream === "runtime.live" || stream === "runtime.history" || stream === "runtime.diagnostics"
				? projection.revision(stream)
				: 0,
	};
}

function seed(owner) {
	owner.runtimeProjectStorage().observe({
		projectId,
		name: "Dashboard browser project",
		location: {
			locationId: "loc_00000000-0000-4000-8000-000000000054",
			canonicalPath: "/tmp/runtime-dashboard-browser",
			relation: "main",
			source: "register",
			evidence: { browser_fixture: true },
			observedAt: "2026-07-21T00:00:00.000Z",
		},
		source: "register",
		eventId: "evt_00000000-0000-4000-8000-000000000054",
		deduplicationKey: "runtime-dashboard-project",
		payload: { kind: "project.observed" },
		provenance: { source: "browser-fixture", confidence: "verified" },
		occurredAt: "2026-07-21T00:00:00.000Z",
	});
	const sessions = createSessionService({
		projects: owner.runtimeProjectStorage(),
		sessions: owner.runtimeSessionStorage(),
	});
	assert.equal(
		sessions.apply(runtimeSignal("evt_00000000-0000-4000-8000-000000000055", 1, "session.started", endedGenerationId, {
			metadata: {
				model: "gpt-5",
				name: "Dashboard browser session",
				project_name: "Dashboard browser project",
				role: "explorer",
			},
		})).disposition,
		"accepted",
	);
	assert.equal(
		sessions.apply(runtimeSignal("evt_00000000-0000-4000-8000-000000000056", 2, "session.ended", endedGenerationId, { disposition: "ended" })).disposition,
		"accepted",
	);
	assert.equal(
		sessions.apply(runtimeSignal("evt_00000000-0000-4000-8000-000000000057", 3, "session.resumed", liveGenerationId, {
			resumed_from_generation_id: endedGenerationId,
		})).disposition,
		"accepted",
	);
	assert.equal(
		sessions.apply(runtimeSignal("evt_00000000-0000-4000-8000-000000000058", 4, "session.metadata_patched", liveGenerationId, {
			metadata: {
				model: "gpt-5",
				name: "Dashboard browser session",
				project_name: "Dashboard browser project",
				role: "explorer",
			},
		})).disposition,
		"accepted",
	);
	const endpoint = owner.runtimeEndpointStorage().claim({
		generationId: liveGenerationId,
		routeKind: "delivery",
		ownerInstanceId: "runtime-dashboard-owner",
		deliveryMode: "native_channel",
		readiness: "ready",
		controlState: "enabled",
		leaseMs: 60_000,
	});
	assert(endpoint.endpointId && endpoint.ownerFence, "browser fixture claims a fenced delivery endpoint");
	const identity = {
		endpointId: endpoint.endpointId,
		generationId: liveGenerationId,
		ownerInstanceId: "runtime-dashboard-owner",
		ownerFence: endpoint.ownerFence,
	};
	assert.equal(owner.runtimeEndpointStorage().reportHealth({ ...identity, state: "healthy" }).disposition, "accepted");
	assert.equal(owner.runtimeEndpointStorage().probe({ ...identity, consumerReady: true }).disposition, "accepted");
	assert.equal(owner.runtimeEndpointStorage().reportReadiness({ ...identity, deliveryMode: "native_channel", readiness: "ready" }).disposition, "accepted");
	assert.equal(owner.runtimeEndpointStorage().reportDelivery({ ...identity, status: "delivered", readiness: "ready" }).disposition, "accepted");
	assert.equal(
		owner.runtimeEndpointStorage().reportCapability({
			...identity,
			capability: {
				capability: "control.dispatch",
				adapterId: "browser-fixture",
				adapterVersion: "1.0.0",
				qualification: "supported",
				deliveryMode: "native_channel",
				readiness: "ready",
				evidenceKind: "observed",
				observedAt: "2026-07-21T00:00:04.000Z",
			},
			evidence: { consumed: true },
		}).disposition,
		"accepted",
	);
	owner.materializeRuntimeEvent({
		eventId: "evt_00000000-0000-4000-8000-000000000059",
		deduplicationKey: "runtime-dashboard-stale-fence",
		eventKind: "runtime.dashboard.stale_fence",
		payload: { token: "browser-secret" },
		provenance: { source: "browser-fixture" },
		occurredAt: "2026-07-21T00:00:05.000Z",
		producer: { id: "runtime-dashboard-browser", sequence: 9 },
		disposition: "illegal",
		explanation: {
			code: "runtime.dashboard.stale_fence",
			details: {
				owner_fence: endpoint.ownerFence - 1,
				token: "browser-secret",
				prompt: "browser-private-prompt",
				path: "/private/tmp/browser-private-path",
			},
		},
	});
	return { endpointIdentity: identity, sessions };
}

async function start({ browserSessions, home, port, projection, replay }) {
	return startControlPlane({
		token,
		stateDirectory: path.join(home.root, "control-plane"),
		staticDirectory,
		...(port === undefined ? {} : { port }),
		browserSessions,
		projection: projectionAdapter(projection),
		runtimeProjection: projection,
		replay,
	});
}

function portOf(origin) {
	const port = Number(new URL(origin).port);
	assert(Number.isInteger(port) && port > 0, "control plane exposes a stable loopback port");
	return port;
}

export async function exerciseRuntimeDashboard() {
	const home = createTemporaryHome("golem-gol54-runtime-dashboard-");
	let owner;
	let service;
	let chrome;
	try {
		owner = openControlPlanePersistence(
			{ runtimePath: home.runtimeDb, trackerPath: home.trackerDb },
			{ ownerId: "gol54-runtime-dashboard-owner" },
		);
		const { endpointIdentity, sessions } = seed(owner);
		const projection = createRuntimeProjectionService({ storage: owner.runtimeProjectionStorage() });
		const replay = new BoundedReplayWindow(8);
		const browserSessions = createBrowserSessionAuthority();
		service = await start({ browserSessions, home, projection, replay });
		const origin = service.origin;
		const servicePort = portOf(origin);
		chrome = await acquireChrome();
		const context = await chrome.browser.newContext();
		const page = await context.newPage();
		const browserErrors = [];
		const failedRequests = [];
		page.on("console", (message) => {
			if (message.type() === "error" && !/Failed to load resource/u.test(message.text()))
				browserErrors.push(message.text());
		});
		page.on("pageerror", (error) => browserErrors.push(error.message));
		page.on("response", (response) => {
			if (response.status() >= 400 && !response.url().endsWith("/favicon.ico"))
				failedRequests.push(`${response.status()} ${response.url()}`);
		});
		page.setDefaultTimeout(6_000);
		try {
			await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
			await page.getByRole("heading", { name: "Runtime overview" }).waitFor();
			await page.getByTestId("runtime-connection").waitFor();
			try {
				await page.getByRole("button", { name: "Open Dashboard browser session session details" }).waitFor();
			} catch (error) {
				throw new Error(`runtime passport card did not render; body=${await page.locator("body").innerText()}; browser=${browserErrors.join(" | ")}; cause=${error instanceof Error ? error.message : String(error)}`);
			}
			assert.equal(await page.getByTestId("passport-card").count(), 1, "Overview renders exactly one canonical eligible live generation");
			assert.equal(await page.getByText(endedGenerationId, { exact: true }).count(), 0, "Overview never renders an ended generation");
			assert.equal(
				await page.getByTestId("passport-card").evaluate((card) => card.getBoundingClientRect().width <= 520),
				true,
				"runtime PassportCard is bounded instead of stretching with roster count",
			);
			const beforeRead = projection.query("runtime.live").items[0]?.actor_activity_at;
			await page.reload({ waitUntil: "domcontentloaded" });
			await page.getByRole("button", { name: "Open Dashboard browser session session details" }).waitFor();
			assert.equal(projection.query("runtime.live").items[0]?.actor_activity_at, beforeRead, "reading or reloading the dashboard does not mutate actor activity");

			await page.getByRole("button", { name: "Open Dashboard browser session session details" }).click();
			await page.getByRole("dialog", { name: "Dashboard browser session details" }).waitFor();
			await page.getByText("Canonical session facts", { exact: true }).waitFor();
			await page.getByText("Endpoint and delivery facts", { exact: true }).waitFor();
			await page.getByText("Fence: 1", { exact: true }).waitFor();
			await page.getByText("Consumer ready", { exact: true }).waitFor();
			await page.keyboard.press("Escape");
			await page.getByRole("dialog", { name: "Dashboard browser session details" }).waitFor({ state: "hidden" });

			await page.getByRole("link", { name: "Projects" }).click();
			await page.getByRole("heading", { name: "Projects" }).waitFor();
			await page.getByRole("link", { name: /Dashboard browser project/ }).click();
			await page.getByRole("heading", { name: `Project ${projectId}` }).waitFor();
			assert.equal(await page.getByTestId("passport-card").count(), 1, "project detail reuses the same one-card generation identity");

			await page.getByRole("link", { name: "History" }).click();
			await page.getByRole("heading", { name: "History" }).waitFor();
			await page.getByText(endedGenerationId, { exact: true }).waitFor();
			assert.equal(await page.getByText(liveGenerationId, { exact: true }).count(), 0, "History excludes the live generation");

			await page.getByRole("link", { name: "Diagnostics" }).click();
			await page.getByRole("heading", { name: "Diagnostics" }).waitFor();
			try {
				await page.getByText("runtime.dashboard.stale_fence", { exact: true }).click();
			} catch (error) {
				throw new Error(`runtime diagnostics did not render seeded stale-fence fact; direct=${JSON.stringify(projection.query("runtime.diagnostics"))}; body=${await page.locator("body").innerText()}; cause=${error instanceof Error ? error.message : String(error)}`);
			}
			await page.getByText("Suggested remedy:", { exact: false }).waitFor();
			const diagnosticText = await page.getByTestId("runtime-diagnostics").textContent();
			assert.match(diagnosticText ?? "", /\[REDACTED\]/u, "diagnostics retain the control-plane redaction marker");
			assert.doesNotMatch(diagnosticText ?? "", /browser-secret|browser-private-prompt|browser-private-path/u, "diagnostics never render secret, prompt, or path inputs");

			await page.getByRole("link", { name: "Overview" }).click();
			await page.getByRole("heading", { name: "Runtime overview" }).waitFor();
			const revisionBeforeRestart = projection.query("runtime.live").resource_revision;
			await service.close();
			service = undefined;
			assert.equal(
				sessions.apply(runtimeSignal("evt_00000000-0000-4000-8000-000000000060", 5, "session.activity", liveGenerationId, { activity_kind: "work" })).disposition,
				"accepted",
				"only an explicit actor event advances activity",
			);
			assert.equal(
				owner.runtimeEndpointStorage().heartbeat({ ...endpointIdentity, leaseMs: 60_000 }).disposition,
				"accepted",
				"the restart fixture publishes a strictly newer canonical endpoint revision",
			);
			const revisionAfterRestart = projection.query("runtime.live").resource_revision;
			assert.ok(revisionAfterRestart > revisionBeforeRestart, "fixture has a newer authoritative revision for restart resync");
			service = await start({ browserSessions, home, port: servicePort, projection, replay });
			await page.getByText(`Canonical revision ${revisionAfterRestart}`, { exact: true }).waitFor({ timeout: 8_000 });
			await page.waitForFunction(() => document.querySelector("[data-testid='runtime-connection']")?.getAttribute("data-state") === "connected", undefined, { timeout: 8_000 });
			assert.equal(await page.getByTestId("passport-card").count(), 1, "restart resync replaces the snapshot without duplicating the live card");
			assert.deepEqual(browserErrors, [], "typed runtime routes produce no browser console or page errors");
			assert.deepEqual(failedRequests, [], "typed runtime routes issue no failed application requests");

			for (const [width, height] of [[360, 800], [768, 900], [1280, 900]]) {
				await page.setViewportSize({ width, height });
				const layout = await page.evaluate(() => ({ documentWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth }));
				assert.equal(layout.documentWidth <= layout.viewportWidth, true, `runtime dashboard avoids horizontal overflow at ${width}px`);
				await page.getByRole("link", { name: "Sessions" }).focus();
				assert.equal(await page.getByRole("link", { name: "Sessions" }).evaluate((element) => document.activeElement === element), true, `runtime navigation remains keyboard-reachable at ${width}px`);
			}
		} finally {
			await context.close();
		}
		return "real built dashboard plus temporary SQLite control plane prove canonical live/project/history/diagnostic routes, safe detail facts, passive reads, bounded cards, and restart snapshot resync";
	} finally {
		if (chrome) await chrome.cleanup();
		if (service) await service.close();
		if (owner) await owner.close();
		home.cleanup();
	}
}
