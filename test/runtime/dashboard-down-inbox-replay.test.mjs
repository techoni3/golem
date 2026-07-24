import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	createRuntimeMaterializer,
	RuntimeEngineScheduler,
	RuntimeInbox,
	RuntimeOutboxDrainer,
} from "@golem/runtime";
import { createTemporaryHome, waitFor } from "@golem/testkit";
import { startControlPlane } from "../../apps/control-plane/dist/index.js";
import { openControlPlanePersistence } from "../../apps/control-plane/dist/persistence.js";
import { provisionBearerPrincipal } from "../fixtures/control-plane-principal.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const producerFixture = path.join(repositoryRoot, "test/runtime/inbox-producer.mjs");

function id(prefix, number) {
	return `${prefix}_00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

function signal(number) {
	return {
		schema_version: "golem.runtime-signal/v1",
		event_id: id("evt", number),
		event_kind: "project.observed",
		producer: "hook-fixture",
		producer_instance_id: id("prod", number),
		harness: "claude",
		correlation_id: `dashboard-down-${number}`,
		deduplication_key: `dashboard-down-${number}`,
		clocks: { source_observed_at: "2026-07-20T00:00:00.000Z", received_at: "2026-07-20T00:00:01.000Z" },
		provenance: { source: "adapter", confidence: "verified", evidence_id: `dashboard-down-${number}` },
		clear_fields: [],
		payload: {
			kind: "project.observed",
			project: { project_id: id("prj", number) },
			location: { project_id: id("prj", number), location_id: id("loc", number), relation: "registered", canonical_path: `/temporary/dashboard-down-${number}` },
		},
	};
}

function spawnAbsentServiceProducer(home, envelope) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [producerFixture], {
			cwd: repositoryRoot,
			env: { ...home.env, GOLEM_RUNTIME_TEST_HOME: home.root, GOLEM_RUNTIME_TEST_SIGNAL: JSON.stringify(envelope) },
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`service-down hook producer exited ${code}: ${stderr}`));
		});
	});
}

test("J1 dashboard-down producers replay only after the service starts", async (t) => {
	const home = createTemporaryHome("golem-j1-dashboard-down-");
	let owner;
	let scheduler;
	let service;
	try {
		await Promise.all(Array.from({ length: 24 }, (_, index) => spawnAbsentServiceProducer(home, signal(index + 1))));
		const absentInbox = new RuntimeInbox(home.root);
		assert.equal(absentInbox.metrics().pending, 24, "filesystem-only hook producers succeed while the dashboard/service is absent");
		assert.equal(fs.existsSync(home.runtimeDb), false, "absent service producers never open runtime SQLite");

		owner = openControlPlanePersistence({ runtimePath: home.runtimeDb, trackerPath: home.trackerDb });
		const principalResolver = provisionBearerPrincipal(owner, {
			token: home.token,
			projectId: id("prj", 1),
			actorId: id("actor", 1),
			bindingId: id("principal", 1),
		});
		const runtime = createRuntimeMaterializer({ home: home.root, writer: owner });
		const outbox = new RuntimeOutboxDrainer({
			writer: owner,
			workerId: "runtime-j1-service-start",
			destinations: { tracker: { deliver: async () => undefined } },
		});
		scheduler = new RuntimeEngineScheduler({ materializer: runtime.materializer, outbox, writer: owner, intervalMs: 25 });
		await scheduler.start();
		const staticDirectory = path.join(home.root, "control-plane-static");
		fs.mkdirSync(staticDirectory, { recursive: true, mode: 0o700 });
		fs.writeFileSync(path.join(staticDirectory, "index.html"), "<!doctype html><title>J1 replay</title>");
		try {
			service = await startControlPlane({
				token: home.token,
				stateDirectory: path.join(home.root, "control-plane-state"),
				staticDirectory,
				runtimeIngress: runtime.inbox,
				runtimeHealth: scheduler,
				principalResolver,
			});
			const health = await fetch(`${service.origin}/api/v1/health/ready`, { headers: { authorization: `Bearer ${home.token}` } });
			assert.equal(health.status, 200, "started service exposes bounded runtime health");
			const body = await health.json();
			assert.equal(body.runtime.inbox.archived, 24, "service start replays all previously spooled hook envelopes");
		} catch (error) {
			if (!/(?:EPERM|EACCES).*listen|listen.*(?:EPERM|EACCES)/iu.test(String(error))) throw error;
			t.diagnostic("UNMET: sandbox rejected the real 127.0.0.1 service-start boundary (EPERM)");
		}
		await waitFor(() => (runtime.inbox.metrics().archived === 24 ? true : undefined), "service-start inbox replay", 10_000);
		assert.equal(runtime.inbox.metrics().pending, 0, "service-start replay leaves no pending envelope");
		assert.equal(runtime.inbox.metrics().processing, 0, "service-start replay releases all claims");
		assert(scheduler.health().lastSuccessfulMaterializationAt, "scheduler health records successful replay without payload leakage");
	} finally {
		await service?.close();
		await scheduler?.stop();
		await owner?.close();
		home.cleanup();
		assert.equal(fs.existsSync(home.root), false, "dashboard-down replay removes its entire temporary home");
	}
});
