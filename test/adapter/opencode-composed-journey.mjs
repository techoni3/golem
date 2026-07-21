import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { startControlPlane } from "../../apps/control-plane/dist/index.js";
import { openControlPlanePersistence } from "../../apps/control-plane/dist/persistence.js";
import {
	createEndpointService,
	createRuntimeMaterializer,
	createRuntimeProjectionService,
	createSessionService,
} from "@golem/runtime";
import { createTemporaryHome, waitFor } from "@golem/testkit";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const token = "golem-opencode-composed-token-000000000000";
const projectId = "prj_00000000-0000-4000-8000-000000000048";
const rawSessionId = "opencode-composed-session";
const uuid = (prefix, value) =>
	`${prefix}_00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

function seedProject(owner, projectRoot) {
	owner.runtimeProjectStorage().observe({
		projectId,
		name: "opencode-composed",
		location: {
			locationId: uuid("loc", 48),
			canonicalPath: projectRoot,
			relation: "main",
			source: "register",
			evidence: { fixture: true },
			observedAt: "2026-07-21T00:00:00.000Z",
		},
		source: "register",
		eventId: uuid("evt", 48),
		deduplicationKey: "gol48-opencode-project",
		payload: { kind: "project.observed" },
		provenance: { source: "api", confidence: "verified" },
		occurredAt: "2026-07-21T00:00:00.000Z",
	});
}

function withEnvironment(values) {
	const before = new Map(
		Object.keys(values).map((key) => [key, process.env[key]]),
	);
	for (const [key, value] of Object.entries(values)) process.env[key] = value;
	return () => {
		for (const [key, value] of before)
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
	};
}

async function canonicalSession(runtime, owner) {
	return waitFor(() => {
		runtime.materializer.drain();
		return owner.runtimeSessionStorage().list(projectId)[0];
	}, "OpenCode canonical SQLite lifecycle materialization");
}

async function bridgeRecord(home) {
	return waitFor(() => {
		const file = path.join(home.golemHome, "opencode-bridges.json");
		if (!fs.existsSync(file)) return undefined;
		const record = JSON.parse(fs.readFileSync(file, "utf8"));
		return record.bridges?.find((entry) => entry.session_id === rawSessionId);
	}, "OpenCode shim bridge registration");
}

async function sendDelivery(port, body) {
	const response = await fetch(`http://127.0.0.1:${port}/push`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: response.status, body: await response.json() };
}

function executeDirectLaunch(home, projectRoot, configPath, launchLog) {
	const bin = fs.mkdtempSync(path.join(home.root, "opencode-bin-"));
	const executable = path.join(bin, "opencode");
	fs.writeFileSync(
		executable,
		`#!/usr/bin/env node
import fs from "node:fs";
if (process.argv[2] === "--version") {
  process.stdout.write("opencode 1.2.3\\n");
  process.exit(0);
}
const config = fs.readFileSync(${JSON.stringify(configPath)}, "utf8");
fs.writeFileSync(${JSON.stringify(launchLog)}, JSON.stringify({ argv: process.argv.slice(2), config }) + "\\n");
`,
		{ mode: 0o755 },
	);
	try {
		const setupPath = path.join(home.root, "setup-opencode.jsonc");
		const setupOriginal = "// preserve this user comment\n{ \"provider\": { \"user\": { \"baseURL\": \"https://example.invalid\" } } }\n";
		fs.writeFileSync(setupPath, setupOriginal);
		const operation = (arguments_) =>
			spawnSync(process.execPath, ["cli/golem.js", ...arguments_], {
				cwd: repositoryRoot,
				encoding: "utf8",
				env: {
					...process.env,
					...home.env,
					PATH: `${bin}:${process.env.PATH}`,
					OPENAI_API_KEY: "gol48-test-key",
					OLLAMA_API_KEY: "gol48-cloud-key",
				},
			});
		const dryRun = operation(["opencode:setup", "--config", setupPath, "--json"]);
		assert.equal(dryRun.status, 0, dryRun.stderr);
		assert.equal(JSON.parse(dryRun.stdout).setup.dryRun, true);
		assert.equal(fs.readFileSync(setupPath, "utf8"), setupOriginal, "setup dry-run preserves user bytes");
		const apply = operation(["opencode:setup", "--config", setupPath, "--apply", "--json"]);
		assert.equal(apply.status, 0, apply.stderr);
		assert.equal(JSON.parse(apply.stdout).setup.dryRun, false);
		const setupApplied = fs.readFileSync(setupPath, "utf8");
		assert.match(setupApplied, /preserve this user comment/u);
		assert.match(setupApplied, /example\.invalid/u);
		assert.match(setupApplied, /"openai"/u);
		assert.match(setupApplied, /"ollama_cloud"/u);
		assert.equal(fs.readFileSync(`${setupPath}.golem-opencode.bak`, "utf8"), setupOriginal, "setup writes a rollback backup before apply");
		assert.doesNotMatch(setupApplied, /ollama launch opencode/u);
		const doctor = operation(["opencode:doctor", "--json"]);
		assert.equal(doctor.status, 0, doctor.stderr);
		assert.equal(JSON.parse(doctor.stdout).operation, "opencode:doctor");
		const refresh = operation(["opencode:refresh", "--json"]);
		assert.equal(refresh.status, 0, refresh.stderr);
		assert.equal(JSON.parse(refresh.stdout).operation, "opencode:refresh");
		const result = spawnSync(
			process.execPath,
			["cli/golem.js", "opencode", "--model", "gpt-composed", "--cwd", projectRoot],
			{
				cwd: repositoryRoot,
				encoding: "utf8",
				env: {
					...process.env,
					...home.env,
					PATH: `${bin}:${process.env.PATH}`,
					OPENAI_API_KEY: "gol48-test-key",
				},
			},
		);
		assert.equal(result.status, 0, `direct OpenCode launch failed: stdout=${result.stdout}; stderr=${result.stderr}`);
		const record = JSON.parse(fs.readFileSync(launchLog, "utf8"));
		assert.deepEqual(record.argv, ["--model", "gpt-composed"]);
		return record;
	} finally {
		fs.rmSync(bin, { recursive: true, force: true });
	}
}

export async function runOpenCodeComposedJourney() {
	const home = createTemporaryHome("golem-j5-opencode-composed-");
	const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "golem-opencode-project-"));
	const staticDirectory = path.join(home.root, "static");
	const configPath = path.join(home.root, "opencode.jsonc");
	const originalConfig = "// retain user configuration\n{ \"provider\": { \"user\": { \"baseURL\": \"https://example.invalid\" } } }\n";
	const launchLog = path.join(home.root, "opencode-launch.json");
	let owner;
	let control;
	let restoreEnvironment = () => {};
	try {
		fs.mkdirSync(staticDirectory, { recursive: true });
		fs.writeFileSync(path.join(staticDirectory, "index.html"), "<!doctype html><title>GOL-48</title>");
		fs.writeFileSync(configPath, originalConfig);
		owner = openControlPlanePersistence({
			runtimePath: home.runtimeDb,
			trackerPath: home.trackerDb,
		}, { ownerId: "gol48-opencode-composed" });
		seedProject(owner, projectRoot);
		const sessions = createSessionService({
			projects: owner.runtimeProjectStorage(),
			sessions: owner.runtimeSessionStorage(),
		});
		const runtime = createRuntimeMaterializer({
			home: home.root,
			writer: owner,
			sessions,
		});
		control = await startControlPlane({
			token,
			stateDirectory: path.join(home.root, "control-plane"),
			staticDirectory,
			runtimeIngress: runtime.inbox,
		});
		restoreEnvironment = withEnvironment({
			GOLEM_HOME: home.golemHome,
			GOLEM_CONTROL_PLANE_URL: control.origin,
			GOLEM_CONTROL_PLANE_TOKEN: token,
			GOLEM_RUNTIME_PROJECT_ID: projectId,
			XDG_CONFIG_HOME: home.xdgConfigHome,
		});
		const promptCalls = [];
		const { default: opencodeShim } = await import(
			`${pathToFileURL(path.join(repositoryRoot, "shims/opencode/index.js")).href}?gol48=${Date.now()}`,
		);
		const hooks = await opencodeShim({
			directory: projectRoot,
			client: {
				session: {
					promptAsync: async (request) => {
						promptCalls.push(request);
						return { response: { ok: true } };
					},
				},
			},
		});
		await hooks.event({
			event: {
				type: "session.created",
				properties: {
					info: {
						id: rawSessionId,
						directory: projectRoot,
						title: "OpenCode composed",
						model: "gpt-composed",
						time: { created: Date.now() },
					},
				},
			},
		});
		await hooks.event({
			event: {
				type: "session.created",
				properties: { info: { id: "opencode-child", parentID: rawSessionId } },
			},
		});
		let session = await canonicalSession(runtime, owner);
		assert.equal(owner.runtimeSessionStorage().list(projectId).length, 1, "child sessions never materialize as dispatchable cards");
		const firstGeneration = session.generations.find((generation) => generation.state !== "ended");
		assert(firstGeneration, "direct OpenCode event persisted a canonical live generation");
		const endpoints = createEndpointService({ storage: owner.runtimeEndpointStorage() });
		const endpoint = endpoints.claim({
			generationId: firstGeneration.generationId,
			routeKind: "delivery",
			ownerInstanceId: "gol48-opencode-bridge",
			deliveryMode: "prompt_bridge",
			leaseMs: 60_000,
		});
		assert.equal(endpoint.disposition, "accepted");
		assert(endpoint.ownerFence);
		const bridge = await bridgeRecord(home);
		const delivered = await sendDelivery(bridge.port, {
			delivery_id: "gol48-delivery-1",
			session_id: rawSessionId,
			kind: "brief",
			content: "private-prompt-value",
			fence: {
				generation_id: firstGeneration.generationId,
				owner_fence: String(endpoint.ownerFence),
				eligible: true,
			},
		});
		assert.equal(delivered.status, 202);
		assert.equal(promptCalls.length, 1, "fenced canonical delivery reaches actual SDK promptAsync once");
		assert.equal(promptCalls[0].path.id, rawSessionId, "adapter maps canonical identity back to OpenCode's native session id");
		assert.match(promptCalls[0].body.parts[0].text, /private-prompt-value/u);

		await hooks.event({ event: { type: "session.resumed", properties: { sessionID: rawSessionId } } });
		const resumed = await waitFor(() => {
			runtime.materializer.drain();
			session = owner.runtimeSessionStorage().list(projectId)[0];
			return session?.generations.find(
				(generation) =>
					generation.state !== "ended" &&
					generation.generationId !== firstGeneration.generationId,
			);
		}, "OpenCode resumed generation materialization");
		assert(resumed && resumed.generationId !== firstGeneration.generationId, "resume records a replacement canonical generation");
		const stale = await sendDelivery(bridge.port, {
			delivery_id: "gol48-delivery-stale",
			session_id: rawSessionId,
			kind: "brief",
			content: "must-not-deliver",
			fence: {
				generation_id: firstGeneration.generationId,
				owner_fence: String(endpoint.ownerFence),
				eligible: true,
			},
		});
		assert.equal(stale.status, 409);
		assert.equal(promptCalls.length, 1, "stale generation is rejected before promptAsync");

		const projection = createRuntimeProjectionService({
			storage: owner.runtimeProjectionStorage(),
			clock: { now: () => new Date().toISOString() },
		});
		const diagnostics = JSON.stringify(projection.read("runtime.diagnostics"));
		assert.doesNotMatch(diagnostics, /private-prompt-value|gol48-opencode-composed-token/u);
		executeDirectLaunch(home, projectRoot, configPath, launchLog);
		assert.equal(fs.readFileSync(configPath, "utf8"), originalConfig, "normal direct launch never mutates OpenCode configuration");
		assert.doesNotMatch(fs.readFileSync(launchLog, "utf8"), /ollama launch/u);
		await hooks.event({ event: { type: "server.instance.disposed", properties: {} } });
		return "OpenCode shim → authenticated runtime ingress → canonical SQLite lifecycle, fenced promptAsync delivery, resume stale-fence rejection, redacted diagnostics, and direct non-mutating upstream launch verified";
	} finally {
		restoreEnvironment();
		if (control) await control.close();
		if (owner) await owner.close();
		fs.rmSync(projectRoot, { recursive: true, force: true });
		home.cleanup();
	}
}
