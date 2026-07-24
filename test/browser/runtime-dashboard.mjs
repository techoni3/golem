import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	createTemporaryHome,
	spawnGrouped,
	stopProcessGroup,
	waitFor,
} from "@golem/testkit";

import { acquireChrome } from "../../dashboard/scripts/_chrome.mjs";
import {
	BoundedReplayWindow,
	createBrowserPrincipalResolver,
	startControlPlane,
} from "../../apps/control-plane/dist/index.js";
import { openControlPlanePersistence } from "../../apps/control-plane/dist/persistence.js";
import {
	createRuntimeProjectionService,
	createSessionService,
} from "../../packages/runtime/dist/index.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const staticDirectory = path.join(repositoryRoot, "dashboard/dist/control-plane");
const serviceProgram = path.join(
	repositoryRoot,
	"apps/control-plane/dist/main.js",
);
const token = "golem-runtime-dashboard-browser-token-000000000000";
const projectId = "prj_00000000-0000-4000-8000-000000000054";
const sessionId = "ses_00000000-0000-4000-8000-000000000054";
const endedGenerationId = "gen_00000000-0000-4000-8000-000000000054";
const liveGenerationId = "gen_00000000-0000-4000-8000-000000000055";
const projectName =
	"Dashboard browser project with a deliberately long canonical display name for responsive containment";

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
		name: projectName,
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
				project_name: projectName,
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
				project_name: projectName,
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

async function start({ home, port, principalResolver, projection, replay }) {
	return startControlPlane({
		token,
		stateDirectory: path.join(home.root, "control-plane"),
		staticDirectory,
		...(port === undefined ? {} : { port }),
		principalResolver,
		projection: projectionAdapter(projection),
		runtimeProjection: projection,
		replay,
	});
}

function runtimePrincipal(owner, bindingId) {
	const storage = owner.browserPrincipalStorage();
	storage.provision({
		id: bindingId,
		actorId: "act_gol58_runtime_operator",
		role: "operator",
		defaultProjectId: projectId,
		scopeProjectIds: [projectId],
	});
	return createBrowserPrincipalResolver({
		storage,
		localOperatorBindingId: bindingId,
	});
}

function parseReady(output) {
	for (const line of output.split("\n")) {
		try {
			const message = JSON.parse(line);
			if (message.type === "ready" && typeof message.origin === "string")
				return message;
		} catch {
			// Bounded service diagnostics are reported only if readiness fails.
		}
	}
	return undefined;
}

function portOf(origin) {
	const port = Number(new URL(origin).port);
	assert(Number.isInteger(port) && port > 0, "control plane exposes a stable loopback port");
	return port;
}

export async function createRuntimeDashboardHarness(
	prefix = "golem-dashboard-polish-",
) {
	const home = createTemporaryHome(prefix);
	let owner;
	let processGroup;
	try {
		owner = openControlPlanePersistence(
			{
				runtimePath: path.join(home.golemHome, "runtime.db"),
				trackerPath: path.join(home.golemHome, "tracker.db"),
				lockPath: path.join(
					home.golemHome,
					"control-plane",
					"persistence.owner.lock",
				),
			},
			{ ownerId: `${prefix.replaceAll(/[^a-z0-9]/giu, "-")}owner` },
		);
		seed(owner);
		await owner.close();
		owner = undefined;
		processGroup = spawnGrouped(process.execPath, [serviceProgram], {
			cwd: repositoryRoot,
			env: {
				...home.env,
				GOLEM_BROWSER_LOCAL_OPERATOR_BINDING_ID: "bnd_gol58_browser_operator",
				GOLEM_CONTROL_PLANE_PORT: "0",
				GOLEM_CONTROL_PLANE_REPLAY_WINDOW: "8",
				GOLEM_CONTROL_PLANE_STATIC_ROOT: staticDirectory,
				GOLEM_CONTROL_PLANE_TOKEN: token,
			},
		});
		const ready = await waitFor(() => {
			const message = parseReady(processGroup.stdout());
			if (message) return message;
			if (
				processGroup.child.exitCode !== null ||
				processGroup.child.signalCode !== null
			)
				throw new Error(
					`dashboard control plane exited before readiness; stdout=${processGroup.stdout()}; stderr=${processGroup.stderr()}`,
				);
			return undefined;
		}, "dashboard control-plane readiness");
		return {
			origin: ready.origin,
			async close() {
				if (processGroup) await stopProcessGroup(processGroup);
				processGroup = undefined;
				home.cleanup();
			},
		};
	} catch (error) {
		if (processGroup) await stopProcessGroup(processGroup);
		if (owner) await owner.close();
		home.cleanup();
		throw error;
	}
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
		const principalResolver = runtimePrincipal(
			owner,
			"bnd_gol58_runtime_operator",
		);
		const projection = createRuntimeProjectionService({ storage: owner.runtimeProjectionStorage() });
		const replay = new BoundedReplayWindow(8);
		service = await start({ home, principalResolver, projection, replay });
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
			const sessionSearch = page.getByRole("searchbox", {
				name: "Find a session",
			});
			await sessionSearch.fill("no-canonical-session-matches-this-filter");
			await page.getByText("No live sessions", { exact: true }).waitFor();
			await sessionSearch.fill("");
			await page
				.getByRole("button", {
					name: "Open Dashboard browser session session details",
				})
				.waitFor();
			const beforeRead = projection.query("runtime.live").items[0]?.actor_activity_at;
			await page.reload({ waitUntil: "domcontentloaded" });
			await page.getByRole("button", { name: "Open Dashboard browser session session details" }).waitFor();
			assert.equal(projection.query("runtime.live").items[0]?.actor_activity_at, beforeRead, "reading or reloading the dashboard does not mutate actor activity");
			const foreignProjectRead = await page.evaluate(async () => {
				const response = await fetch(
					"/api/v1/runtime/live?project_id=prj_00000000-0000-4000-8000-000000000999",
				);
				return {
					status: response.status,
					body: await response.json(),
				};
			});
			assert.equal(
				foreignProjectRead.status,
				404,
				"runtime project filters remain bounded by the durable principal scope",
			);
			assert.equal(
				foreignProjectRead.body.code,
				"runtime.not_found",
				"out-of-scope runtime filters are non-disclosing",
			);
			const expectedForeignFailure = failedRequests.findIndex((entry) =>
				entry.includes("000000000999"),
			);
			assert.notEqual(
				expectedForeignFailure,
				-1,
				"the browser observed the expected scoped 404 response",
			);
			failedRequests.splice(expectedForeignFailure, 1);

			await page.getByRole("button", { name: "Open Dashboard browser session session details" }).click();
			await page.getByRole("dialog", { name: "Dashboard browser session details" }).waitFor();
			await page.getByText("Canonical session facts", { exact: true }).waitFor();
			await page.getByText("Endpoint and delivery facts", { exact: true }).waitFor();
			await page.getByText("Fence: 1", { exact: true }).waitFor();
			await page.getByText("Consumer ready", { exact: true }).waitFor();
			await page.keyboard.press("Escape");
			await page.getByRole("dialog", { name: "Dashboard browser session details" }).waitFor({ state: "hidden" });
			assert.equal(
				await page
					.getByRole("button", {
						name: "Open Dashboard browser session session details",
					})
					.evaluate((element) => document.activeElement === element),
				true,
				"closing the session drawer restores focus to the invoking card surface",
			);

			await page.getByRole("link", { name: "Projects" }).click();
			await page.getByRole("heading", { name: "Projects" }).waitFor();
			await page.getByRole("link", { name: /Dashboard browser project/ }).click();
			await page.getByRole("heading", { name: `Project ${projectId}` }).waitFor();
			try {
				await page
					.getByRole("button", {
						name: "Open Dashboard browser session session details",
					})
					.waitFor();
			} catch (error) {
				const http = await page.evaluate(async (id) => {
					const response = await fetch(
						`/api/v1/runtime/live?project_id=${encodeURIComponent(id)}`,
					);
					return { status: response.status, body: await response.text() };
				}, projectId);
				throw new Error(
					`project detail did not load; http=${JSON.stringify(http)}; body=${JSON.stringify(await page.locator("body").innerText())}; cause=${error instanceof Error ? error.message : String(error)}`,
				);
			}
			const projectCardCount = await page.getByTestId("passport-card").count();
			if (projectCardCount !== 1)
				throw new Error(
					`project detail expected one generation; direct=${JSON.stringify(projection.query("runtime.live", { projectId }))}; body=${JSON.stringify(await page.locator("body").innerText())}`,
				);

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
			await page.waitForFunction(
				() =>
					document
						.querySelector("[data-testid='runtime-connection']")
						?.getAttribute("data-state") === "disconnected",
				undefined,
				{ timeout: 8_000 },
			);
			assert.equal(
				await page.getByTestId("passport-card").count(),
				1,
				"a disconnected stream retains the last canonical snapshot",
			);
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
			service = await start({
				home,
				port: servicePort,
				principalResolver,
				projection,
				replay,
			});
			await page.getByText(`Canonical revision ${revisionAfterRestart}`, { exact: true }).waitFor({ timeout: 8_000 });
			await page.waitForFunction(() => document.querySelector("[data-testid='runtime-connection']")?.getAttribute("data-state") === "connected", undefined, { timeout: 8_000 });
			assert.equal(await page.getByTestId("passport-card").count(), 1, "restart resync replaces the snapshot without duplicating the live card");
			assert.deepEqual(browserErrors, [], "typed runtime routes produce no browser console or page errors");
			assert.deepEqual(failedRequests, [], "typed runtime routes issue no failed application requests");

			for (const [width, height] of [
				[360, 800],
				[768, 900],
				[1280, 900],
				[1600, 1000],
			]) {
				await page.setViewportSize({ width, height });
				const layout = await page.evaluate(() => ({ documentWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth }));
				assert.equal(layout.documentWidth <= layout.viewportWidth, true, `runtime dashboard avoids horizontal overflow at ${width}px`);
				await page.getByRole("link", { name: "Sessions" }).focus();
				assert.equal(await page.getByRole("link", { name: "Sessions" }).evaluate((element) => document.activeElement === element), true, `runtime navigation remains keyboard-reachable at ${width}px`);
				if (width === 360)
					assert.equal(
						await page.getByTestId("passport-card").evaluate((card) => {
							const content = card.querySelector(
								"[class*='passportContent']",
							);
							return content
								? getComputedStyle(content).gridTemplateColumns
										.trim()
										.split(/\s+/u).length
								: 0;
						}),
						1,
						"runtime PassportCard collapses to one column at 360px",
					);
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

export async function exerciseDashboardStateMatrix() {
	return exerciseRuntimeDashboard();
}
