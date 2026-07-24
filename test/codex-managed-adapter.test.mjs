import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
	composeControlPlaneEndpointEligibility,
	composeControlPlaneTrackerCoreServices,
	composeControlPlaneTrackerServices,
	composeManagedCodexSupervisor,
	createManagedCodexDeliveryPort,
	startControlPlane,
} from "../apps/control-plane/dist/index.js";
import { openControlPlanePersistence } from "../apps/control-plane/dist/persistence.js";
import {
	ManagedCodexQualificationError,
	ManagedCodexSupervisor,
	validateManagedTuiBinding,
} from "@golem/adapter-codex";
import {
	createEndpointService,
	createProjectService,
	createRuntimeMaterializer,
	createSessionService,
} from "@golem/runtime";
import { createTemporaryHome } from "@golem/testkit";
import { provisionBearerPrincipal } from "./fixtures/control-plane-principal.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const fixture = path.join(repositoryRoot, "test/fixtures/codex-managed-app-server.mjs");

function createClock(initial = "2026-07-21T00:00:00.000Z") {
	let current = initial;
	return Object.freeze({
		now: () => current,
		after: (milliseconds) =>
			new Date(Date.parse(current) + milliseconds).toISOString(),
		advance: (milliseconds) => {
			current = new Date(Date.parse(current) + milliseconds).toISOString();
			return current;
		},
	});
}

function id(prefix) {
	return `${prefix}_${randomUUID()}`;
}

function writeCanonicalAuthority(home) {
	const directory = path.join(home, "control-plane");
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(
		path.join(directory, "authority.json"),
		`${JSON.stringify(
			{
				schema_version: "golem.control-plane-authority/v1",
				stage: "C4",
				write_policy: "canonical_only",
				revision: 1,
				canonical_revision: 1,
				updated_at: "2026-07-21T00:00:00.000Z",
			},
			null,
			2,
		)}\n`,
	);
}

/**
 * J3: the production composition, not an adapter-only port fake. It starts a
 * real Fastify control plane against temporary SQLite files, creates a
 * canonical endpoint/session, then exercises the durable Tracker claim through
 * a spawned JSONL App Server. It exercises both crash windows: a pre-turn
 * process exit leaves the canonical envelope retryable, while a post-turn /
 * pre-ack crash writes the durable sent marker so replacement cannot replay
 * the same App Server client delivery id.
 */
test("J3 managed Codex control-plane delivery survives send-before-ack recovery", async () => {
	const home = createTemporaryHome("golem-j3-codex-managed-");
	const clock = createClock();
	const staticDirectory = path.join(home.root, "static");
	fs.mkdirSync(staticDirectory, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(staticDirectory, "index.html"), "<!doctype html><title>GOL-50 J3</title>");
	const turnLog = path.join(home.root, "turns.log");
	const turnState = path.join(home.root, "turns.json");
	let owner;
	let service;
	let supervisor;
	try {
		owner = openControlPlanePersistence(
			{
				runtimePath: home.runtimeDb,
				trackerPath: home.trackerDb,
				lockPath: path.join(home.root, "owner.lock"),
			},
			{ clock, ownerId: "gol50-j3-owner" },
		);
		const endpoints = createEndpointService({
			storage: owner.runtimeEndpointStorage(),
		});
		const tracker = composeControlPlaneTrackerServices({
			writer: owner,
			clock,
			eligibility: composeControlPlaneEndpointEligibility({
				endpoints: owner.runtimeEndpointStorage(),
				clock,
			}),
		});
		const principalResolver = provisionBearerPrincipal(owner, {
			token: home.token,
			projectId: "prj_gol50_fixture",
			actorId: "ses_gol50_fixture",
			bindingId: "principal_gol50_fixture",
			clock: { now: () => Date.parse(clock.now()) },
		});
		service = await startControlPlane({
			token: home.token,
			stateDirectory: path.join(home.root, "control-plane"),
			staticDirectory,
			trackerCore: composeControlPlaneTrackerCoreServices({ writer: owner, clock }),
			trackerServices: tracker,
			principalResolver,
		});
		const ready = await fetch(`${service.origin}/api/v1/health/ready`, {
			headers: { authorization: `Bearer ${home.token}` },
		});
		assert.equal(ready.status, 200, "temporary control plane is live");

		const projects = createProjectService({
			storage: owner.runtimeProjectStorage(),
			golemHome: home.root,
		});
		const project = projects.register({ cwd: repositoryRoot });
		const sessions = createSessionService({
			projects: owner.runtimeProjectStorage(),
			sessions: owner.runtimeSessionStorage(),
		});
		const runtime = createRuntimeMaterializer({
			home: home.root,
			writer: owner,
			sessions,
		});
		const binding = {
			projectId: project.projectId,
			sessionId: id("ses"),
			generationId: id("gen"),
			endpointId: id("endpoint"),
			ownerInstanceId: id("owner"),
			producerInstanceId: id("prod"),
		};
		assert.throws(
			() =>
				new ManagedCodexSupervisor({
					binding,
					projectPath: repositoryRoot,
					backend: "ollama_local",
					endpoints: {},
					ingress: { ingest() {} },
				}),
			ManagedCodexQualificationError,
			"unsupported local/OSS managed requests fail before a child can spawn",
		);
		supervisor = composeManagedCodexSupervisor({
			endpoints,
			ingress: {
				ingest(signal) {
					runtime.inbox.ingest(signal);
					runtime.materializer.drain();
				},
			},
			supervisor: {
				binding,
				projectPath: repositoryRoot,
				backend: "openai",
				model: "gpt-4o",
				command: process.execPath,
				rpc: { args: [fixture], requestTimeoutMs: 2_000 },
				env: {
					...process.env,
					NODE_PATH: "",
					GOLEM_CODEX_TURN_LOG: turnLog,
					GOLEM_CODEX_TURN_STATE: turnState,
				},
				now: clock.now,
			},
		});
		const started = await supervisor.start();
		assert.equal(started.deliveryReady, false, "launchability precedes consumer evidence");
		await supervisor.markConsumerReady();
		const readyEligibility = endpoints.eligibility({
			generationId: binding.generationId,
			routeKind: "delivery",
			requiredCapability: "delivery",
			expectedOwnerFence: started.ownerFence,
		});
		assert.equal(readyEligibility.disposition, "eligible", readyEligibility.code);
		assert.equal(await supervisor.deliveryReady(), true, "observed consumer readiness makes the canonical endpoint dispatchable");
		assert.equal(
			sessions.get(binding.projectId, binding.sessionId)?.generations.length,
			1,
			"managed start materializes one canonical generation through runtime ingress",
		);
		// Before the App Server accepts a turn, the envelope remains retryable. This
		// uses a real spawned process that exits on `turn/start`, not a port fake.
		await supervisor.stop({ release: false });
		supervisor = composeManagedCodexSupervisor({
			endpoints,
			ingress: {
				ingest(signal) {
					runtime.inbox.ingest(signal);
					runtime.materializer.drain();
				},
			},
			supervisor: {
				binding,
				projectPath: repositoryRoot,
				backend: "openai",
				model: "gpt-4o",
				command: process.execPath,
				rpc: { args: [fixture], requestTimeoutMs: 2_000 },
				env: {
					...process.env,
					NODE_PATH: "",
					GOLEM_CODEX_TURN_LOG: turnLog,
					GOLEM_CODEX_TURN_STATE: turnState,
					GOLEM_CODEX_FAIL_TURN_START: "1",
				},
				now: clock.now,
			},
		});
		await supervisor.start();
		await supervisor.markConsumerReady();
		const beforeStartEnvelope = tracker.delivery.enqueue({
			id: id("env"),
			idempotencyKey: id("idem"),
			senderId: id("sender"),
			recipientId: binding.endpointId,
			kind: "ticket_dispatch",
			payload: { text: "retry before turn" },
		});
		const [beforeStartClaim] = tracker.delivery.claim("codex-managed-j3-before", 1, 50);
		assert(beforeStartClaim, "pre-turn envelope is durably leased");
		const beforeStart = await supervisor.deliver({
			deliveryId: beforeStartEnvelope.id,
			text: "retry before turn",
			expectedOwnerFence: beforeStartEnvelope.endpoint.ownerFence,
			delivery: createManagedCodexDeliveryPort({ claim: beforeStartClaim }),
		});
		assert.equal(beforeStart.status, "retry", "a process exit before turn acceptance keeps the durable envelope retryable");
		assert.equal(fs.existsSync(turnLog), false, "pre-turn process exit creates no external turn");
		await supervisor.stop({ release: false });
		supervisor = composeManagedCodexSupervisor({
			endpoints,
			ingress: {
				ingest(signal) {
					runtime.inbox.ingest(signal);
					runtime.materializer.drain();
				},
			},
			supervisor: {
				binding,
				projectPath: repositoryRoot,
				backend: "openai",
				model: "gpt-4o",
				command: process.execPath,
				rpc: { args: [fixture], requestTimeoutMs: 2_000 },
				env: {
					...process.env,
					NODE_PATH: "",
					GOLEM_CODEX_TURN_LOG: turnLog,
					GOLEM_CODEX_TURN_STATE: turnState,
				},
				now: clock.now,
			},
		});
		await supervisor.start();
		await supervisor.markConsumerReady();
		clock.advance(1_000);
		const [beforeStartRecoveredClaim] = tracker.delivery.claim(
			"codex-managed-j3-before-recovery",
			1,
			50,
		);
		assert(beforeStartRecoveredClaim, "replacement supervisor reclaims the pre-turn envelope");
		const beforeStartRecovered = await supervisor.deliver({
			deliveryId: beforeStartEnvelope.id,
			text: "retry before turn",
			expectedOwnerFence: beforeStartEnvelope.endpoint.ownerFence,
			delivery: createManagedCodexDeliveryPort({ claim: beforeStartRecoveredClaim }),
		});
		assert.equal(beforeStartRecovered.status, "accepted", "pre-turn retry reaches exactly one App Server turn");
		assert.equal(
			fs.readFileSync(turnLog, "utf8").trim().split("\n").filter(Boolean).length,
			1,
			"recovered pre-turn delivery creates its first and only turn",
		);

		const envelope = tracker.delivery.enqueue({
			id: id("env"),
			idempotencyKey: id("idem"),
			senderId: id("sender"),
			recipientId: binding.endpointId,
			kind: "ticket_dispatch",
			payload: { text: "send exactly once" },
		});
		const [firstClaim] = tracker.delivery.claim("codex-managed-j3", 1, 50);
		assert(firstClaim, "canonical durable queue leases the ready managed endpoint");
		const firstPort = createManagedCodexDeliveryPort({ claim: firstClaim });
		const afterSendBeforeAck = await supervisor.deliver({
			deliveryId: envelope.id,
			text: "send exactly once",
			expectedOwnerFence: envelope.endpoint.ownerFence,
			delivery: {
				...firstPort,
				async ack() {
					throw new Error("test crash after turn/start before durable ack");
				},
			},
		});
		assert.equal(
			afterSendBeforeAck.status,
			"retry",
			"the crashed process reports its local acknowledgement failure",
		);
		// Model an abrupt supervisor loss: the process dies without releasing its
		// durable owner lease. The replacement binds the same persisted identity;
		// its delivery service must observe the committed send marker rather than
		// replaying the leased envelope.
		await supervisor.stop({ release: false });
		const restartedBinding = binding;
		supervisor = composeManagedCodexSupervisor({
			endpoints,
			ingress: {
				ingest(signal) {
					runtime.inbox.ingest(signal);
					runtime.materializer.drain();
				},
			},
			supervisor: {
				binding: restartedBinding,
				projectPath: repositoryRoot,
				backend: "openai",
				model: "gpt-4o",
				command: process.execPath,
				rpc: { args: [fixture], requestTimeoutMs: 2_000 },
				env: {
					...process.env,
					NODE_PATH: "",
					GOLEM_CODEX_TURN_LOG: turnLog,
					GOLEM_CODEX_TURN_STATE: turnState,
				},
				now: clock.now,
			},
		});
		await supervisor.start();
		await supervisor.markConsumerReady();
		assert.equal(await supervisor.deliveryReady(), true, "replacement supervisor has a fresh qualified fenced endpoint");
		clock.advance(1_000);
		tracker.delivery.recover();
		assert.equal(
			tracker.delivery.claim("codex-managed-j3-recovery", 1, 50).length,
			0,
			"the durable send marker prevents a restarted supervisor from reclaiming the sent delivery",
		);
		const duplicateDelivery = tracker.delivery.enqueue({
			id: envelope.id,
			idempotencyKey: envelope.idempotencyKey,
			senderId: envelope.senderId,
			recipientId: envelope.recipientId,
			kind: envelope.kind,
			payload: envelope.payload,
		});
		assert.equal(
			duplicateDelivery.status,
			"delivered",
			"the persistent post-turn marker survives replacement as the canonical duplicate record",
		);
		assert.equal(
			fs.readFileSync(turnLog, "utf8").trim().split("\n").filter(Boolean).length,
			2,
			"the same delivery id after supervisor restart cannot create a second App Server turn",
		);
		assert.equal(
			tracker.delivery.claim("codex-managed-j3-duplicate", 1, 50).length,
			0,
			"acknowledged envelope cannot be claimed as a duplicate delivery",
		);

		const staleEnvelope = tracker.delivery.enqueue({
			id: id("env"),
			idempotencyKey: id("idem"),
			senderId: id("sender"),
			recipientId: restartedBinding.endpointId,
			kind: "ticket_dispatch",
			payload: { text: "must be fenced" },
		});
		const [staleClaim] = tracker.delivery.claim("codex-managed-j3-stale", 1, 50);
		assert(staleClaim);
		endpoints.claim({
			endpointId: id("endpoint"),
			generationId: binding.generationId,
			routeKind: "delivery",
			ownerInstanceId: id("replacement"),
			deliveryMode: "managed_app_server",
			leaseMs: 30_000,
		});
		const stale = await supervisor.deliver({
			deliveryId: staleEnvelope.id,
			text: "must be fenced",
			expectedOwnerFence: staleEnvelope.endpoint.ownerFence,
			delivery: createManagedCodexDeliveryPort({ claim: staleClaim }),
		});
		assert.equal(stale.status, "rejected", "a superseding endpoint fence reaches no App Server transport");
		assert.equal(
			fs.readFileSync(turnLog, "utf8").trim().split("\n").filter(Boolean).length,
			2,
			"stale fence refusal cannot add a second turn",
		);
		assert.equal((await supervisor.control("interrupt")).status, "rejected", "a superseded owner cannot control the replacement endpoint");
		assert.equal(
			validateManagedTuiBinding(
				{
					socketPath: "/tmp/golem.sock",
					remote: "unix:///tmp/golem.sock",
					generationId: binding.generationId,
					cwd: repositoryRoot,
				},
				{ generationId: binding.generationId, cwd: repositoryRoot },
			).generationId,
			binding.generationId,
		);
		assert.throws(
			() =>
				validateManagedTuiBinding(
					{
						socketPath: "/tmp/golem.sock",
						remote: "unix:///tmp/golem.sock",
						generationId: id("gen"),
						cwd: repositoryRoot,
					},
					{ generationId: binding.generationId, cwd: repositoryRoot },
			),
			/tui_binding_mismatch/,
		);
		writeCanonicalAuthority(home.root);
		const cli = spawnSync(
			process.execPath,
			[
				path.join(repositoryRoot, "cli/golem.js"),
				"codex",
				"--backend",
				"ollama_local",
				"--dry-run",
				"--json",
			],
			{
				cwd: repositoryRoot,
				env: { ...process.env, GOLEM_HOME: home.root, GOLEM_ROOT: repositoryRoot },
				encoding: "utf8",
			},
		);
		assert.notEqual(cli.status, 0, "CLI rejects unsupported backend before spawn");
		const cliFailure = JSON.parse(cli.stdout);
		assert.equal(cliFailure.error.code, "adapter.codex.managed.qualification_required");
		assert.equal(cli.stdout.includes("ollama_local"), false, "policy diagnostic does not echo hostile selector");
		const productionHome = path.join(home.root, "production-home");
		writeCanonicalAuthority(productionHome);
		const productionTurnLog = path.join(home.root, "production-turns.log");
		const productionTurnState = path.join(home.root, "production-turns.json");
		const production = spawn(
			process.execPath,
			[
				path.join(repositoryRoot, "cli/golem.js"),
				"codex",
				"--session",
				"managed-root-host",
				"--cwd",
				repositoryRoot,
			],
			{
				cwd: repositoryRoot,
				env: {
					...process.env,
					GOLEM_ROOT: repositoryRoot,
					GOLEM_HOME: productionHome,
					GOLEM_CODEX_COMMAND: process.execPath,
					GOLEM_MANAGED_CODEX_ARGS_JSON: JSON.stringify([fixture]),
					GOLEM_CODEX_TURN_LOG: productionTurnLog,
					GOLEM_CODEX_TURN_STATE: productionTurnState,
					NODE_PATH: "",
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		const productionEvents = [];
		let productionOutput = "";
		let productionErrors = "";
		production.stdout.setEncoding("utf8");
		production.stdout.on("data", (chunk) => {
			productionOutput += chunk;
			let newline = productionOutput.indexOf("\n");
			while (newline !== -1) {
				const line = productionOutput.slice(0, newline);
				productionOutput = productionOutput.slice(newline + 1);
				try {
					productionEvents.push(JSON.parse(line));
				} catch {
					// The host uses JSONL; non-protocol process diagnostics stay isolated.
				}
				newline = productionOutput.indexOf("\n");
			}
		});
		production.stderr.setEncoding("utf8");
		production.stderr.on("data", (chunk) => {
			productionErrors += chunk;
		});
		const waitForProductionEvent = async (after, predicate, label) => {
			const startedAt = Date.now();
			while (Date.now() - startedAt < 4_000) {
				const event = productionEvents.slice(after).find(predicate);
				if (event) return event;
				if (production.exitCode !== null)
					throw new Error(
						`managed production codex host exited ${production.exitCode}: ${productionErrors}`,
					);
				await new Promise((resolveNext) => setTimeout(resolveNext, 20));
			}
			throw new Error(`managed production codex host did not emit ${label}: ${productionErrors}`);
		};
		const productionReady = await waitForProductionEvent(
			0,
			(event) => event.type === "managed-codex-ready",
			"ready",
		);
		assert.equal(
			productionReady.sessionId,
			"managed-root-host",
			"root golem codex routes --session through the managed host",
		);
		const productionDelivery = {
			type: "delivery",
			id: "root-host-envelope",
			text: "root host durable delivery",
		};
		const firstDeliveryOffset = productionEvents.length;
		production.stdin.write(`${JSON.stringify(productionDelivery)}\n`);
		const firstDelivery = await waitForProductionEvent(
			firstDeliveryOffset,
			(event) =>
				event.type === "managed-codex-drained" &&
				event.deliveryId === productionDelivery.id,
			"first durable delivery result",
		);
		assert.deepEqual(
			firstDelivery.outcomes,
			[{ deliveryId: productionDelivery.id, status: "accepted" }],
			"the root host claims the canonical durable envelope and sends one App Server turn",
		);
		const duplicateDeliveryOffset = productionEvents.length;
		production.stdin.write(`${JSON.stringify(productionDelivery)}\n`);
		const rootHostDuplicateDelivery = await waitForProductionEvent(
			duplicateDeliveryOffset,
			(event) =>
				event.type === "managed-codex-drained" &&
				event.deliveryId === productionDelivery.id,
			"duplicate durable delivery result",
		);
		assert.deepEqual(
			rootHostDuplicateDelivery.outcomes,
			[],
			"the duplicate durable envelope is not claimed a second time",
		);
		assert.equal(
			fs.readFileSync(productionTurnLog, "utf8").trim().split("\n").filter(Boolean)
				.length,
			1,
			"root-host duplicate suppression creates exactly one spawned App Server turn",
		);
		production.kill("SIGTERM");
		await new Promise((resolveExit) => production.once("exit", resolveExit));
		return "production golem codex host + temporary Fastify control plane + canonical SQLite endpoint/session + durable root-host enqueue/claim/exactly-once turn + send-before-ack restart exercised one spawned JSONL App Server turn, stale fence refusal, and managed policy";
	} finally {
		await supervisor?.stop().catch(() => {});
		await service?.close();
		await owner?.close();
		home.cleanup();
	}
});
