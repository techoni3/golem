import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { composeControlPlaneProjectService } from "@golem/control-plane";
import { createTemporaryHome } from "@golem/testkit";
import { openControlPlanePersistence } from "../../apps/control-plane/dist/persistence.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const producer = path.join(repositoryRoot, "test/projects/register-producer.mjs");

function child(home, cwd, ordinal) {
	const process_ = spawn(process.execPath, [producer, home.golemHome, cwd, String(ordinal)], {
		cwd: repositoryRoot,
		env: { ...home.env, NODE_PATH: path.join(repositoryRoot, "node_modules") },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	process_.stdout.setEncoding("utf8");
	process_.stderr.setEncoding("utf8");
	process_.stdout.on("data", (chunk) => { stdout += chunk; });
	process_.stderr.on("data", (chunk) => { stderr += chunk; });
	return { process_, stdout: () => stdout, stderr: () => stderr };
}

test("J2 concurrent duplicate register producers converge through the durable runtime inbox", async () => {
	const home = createTemporaryHome("golem-j2-project-concurrency-");
	let owner;
	const repo = path.join(home.root, "registered-project");
	fs.mkdirSync(repo, { recursive: true });
	const children = [child(home, repo, 1), child(home, repo, 2)];
	try {
		await Promise.all(children.map(({ process_ }) => new Promise((resolve, reject) => {
			process_.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`producer exited ${code}`)));
		})));
		for (const entry of children) assert.equal(entry.stderr(), "", "producer children emit no unbounded/raw diagnostics");
		const pending = fs.readdirSync(path.join(home.golemHome, "inbox", "pending")).filter((name) => name.endsWith(".json"));
		assert.equal(pending.length, 2, "both independent producer processes publish complete envelopes");

		owner = openControlPlanePersistence({ runtimePath: home.runtimeDb, trackerPath: home.trackerDb });
		const service = composeControlPlaneProjectService(owner, { golemHome: home.golemHome, homeDirectory: home.home });
		for (const file of pending.sort()) {
			const signal = JSON.parse(fs.readFileSync(path.join(home.golemHome, "inbox", "pending", file), "utf8"));
			service.ingest(signal);
		}
		const view = service.resolve(repo).view;
		assert(view);
		assert.equal(view.projectId, "prj_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
		assert.equal(view.locations.length, 1, "duplicate register signals converge to one location");
		assert.equal(view.locations[0].status, "active");
		assert.equal(owner.runtimeProjectStorage().findByCanonicalPath(fs.realpathSync(repo))?.projectId, view.projectId);
		assert.equal(owner.runtimeOutboxHealth().pending, 1, "deduplicated register events emit one projection outbox");
		assert.equal(fs.readdirSync(path.join(home.golemHome, "inbox", "pending")).length, 2, "producer envelopes remain durable until the materializer acknowledges them");
	} finally {
		for (const { process_ } of children) if (process_.exitCode === null) process_.kill("SIGTERM");
		if (owner) await owner.close();
		home.cleanup();
		assert.equal(fs.existsSync(home.root), false);
	}
});
