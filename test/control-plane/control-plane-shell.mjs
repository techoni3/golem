import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

import {
	createTemporaryHome,
	spawnGrouped,
	stopProcessGroup,
	waitFor,
} from "@golem/testkit";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const serviceProgram = path.join(repositoryRoot, "apps/control-plane/dist/main.js");
const invalidResponseProgram = path.join(
	repositoryRoot,
	"test/control-plane/invalid-response-child.mjs",
);
const dashboardStaticRoot = path.join(repositoryRoot, "dashboard/dist");
const chromeExecutable = process.env.GOLEM_CHROME_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const controlPlaneToken = "control-plane-local-test-token";

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
			// Process diagnostics are intentionally ignored until a bounded failure.
		}
	}
	return undefined;
}

function processFailure(label, group) {
	return new Error(`${label}; command=${group.command}; stdout=${group.stdout()}; stderr=${group.stderr()}`);
}

async function start(home, program = serviceProgram) {
	const group = spawnGrouped(process.execPath, [program], {
		cwd: repositoryRoot,
		env: {
			...home.env,
			GOLEM_CONTROL_PLANE_TOKEN: controlPlaneToken,
			GOLEM_CONTROL_PLANE_PORT: "0",
			GOLEM_CONTROL_PLANE_REPLAY_WINDOW: "2",
			GOLEM_CONTROL_PLANE_STATIC_ROOT: dashboardStaticRoot,
		},
	});
	try {
		const readyOrFailure = await waitFor(() => {
			const ready = parseReady(group.stdout());
			if (ready) return ready;
			if (exited(group)) return { failure: processFailure("control plane exited before readiness", group) };
			return undefined;
		}, "control plane readiness");
		if ("failure" in readyOrFailure) throw readyOrFailure.failure;
		return { group, ...readyOrFailure };
	} catch (error) {
		await stopProcessGroup(group);
		throw error;
	}
}

async function requestJson(url, options) {
	const response = await fetch(url, options);
	return { response, body: await response.json() };
}

function requestWithHost(origin, host) {
	const url = new URL(`${origin}/api/v1/health/live`);
	return new Promise((resolve, reject) => {
		const request = http.request({
			host: url.hostname,
			port: url.port,
			path: url.pathname,
			headers: { host },
		}, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk) => { body += chunk; });
			response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
		});
		request.once("error", reject);
		request.end();
	});
}

function receiveFrame(url) {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url, { headers: { authorization: `Bearer ${controlPlaneToken}` } });
		const timeout = setTimeout(() => {
			socket.terminate();
			reject(new Error("control-plane WebSocket timed out"));
		}, 4_000);
		socket.once("message", (raw) => {
			clearTimeout(timeout);
			socket.close();
			try {
				resolve(JSON.parse(String(raw)));
			} catch (error) {
				reject(error);
			}
		});
		socket.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
	});
}

function setCookie(response) {
	const headers = response.headers;
	const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie")];
	const value = values.find(Boolean);
	if (!value) throw new Error("browser bootstrap response did not set its HttpOnly session cookie");
	assert.match(value, /HttpOnly/u, "browser cookie is HttpOnly");
	assert.match(value, /SameSite=Strict/u, "browser cookie is SameSite=Strict");
	assert.match(value, /Path=\//u, "browser cookie is path-scoped");
	assert.match(value, /Max-Age=600/u, "browser cookie has a bounded expiry");
	return value.split(";", 1)[0];
}

async function assertBrowserShell(origin) {
	if (!fs.existsSync(chromeExecutable))
		throw new Error(`headless Chrome fixture is unavailable: ${chromeExecutable}`);
	const browser = await chromium.launch({
		headless: true,
		executablePath: chromeExecutable,
		args: ["--no-first-run", "--no-default-browser-check", "--disable-default-apps", "--no-sandbox"],
	});
	try {
		const context = await browser.newContext();
		try {
			const page = await context.newPage();
			await page.goto(origin, { waitUntil: "domcontentloaded" });
			assert.equal(await page.locator("#root").count(), 1, "legacy dashboard static shell is served by the control plane");
		} finally {
			await context.close();
		}
	} finally {
		await browser.close();
	}
}

export async function exerciseControlPlaneShell() {
	const home = createTemporaryHome("golem-j6-control-plane-");
	const invalidHome = createTemporaryHome("golem-j6-invalid-response-");
	let first;
	let duplicate;
	let recovered;
	let invalidResponse;
	try {
		first = await start(home);
		assert.match(first.origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
		assert.match(first.instance_id, /^cpi_/u);
		const controlPlane = await import(
			"../../apps/control-plane/dist/index.js"
		);
		const serviceLock = await import(
			"../../apps/control-plane/dist/service-lock.js"
		);
		assert.equal(
			controlPlane.serviceLockStatus(
				path.join(home.golemHome, "control-plane"),
			).state,
			"active",
			"the foreground owner publishes an actionable active lock status",
		);

		const liveness = await requestJson(`${first.origin}/api/v1/health/live`);
		assert.equal(liveness.response.status, 200);
		assert.equal(liveness.body.status, "live");
		const legacyHealth = await requestJson(`${first.origin}/api/health`);
		assert.equal(legacyHealth.response.status, 200);
		assert.equal(legacyHealth.body.ok, true, "legacy dashboard health remains concrete JSON");
		const legacyMeta = await requestJson(`${first.origin}/api/meta`);
		assert.equal(legacyMeta.response.status, 200);
		assert.deepEqual(
			legacyMeta.body.columns,
			["triage", "open", "in-progress", "review", "blocked", "done"],
			"legacy dashboard meta retains its public columns contract",
		);

		const rejected = await requestJson(`${first.origin}/api/v1/meta`);
		assert.equal(rejected.response.status, 401);
		assert.deepEqual(Object.keys(rejected.body).sort(), ["code", "correlation_id", "message", "schema_version"]);
		assert.equal(rejected.body.schema_version, "golem.api-error/v1");

		const unsafeHost = await requestWithHost(first.origin, "example.invalid");
		assert.equal(unsafeHost.status, 400, "non-loopback Host is rejected before routing");

		const { createControlPlaneClient } = await import("../../packages/api-client/dist/index.js");
		const client = createControlPlaneClient({ baseUrl: first.origin, token: controlPlaneToken });
		const metadata = await client.GET("/api/v1/meta");
		assert.equal(metadata.response.status, 200);
		assert.equal(metadata.data.service, "control-plane", "generated openapi-fetch client reaches the typed endpoint");
		const openapi = await requestJson(`${first.origin}/api/v1/openapi.json`, {
			headers: { authorization: `Bearer ${controlPlaneToken}` },
		});
		assert.equal(openapi.response.status, 200);
		assert.equal(openapi.body.openapi, "3.1.1", "the authenticated process serves its deterministic OpenAPI document");

		const bootstrap = await requestJson(`${first.origin}/api/v1/browser/session`, {
			method: "POST",
			headers: { authorization: `Bearer ${controlPlaneToken}` },
		});
		assert.equal(bootstrap.response.status, 200);
		assert.equal(
			bootstrap.body.schema_version,
			"golem.control-plane-browser-session/v1",
			"bearer mutation succeeds without a browser Origin",
		);
		const cookie = setCookie(bootstrap.response);
		assert.match(cookie, /^golem_control_plane_session=/u);
		const invalidRequest = await requestJson(`${first.origin}/api/v1/browser/echo`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${controlPlaneToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ value: "" }),
		});
		assert.equal(invalidRequest.response.status, 400);
		assert.equal(invalidRequest.body.schema_version, "golem.api-error/v1");
		const invalidEcho = await requestJson(`${first.origin}/api/v1/browser/echo`, {
			method: "POST",
			headers: { cookie, origin: first.origin, "x-golem-csrf": bootstrap.body.csrf_token, "content-type": "application/json" },
			body: JSON.stringify({ value: "" }),
		});
		assert.equal(invalidEcho.response.status, 400);
		assert.equal(invalidEcho.body.schema_version, "golem.api-error/v1");
		const crossOrigin = await requestJson(`${first.origin}/api/v1/browser/echo`, {
			method: "POST",
			headers: {
				cookie,
				origin: "https://example.invalid",
				"x-golem-csrf": bootstrap.body.csrf_token,
				"content-type": "application/json",
			},
			body: JSON.stringify({ value: "cross-origin" }),
		});
		assert.equal(crossOrigin.response.status, 403);
		assert.equal(crossOrigin.body.code, "csrf.invalid");
		const missingCsrf = await requestJson(`${first.origin}/api/v1/browser/echo`, {
			method: "POST",
			headers: { cookie, origin: first.origin, "content-type": "application/json" },
			body: JSON.stringify({ value: "missing-csrf" }),
		});
		assert.equal(missingCsrf.response.status, 403);
		const snapshot = await receiveFrame(`${first.origin.replace("http", "ws")}/ws?stream=runtime.live`);
		assert.equal(snapshot.schema_version, "golem.websocket-frame/v1");
		assert.equal(snapshot.payload.kind, "snapshot");
		const echoed = await requestJson(`${first.origin}/api/v1/browser/echo`, {
			method: "POST",
			headers: { cookie, origin: first.origin, "x-golem-csrf": bootstrap.body.csrf_token, "content-type": "application/json" },
			body: JSON.stringify({ value: "browser-shell" }),
		});
		assert.equal(echoed.response.status, 200);
		assert.equal(echoed.body.value, "browser-shell");

		const delta = await receiveFrame(`${first.origin.replace("http", "ws")}/ws?stream=runtime.live&instance_id=${snapshot.instance_id}&cursor=${snapshot.payload.cursor}`);
		assert.equal(delta.payload.kind, "delta");
		assert.ok(delta.sequence > snapshot.sequence, "a valid WebSocket resume advances a monotonic sequence");
		assert.ok(delta.resource_revision >= snapshot.resource_revision, "a valid WebSocket resume advances a monotonic resource revision");
		for (const value of ["replay-one", "replay-two"]) {
			const published = await requestJson(`${first.origin}/api/v1/browser/echo`, {
				method: "POST",
				headers: { cookie, origin: first.origin, "x-golem-csrf": bootstrap.body.csrf_token, "content-type": "application/json" },
				body: JSON.stringify({ value }),
			});
			assert.equal(published.response.status, 200);
		}
		const compacted = await receiveFrame(`${first.origin.replace("http", "ws")}/ws?stream=runtime.live&instance_id=${snapshot.instance_id}&cursor=${snapshot.payload.cursor}`);
		assert.equal(compacted.payload.kind, "resync_required");
		assert.equal(compacted.payload.reason, "cursor_compacted", "bounded replay identifies a compacted cursor gap");

		duplicate = spawnGrouped(process.execPath, [serviceProgram], {
			cwd: repositoryRoot,
			env: { ...home.env, GOLEM_CONTROL_PLANE_TOKEN: controlPlaneToken, GOLEM_CONTROL_PLANE_PORT: "0", GOLEM_CONTROL_PLANE_STATIC_ROOT: dashboardStaticRoot },
		});
		await waitFor(() => exited(duplicate) ? true : undefined, "exclusive service-lock rejection");
		assert.notEqual(duplicate.child.exitCode, 0, "second owner cannot take the service lock");
		assert.match(`${duplicate.stdout()}${duplicate.stderr()}`, /service lock active/u);
		assert.equal(first.group.stdout().includes(controlPlaneToken), false, "readiness and logs never expose the bearer token");

		assert.equal(typeof first.group.child.pid, "number", "control plane exposes its process owner for the crash-recovery probe");
		first.group.child.kill("SIGKILL");
		await waitFor(() => exited(first.group) ? true : undefined, "forced control-plane owner exit");
		assert.equal(
			controlPlane.serviceLockStatus(
				path.join(home.golemHome, "control-plane"),
			).state,
			"stale",
			"a crashed owner is distinguishable before recovery",
		);
		first = undefined;
		recovered = await start(home);
		assert.notEqual(recovered.instance_id, snapshot.instance_id, "a restarted owner receives a fresh control-plane instance identity");
		const restarted = await receiveFrame(`${recovered.origin.replace("http", "ws")}/ws?stream=runtime.live&instance_id=${snapshot.instance_id}&cursor=${snapshot.payload.cursor}`);
		assert.equal(restarted.payload.kind, "resync_required");
		assert.equal(restarted.payload.reason, "instance_changed", "a restarted instance requires a fresh snapshot rather than replaying an old cursor");

		const lockStateDirectory = path.join(home.root, "nonce-safe-lock");
		const nonceLock = serviceLock.acquireServiceLock(lockStateDirectory);
		fs.writeFileSync(
			nonceLock.path,
			`${JSON.stringify({ pid: process.pid, nonce: "lock_00000000-0000-4000-8000-000000000000", started_at: new Date().toISOString() })}\n`,
		);
		nonceLock.release();
		assert.equal(fs.existsSync(nonceLock.path), true, "a lock owner cannot release a replaced lock nonce");
		fs.unlinkSync(nonceLock.path);
		fs.mkdirSync(lockStateDirectory, { recursive: true });
		fs.writeFileSync(path.join(lockStateDirectory, "control-plane.lock"), "not-json\n");
		const malformed = controlPlane.serviceLockStatus(lockStateDirectory);
		assert.equal(malformed.state, "invalid");
		assert.match(malformed.detail, /malformed/u, "malformed service locks return an actionable status");
		fs.unlinkSync(malformed.path);

		const launchDirectory = path.join(home.root, "LaunchAgents");
		const definition = {
			label: "dev.golem.control-plane",
			program: process.execPath,
			arguments: [serviceProgram],
			workingDirectory: repositoryRoot,
			environment: { GOLEM_HOME: home.golemHome },
		};
		const launchctlCalls = [];
		const runner = {
			run: (arguments_) => {
				launchctlCalls.push(arguments_);
				return { status: 0, stdout: "fixture", stderr: "" };
			},
		};
		const launchOptions = { uid: process.getuid(), runner };
		const initialLaunch = controlPlane.installLaunchAgent(launchDirectory, definition, launchOptions);
		assert.match(fs.readFileSync(initialLaunch.path, "utf8"), /<false\/>/u, "LaunchAgent plan never auto-starts the service");
		const updatedLaunch = controlPlane.updateLaunchAgent(launchDirectory, {
			...definition,
			arguments: [serviceProgram, "--foreground"],
		}, launchOptions);
		controlPlane.rollbackLaunchAgent(updatedLaunch, launchOptions);
		assert.equal(fs.readFileSync(initialLaunch.path, "utf8").includes("--foreground"), false, "LaunchAgent update can roll back without touching user LaunchAgents");
		const failureDefinition = { ...definition, label: "dev.golem.control-plane-failed" };
		assert.throws(
			() => controlPlane.installLaunchAgent(launchDirectory, failureDefinition, {
				uid: process.getuid(),
				runner: { run: () => ({ status: 1, stdout: "", stderr: "fixture failure" }) },
			}),
			/launchctl bootstrap/u,
			"a failed explicit install atomically rolls back its new plist",
		);
		assert.equal(fs.existsSync(path.join(launchDirectory, `${failureDefinition.label}.plist`)), false);
		assert.equal(
			controlPlane.statusLaunchAgent({
				directory: launchDirectory,
				label: definition.label,
				uid: process.getuid(),
				runner,
			}).loaded,
			true,
			"explicit LaunchAgent status reads an injected launchctl boundary",
		);
		controlPlane.startLaunchAgent({
			label: definition.label,
			uid: process.getuid(),
			runner,
		});
		controlPlane.stopLaunchAgent({
			label: definition.label,
			uid: process.getuid(),
			runner,
		});
		assert.deepEqual(
			launchctlCalls.map((arguments_) => arguments_[0]),
			["bootstrap", "bootout", "bootstrap", "bootout", "bootstrap", "print", "kickstart", "kill"],
			"install/update/rollback/status/start/stop use injected explicit argv and never auto-start",
		);

		invalidResponse = await start(invalidHome, invalidResponseProgram);
		const invalidHandler = await requestJson(`${invalidResponse.origin}/api/v1/health/live`);
		assert.equal(invalidHandler.response.status, 500);
		assert.equal(invalidHandler.body.schema_version, "golem.api-error/v1");
		assert.equal(invalidHandler.body.code, "response.invalid", "an invalid handler response maps to the stable GOL-26 envelope");
		await stopProcessGroup(invalidResponse.group);
		invalidResponse = undefined;

		const dashboardHelp = spawnSync(process.execPath, [path.join(repositoryRoot, "cli/golem.js"), "dashboard", "--help"], {
			cwd: repositoryRoot,
			encoding: "utf8",
		});
		assert.equal(dashboardHelp.status, 0, dashboardHelp.stderr);
		assert.match(dashboardHelp.stdout, /Usage: golem dashboard/u, "legacy dashboard --help remains a non-starting compatibility entrypoint");

		await assertBrowserShell(recovered.origin);
		return "real Fastify process validates generated-client auth, cookie+CSRF and typed errors; proves snapshot/resume/gap/restart WebSocket replay, concrete legacy/static compatibility, nonce-safe crash lock recovery, explicit atomic LaunchAgent commands, and graceful cleanup";
	} finally {
		if (invalidResponse) await stopProcessGroup(invalidResponse.group);
		if (duplicate && !exited(duplicate)) await stopProcessGroup(duplicate);
		if (recovered) await stopProcessGroup(recovered.group);
		if (first) await stopProcessGroup(first.group);
		assert.equal(fs.existsSync(path.join(home.golemHome, "control-plane", "control-plane.lock")), false, "SIGTERM cleanup releases the service lock");
		home.cleanup();
		assert.equal(fs.existsSync(home.root), false, "control-plane journey removes its temporary GOLEM_HOME");
		invalidHome.cleanup();
		assert.equal(fs.existsSync(invalidHome.root), false, "invalid-response child removes its temporary GOLEM_HOME");
	}
}
