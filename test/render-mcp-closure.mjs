import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	compileRender,
	createRenderManifest,
	inspectRender,
	manifestSha256,
	manifestFromLegacyPlan,
	renderTargets,
} from "@golem/compiler";
import { legacyToolNames } from "@golem/mcp-adapter";

import * as cc from "../lib/compiler/adapters/cc.js";
import * as codex from "../lib/compiler/adapters/codex.js";
import * as opencode from "../lib/compiler/adapters/opencode.js";
import * as pi from "../lib/compiler/adapters/pi.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const substrateRoot = path.join(repositoryRoot, "substrate");
const packageVersion = JSON.parse(
	readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
).version;

function prefixed(prefix, items) {
	return items.map((item) => ({
		...item,
		outputRelPath: path.posix.join(prefix, item.outputRelPath.replaceAll("\\", "/")),
	}));
}

function plansByTarget() {
	return {
		cc: cc.buildPlan({ substrateRoot, repoRoot: repositoryRoot, packageVersion }),
		"cc-marketplace": cc.buildMarketplacePlan({ substrateRoot }),
		codex: codex.buildPlan({ substrateRoot, repoRoot: repositoryRoot, packageVersion }),
		opencode: [
			...prefixed("agents", opencode.buildAgentPlan({ substrateRoot })),
			...prefixed("skills", opencode.buildSkillPlan({ substrateRoot })),
			...prefixed("instructions", opencode.buildInstructionPlan({ substrateRoot })),
		],
		pi: pi.buildPlan({ repoRoot: repositoryRoot, packageVersion }),
	};
}

function manifestFor(target, items) {
	return manifestFromLegacyPlan({
		target,
		sourceRoot: substrateRoot,
		version: packageVersion,
		items,
	});
}

function waitForExit(child, timeout = 4_000) {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("rendered MCP did not stop")), timeout);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

function rpcClient(child) {
	let nextId = 1;
	let buffer = "";
	const waiting = new Map();
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			const resolve = waiting.get(message.id);
			if (resolve) {
				waiting.delete(message.id);
				resolve(message);
			}
		}
	});
	function send(message) {
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
	}
	return {
		request(method, params) {
			const id = nextId++;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					waiting.delete(id);
					reject(new Error(`MCP ${method} timed out`));
				}, 4_000);
				waiting.set(id, (message) => {
					clearTimeout(timer);
					resolve(message);
				});
				send({ id, method, params });
			});
		},
		notify(method, params = {}) {
			send({ method, params });
		},
	};
}

async function startApiFixture() {
	const requests = [];
	const server = createServer((request, response) => {
		requests.push(`${request.method} ${request.url}`);
		if (request.method === "GET" && request.url === "/api/tickets/GOL-29") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ id: "GOL-29", title: "render closure" }));
			return;
		}
		response.writeHead(404, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: "not found" }));
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert(address && typeof address !== "string", "API fixture must bind an ephemeral loopback port");
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		requests,
		async close() {
			await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		},
	};
}

async function assertRelocatableArtifact(root) {
	const artifact = path.join(repositoryRoot, "packages", "mcp-adapter", "dist", "golem-mcp.mjs");
	assert(existsSync(artifact), "MCP artifact must be built before the isolated journey");
	const render = path.join(root, "render", "mcp");
	mkdirSync(render, { recursive: true });
	copyFileSync(artifact, path.join(render, "golem-mcp.mjs"));
	assert.equal(existsSync(path.join(render, "node_modules")), false, "copied render has no dependency tree");
	assert.equal(
		readFileSync(path.join(render, "golem-mcp.mjs"), "utf8").includes(repositoryRoot),
		false,
		"artifact must not retain a checkout path",
	);

	const api = await startApiFixture();
	let child;
	try {
		child = spawn(process.execPath, ["golem-mcp.mjs"], {
			cwd: render,
			env: {
				PATH: process.env.PATH ?? "",
				GOLEM_CONTROL_PLANE_URL: api.baseUrl,
				NODE_PATH: "",
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		const client = rpcClient(child);
		const initialized = await client.request("initialize", {
			protocolVersion: "2025-03-26",
			capabilities: {},
			clientInfo: { name: "render-closure", version: "1" },
		});
		assert.equal(initialized.result?.serverInfo?.name, "golem", JSON.stringify(initialized));
		client.notify("notifications/initialized");
		const listed = await client.request("tools/list", {});
		const names = listed.result?.tools?.map((tool) => tool.name).sort();
		assert.deepEqual(names, [...legacyToolNames].sort(), "artifact retains every public legacy tool name");
		const read = await client.request("tools/call", { name: "ticket_get", arguments: { id: "GOL-29" } });
		assert.equal(read.result?.isError, undefined, JSON.stringify(read));
		assert.match(read.result?.content?.[0]?.text ?? "", /render closure/);
		const invalidWrite = await client.request("tools/call", { name: "ticket_create", arguments: {} });
		assert.equal(invalidWrite.result?.isError, true, JSON.stringify(invalidWrite));
		assert.equal(api.requests.includes("POST /api/tickets"), false, "invalid writes stop at the MCP schema boundary");
		assert.deepEqual(api.requests, ["GET /api/tickets/GOL-29"]);
		child.kill("SIGTERM");
		await waitForExit(child);
	} finally {
		if (child && child.exitCode === null) {
			child.kill("SIGKILL");
			await waitForExit(child).catch(() => {});
		}
		await api.close();
	}
}

export async function exerciseRenderMcpClosure() {
	const root = mkdtempSync(path.join(os.tmpdir(), "golem-render-mcp-"));
	try {
		const plans = plansByTarget();
		const manifests = new Map();
		for (const target of renderTargets) {
			const manifest = manifestFor(target, plans[target]);
			const relocated = createRenderManifest({
				...manifest,
				sourceRoot: "/relocated/substrate",
			});
			assert.equal(
				manifestSha256(manifest),
				manifestSha256(relocated),
				`${target} hash excludes checkout-specific source location`,
			);
			const outputDir = path.join(root, "targets", target);
			const first = compileRender(manifest, { outputDir });
			const second = compileRender(manifest, { outputDir });
			assert.equal(first.status, "rendered");
			assert.equal(second.status, "rendered");
			assert.equal(first.manifestSha256, second.manifestSha256, `${target} manifest hash is deterministic`);
			assert.equal(first.outputSha256, second.outputSha256, `${target} output hash is deterministic`);
			manifests.set(target, { manifest, outputDir });
		}

		const ccTarget = manifests.get("cc");
		assert(ccTarget, "cc target must be compiled");
		const ccLock = inspectRender(ccTarget.outputDir);
		const regularFile = ccLock?.files.find((file) => !file.managedRegion);
		assert(regularFile, "cc lock must record a non-managed rendered source");
		const tamperedPath = path.join(ccTarget.outputDir, regularFile.outputPath);
		writeFileSync(tamperedPath, "hand edit\n");
		const refused = compileRender(ccTarget.manifest, { outputDir: ccTarget.outputDir });
		assert.equal(refused.status, "refused");
		assert.equal(refused.refusal?.code, "render.tampered");
		assert.equal(readFileSync(tamperedPath, "utf8"), "hand edit\n", "tamper refusal preserves the target");

		const openCodeTarget = manifests.get("opencode");
		assert(openCodeTarget, "opencode target must be compiled");
		const openCodeLock = inspectRender(openCodeTarget.outputDir);
		const managedFile = openCodeLock?.files.find((file) => file.managedRegion);
		assert(managedFile?.managedRegion, "opencode lock must record one managed region");
		const managedPath = path.join(openCodeTarget.outputDir, managedFile.outputPath);
		writeFileSync(
			managedPath,
			`user-prefix\n${readFileSync(managedPath, "utf8")}user-suffix\n`,
		);
		const refreshedOpenCode = createRenderManifest({
			...openCodeTarget.manifest,
			sources: openCodeTarget.manifest.sources.map((source) =>
				source.outputPath === managedFile.outputPath
					? { ...source, contents: `${source.contents}\nmanaged refresh` }
					: source,
			),
		});
		assert.equal(
			compileRender(refreshedOpenCode, { outputDir: openCodeTarget.outputDir }).status,
			"rendered",
			"a valid managed region updates without clobbering user text outside it",
		);
		assert.equal(
			compileRender(refreshedOpenCode, { outputDir: openCodeTarget.outputDir }).status,
			"rendered",
			"managed-region output remains tracked after a refresh",
		);
		const managedOutput = readFileSync(managedPath, "utf8");
		assert.match(managedOutput, /^user-prefix\n/);
		assert.match(managedOutput, /user-suffix\n$/);
		assert.match(managedOutput, /managed refresh\n/);

		const piTarget = manifests.get("pi");
		assert(piTarget, "pi target must be compiled");
		const changed = createRenderManifest({
			...piTarget.manifest,
			version: `${packageVersion}-rollback-probe`,
			sources: piTarget.manifest.sources.map((source, index) =>
				index === 0 ? { ...source, contents: `${source.contents}\nrollback probe\n` } : source,
			),
		});
		const priorLock = inspectRender(piTarget.outputDir);
		assert(priorLock?.files[0], "pi lock must record a prior target");
		const priorBytes = readFileSync(path.join(piTarget.outputDir, priorLock.files[0].outputPath), "utf8");
		await assert.rejects(
			async () => compileRender(changed, { outputDir: piTarget.outputDir, failBeforeSwap: true }),
			/render\.staged_failure/,
		);
		assert.equal(
			readFileSync(path.join(piTarget.outputDir, priorLock.files[0].outputPath), "utf8"),
			priorBytes,
			"staged failure preserves the prior target",
		);

		await assertRelocatableArtifact(root);
		return "typed cc/marketplace/codex/opencode/pi manifests converge byte-for-byte; managed text, tamper refusal, and staged rollback preserve targets; copied MCP artifact initializes, lists, reads, rejects an invalid write, and shuts down without checkout dependencies";
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.stdout.write(`${await exerciseRenderMcpClosure()}\n`);
}
