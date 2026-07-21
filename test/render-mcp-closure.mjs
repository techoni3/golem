import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
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
import {
	invokeMcpTool,
	legacyToolNames,
	toolCatalog,
} from "@golem/mcp-adapter";

import * as cc from "../lib/compiler/adapters/cc.js";
import * as codex from "../lib/compiler/adapters/codex.js";
import * as opencode from "../lib/compiler/adapters/opencode.js";
import * as pi from "../lib/compiler/adapters/pi.js";
import * as typedCompat from "../lib/compiler/typed-compat.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const substrateRoot = path.join(repositoryRoot, "substrate");
const packageVersion = JSON.parse(
	readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
).version;
const compatibilityFixture = JSON.parse(
	readFileSync(
		path.join(repositoryRoot, "test", "fixtures", "mcp-public-compatibility.json"),
		"utf8",
	),
);

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

function pause(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(assertion, description, timeout = 4_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const result = assertion();
		if (result) return result;
		await pause(25);
	}
	throw new Error(`${description} timed out`);
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
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8");
			let body = null;
			try {
				body = text ? JSON.parse(text) : null;
			} catch {
				body = text;
			}
			requests.push({
				method: request.method,
				path: request.url,
				authorization: request.headers.authorization ?? null,
				body,
			});
		if (request.method === "GET" && request.url === "/api/v1/tracker/tickets/GOL-29") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ id: "GOL-29", title: "render closure" }));
			return;
		}
		if (request.method === "POST" && request.url === "/api/v1/tracker/tickets") {
			response.writeHead(201, { "content-type": "application/json" });
			response.end(JSON.stringify({ id: "GOL-900", title: body?.title, project_id: body?.project_id }));
			return;
		}
		response.writeHead(404, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: "not found" }));
		});
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
				GOLEM_CONTROL_PLANE_BEARER: "loopback-bearer-for-j1",
				GOLEM_MCP_CALLER_SESSION_ID: "ses-j1",
				GOLEM_MCP_CALLER_PROJECT_ID: "golem-38ab8a",
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
		const invalidWrite = await client.request("tools/call", { name: "ticket_dispatch", arguments: {} });
		assert.equal(invalidWrite.result?.isError, true, JSON.stringify(invalidWrite));
		assert.equal(api.requests.some((request) => request.path === "/api/tickets/GOL-29/dispatch"), false, "invalid writes stop at the MCP schema boundary");
		const write = await client.request("tools/call", {
			name: "ticket_create",
			arguments: { title: "real closure write", project: "golem-38ab8a" },
		});
		assert.equal(write.result?.isError, undefined, JSON.stringify(write));
		assert.match(write.result?.content?.[0]?.text ?? "", /real closure write/);
		assert.deepEqual(
			api.requests.map((request) => ({ method: request.method, path: request.path })),
			[
				{ method: "GET", path: "/api/v1/tracker/tickets/GOL-29" },
				{ method: "POST", path: "/api/v1/tracker/tickets" },
			],
		);
		assert.deepEqual(api.requests[1]?.body, {
			title: "real closure write",
			project_id: "golem-38ab8a",
		});
		assert(api.requests.every((request) => request.authorization === "Bearer loopback-bearer-for-j1"), "artifact injects the loopback bearer on every request");
		assert.equal(JSON.stringify([initialized, listed, read, invalidWrite, write]).includes("loopback-bearer-for-j1"), false, "MCP summaries never serialize bearer credentials");
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

function assertPackedSyncTargets(root) {
	const packDir = path.join(root, "packed-release");
	const extractDir = path.join(root, "packed-extract");
	const installPrefix = path.join(root, "packed-install");
	mkdirSync(packDir, { recursive: true });
	execFileSync("npm", ["pack", "--pack-destination", packDir, "--silent"], {
		cwd: repositoryRoot,
		env: { ...process.env, npm_config_cache: path.join(root, "npm-cache") },
		encoding: "utf8",
	});
	const tarball = readdirSync(packDir).find((entry) => entry.endsWith(".tgz"));
	assert(tarball, "J1 produced one packaged release tarball");
	mkdirSync(extractDir, { recursive: true });
	execFileSync("tar", ["-xzf", path.join(packDir, tarball), "-C", extractDir], {
		encoding: "utf8",
	});
	const packedRoot = path.join(extractDir, "package");
	const packedChannel = path.join(packedRoot, "mcp", "channel");
	assert(existsSync(path.join(packedChannel, "index.js")), "packed release retains the current channel entrypoint");
	assert(existsSync(path.join(packedChannel, "package-lock.json")), "packed release retains the current channel lock");
	assert(existsSync(path.join(packedRoot, "packages", "mcp-adapter", "dist", "golem-mcp.mjs")), "packed release also carries the relocatable artifact candidate");
	assert.equal(existsSync(path.join(packedRoot, "node_modules")), false, "packed release has no bundled dependency tree");

	// The shipped CLI must resolve only through a real package install. In
	// particular, do not symlink the checkout's root node_modules into the
	// unpacked tarball: that masks an omitted production dependency.
	execFileSync("npm", ["install", "--prefix", installPrefix, "--omit=dev", path.join(packDir, tarball), "--silent"], {
		cwd: root,
		env: {
			...process.env,
			npm_config_cache: path.join(root, "packed-install-npm-cache"),
			NODE_PATH: "",
		},
		encoding: "utf8",
	});
	const installedRoot = path.join(installPrefix, "node_modules", "@laveesingh", "golem");
	const installedCli = path.join(installedRoot, "cli", "golem.js");
	const installedChannel = path.join(installedRoot, "mcp", "channel");
	assert(existsSync(installedCli), "fresh install exposes the shipped CLI");
	assert.equal(readFileSync(installedCli, "utf8").includes(repositoryRoot), false, "installed CLI does not embed a checkout path");
	assert(existsSync(path.join(installPrefix, "node_modules", "gray-matter")), "fresh install resolves declared root production dependencies");
	assert(existsSync(path.join(installedChannel, "node_modules", "@modelcontextprotocol", "sdk")), "installed postinstall restores the nested channel closure");

	const home = path.join(root, "packed-home");
	const xdg = path.join(root, "packed-xdg");
	const userHome = path.join(root, "packed-user-home");
	mkdirSync(home, { recursive: true });
	mkdirSync(xdg, { recursive: true });
	mkdirSync(userHome, { recursive: true });
	writeFileSync(path.join(home, "config.json"), `${JSON.stringify({ harnesses: { opencode: { enabled: true } } }, null, 2)}\n`);
	const installedEnv = { ...process.env, GOLEM_HOME: home, HOME: userHome, XDG_CONFIG_HOME: xdg, NODE_PATH: "" };
	const invokeInstalled = (args) => execFileSync(process.execPath, [installedCli, ...args], {
		cwd: installedRoot,
		env: installedEnv,
		encoding: "utf8",
	});
	const lockFor = () => JSON.parse(readFileSync(path.join(home, "substrate.lock"), "utf8"));
	const assertTargetLock = (target, outputDir) => {
		const entry = lockFor().targets?.[`${target}::${outputDir}`];
		assert(entry?.files && Object.keys(entry.files).length > 0, `${target} records a concrete output lock`);
	};
	const outputs = {
		cc: path.join(home, "renders", "cc-plugin"),
		"cc-marketplace": path.join(home, "renders", "cc-marketplace"),
		codex: path.join(home, "renders", "codex"),
		pi: path.join(home, "renders", "pi"),
	};
	for (const [target, outputDir] of Object.entries(outputs)) {
		const output = invokeInstalled(["sync", "--target", target, "--out", outputDir]);
		assert.match(output, new RegExp(`golem sync --target ${target}`), `${target} installed CLI reports a real sync`);
		assertTargetLock(target, outputDir);
	}
	assert(existsSync(path.join(outputs.cc, "README.md")), "cc creates its concrete plugin output");
	assert(existsSync(path.join(outputs["cc-marketplace"], ".claude-plugin", "marketplace.json")), "cc-marketplace creates its concrete marketplace output");
	assert(existsSync(path.join(outputs.codex, "plugins", "golem", ".codex-plugin", "plugin.json")), "codex creates its concrete plugin output");
	assert(existsSync(path.join(outputs.pi, "golem.ts")), "pi creates its concrete extension output");
	for (const target of ["cc", "codex"]) {
		const pluginRoot = target === "codex" ? path.join(outputs.codex, "plugins", "golem") : outputs.cc;
		assert(existsSync(path.join(pluginRoot, "mcp", "channel", "index.js")), `${target} sync retains the legacy channel entrypoint`);
		assert(existsSync(path.join(pluginRoot, "mcp", "channel", "node_modules", "@modelcontextprotocol", "sdk")), `${target} sync retains the nested channel closure`);
		assert(existsSync(path.join(pluginRoot, "mcp", "golem-mcp.mjs")), `${target} sync carries the relocatable artifact candidate`);
		assert.match(readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8"), /mcp\/channel\/index\.js/);
	}

	const opencodeOutput = invokeInstalled(["sync", "--target", "opencode"]);
	assert.doesNotMatch(opencodeOutput, /harness is disabled/, "temporary config enables opencode for the packed matrix");
	const opencodeAgents = path.join(xdg, "opencode", "agent");
	const opencodeSkills = path.join(home, "renders", "opencode", "skills");
	assert(existsSync(path.join(opencodeAgents, "worker.md")), "opencode creates its concrete agent output");
	assert(existsSync(path.join(opencodeSkills, "building", "SKILL.md")), "opencode creates its concrete skills output");
	assert(existsSync(path.join(xdg, "opencode", "opencode.jsonc")), "opencode creates its managed config output");
	assertTargetLock("opencode", opencodeAgents);
	assertTargetLock("opencode", opencodeSkills);
	assertTargetLock("opencode-instructions", xdg);

	const ccOutput = outputs.cc;
	const packedOwner = path.join(ccOutput, "owner-preserved-by-cli-force.txt");
	writeFileSync(packedOwner, "unowned packed force bytes\n");
	writeFileSync(path.join(ccOutput, "README.md"), "tampered packed README\n");
	invokeInstalled(["sync", "--target", "cc", "--out", ccOutput, "--force"]);
	assert.equal(readFileSync(packedOwner, "utf8"), "unowned packed force bytes\n", "packed CLI --force repairs only owned bytes");
	return { ccOutput, home };
}

async function assertPackedLegacyChannel({ ccOutput, home }) {
	const sessionId = "packed-j1-session";
	const channelHome = path.join(home, "legacy-channel-home");
	let child;
	try {
		child = spawn(process.execPath, ["mcp/channel/index.js"], {
			cwd: ccOutput,
			env: {
				PATH: process.env.PATH ?? "",
				GOLEM_HOME: channelHome,
				GOLEM_CEO_SESSION_ID: sessionId,
				GOLEM_CHANNEL_PORT: "0",
				NODE_PATH: path.join(ccOutput, "mcp", "channel", "node_modules"),
				ANTHROPIC_BASE_URL: "https://api.anthropic.com",
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		const client = rpcClient(child);
		const initialized = await client.request("initialize", {
			protocolVersion: "2025-03-26",
			capabilities: {},
			clientInfo: { name: "packed-legacy-channel", version: "1" },
		});
		assert.equal(initialized.result?.serverInfo?.name, "golem", JSON.stringify(initialized));
		client.notify("notifications/initialized");
		const channel = await waitFor(() => {
			try {
				return JSON.parse(readFileSync(path.join(channelHome, "channels.json"), "utf8")).channels.find(
					(entry) => entry.session_id === sessionId && entry.host && entry.port,
				);
			} catch {
				return undefined;
			}
		}, "packed legacy channel registration");
		const lease = JSON.parse(readFileSync(path.join(channelHome, "endpoint-leases.json"), "utf8")).leases.find(
			(entry) => entry.canonical_id === sessionId,
		);
		assert(lease?.owner_token, "packed legacy channel records an owned endpoint lease");
		const health = await fetch(
			`http://${channel.host}:${channel.port}/healthz?${new URLSearchParams({ session_id: sessionId, owner_token: lease.owner_token })}`,
		);
		assert.equal(health.status, 200, "packed legacy channel serves its identity-bound health route");
		child.kill("SIGTERM");
		await waitForExit(child);
		await waitFor(() => {
			try {
				return !JSON.parse(readFileSync(path.join(channelHome, "channels.json"), "utf8")).channels.some(
					(entry) => entry.session_id === sessionId,
				);
			} catch {
				return true;
			}
		}, "packed legacy channel removal");
	} finally {
		if (child && child.exitCode === null) {
			child.kill("SIGKILL");
			await waitForExit(child).catch(() => {});
		}
	}
}

function errorCode(result) {
	return JSON.parse(result.content[0].text).code;
}

async function assertCatalogContracts() {
	assert.deepEqual(toolCatalog.map((tool) => tool.name).sort(), [...legacyToolNames].sort());
	assert.equal(compatibilityFixture.length, legacyToolNames.length, "retained compatibility fixture covers all public tools");
	const caller = { sessionId: "ses-j1", projectId: "golem-38ab8a" };
	const calls = [];
	const client = {
		caller,
		async request(request) {
			calls.push(request);
			return { status: 200, body: { route: request.path, ok: true } };
		},
	};
	for (const expected of compatibilityFixture) {
		const tool = toolCatalog.find((candidate) => candidate.name === expected.name);
		assert(tool, `retained tool ${expected.name} exists`);
		assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} input is closed`);
		assert.equal(typeof tool.resultSchema, "object", `${tool.name} has a GOL-26 result schema`);
		assert.equal(typeof tool.errorSchema, "object", `${tool.name} has a GOL-26 error schema`);
		assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), [...expected.properties].sort(), `${expected.name} properties match the retained public schema`);
		assert.deepEqual(tool.inputSchema.required ?? [], expected.required, `${expected.name} required fields match the retained public schema`);
		assert.equal(tool.schema.safeParse(expected.valid).success, true, `${expected.name} accepts its public/defaulted probe`);
		assert.equal(tool.schema.safeParse(expected.spoof).success, false, `${expected.name} rejects model-supplied trusted identity`);
		const before = calls.length;
		const result = await invokeMcpTool(client, expected.name, expected.valid);
		assert.equal(result.isError, undefined, `${expected.name} maps a successful API result`);
		assert.equal(calls.length, before + 1, `${expected.name} delegates only after validation`);
		assert.deepEqual(calls.at(-1), expected.request, `${expected.name} route/body/defaults use trusted API-port context`);
		const rejected = await invokeMcpTool(
			{ caller, async request() { return { status: 403, body: { error: "rejected" } }; } },
			expected.name,
			expected.valid,
		);
		assert.equal(errorCode(rejected), "mcp.api.rejected", `${expected.name} maps a rejected API response stably`);
	}
	const dispatchCalls = [];
	const invalid = await invokeMcpTool(
		{ caller, async request(request) { dispatchCalls.push(request); return { status: 200, body: {} }; } },
		"ticket_dispatch",
		{},
	);
	assert.equal(errorCode(invalid), "mcp.input.invalid", "dispatch rejects invalid writes before HTTP");
	assert.equal(dispatchCalls.length, 0, "invalid public writes never reach the API port");
}

function assertRefusalPreservesTarget(root, manifest, name, lockContents) {
	const outputDir = path.join(root, "lock-refusals", name);
	mkdirSync(outputDir, { recursive: true });
	const owner = path.join(outputDir, "owner-bytes.txt");
	writeFileSync(owner, `owner bytes for ${name}\n`);
	if (lockContents !== undefined) writeFileSync(path.join(outputDir, ".golem-render-lock.json"), lockContents);
	const receipt = compileRender(manifest, { outputDir });
	assert.equal(receipt.status, "refused", `${name} target is never treated as fresh`);
	assert.equal(readFileSync(owner, "utf8"), `owner bytes for ${name}\n`, `${name} refusal leaves owner bytes untouched`);
}

export async function exerciseRenderMcpClosure(target) {
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
		if (target === "codex") {
			const codexTarget = manifests.get("codex");
			assert(codexTarget, "codex target must be compiled");
			const codexRoot = path.join(codexTarget.outputDir, "plugins", "golem");
			assert(existsSync(path.join(codexRoot, ".codex-plugin", "plugin.json")), "targeted Codex render has a plugin manifest");
			assert(existsSync(path.join(codexRoot, "hooks", "direct-lifecycle.mjs")), "targeted Codex render carries the lifecycle codec");
			assert.deepEqual(JSON.parse(readFileSync(path.join(codexRoot, "capabilities.json"), "utf8")), {
				schema: 1,
				harness: "codex",
				tier: "B",
				lifecycle: true,
				mcp: true,
				subagents: true,
				delivery: ["pull"],
				push_delivery: false,
				control: false,
				discovery: true,
				readiness: "pull_only",
				delivery_qualification: "unproven",
				limitation: "Ordinary Codex CLI exposes no documented out-of-band turn injection or queued-message pickup API; work must be pulled with Golem MCP tools.",
			}, "targeted Codex capability truth is explicit and stable");
			for (const file of codexTarget.manifest.sources) {
				assert.doesNotMatch(file.contents, new RegExp(repositoryRoot.replaceAll("/", "[\\\\/]")), `Codex render source ${file.outputPath} is checkout-independent`);
			}
			const codexLock = inspectRender(codexTarget.outputDir);
			const codexFile = codexLock?.files.find((file) => !file.managedRegion);
			assert(codexFile, "Codex lock records an owned source for tamper recovery");
			const codexTamperedPath = path.join(codexTarget.outputDir, codexFile.outputPath);
			const codexOwnerPath = path.join(codexTarget.outputDir, "owner-preserved-by-force.txt");
			writeFileSync(codexOwnerPath, "unowned Codex force bytes\n");
			writeFileSync(codexTamperedPath, "hand edit\n");
			const refused = compileRender(codexTarget.manifest, { outputDir: codexTarget.outputDir });
			assert.equal(refused.status, "refused", "Codex tamper is refused without force");
			assert.equal(refused.refusal?.code, "render.tampered");
			assert.equal(readFileSync(codexTamperedPath, "utf8"), "hand edit\n", "Codex tamper refusal preserves user bytes");
			const forced = compileRender(codexTarget.manifest, { outputDir: codexTarget.outputDir, force: true });
			assert.equal(forced.status, "rendered", "Codex force repairs a refused target");
			assert.equal(readFileSync(codexOwnerPath, "utf8"), "unowned Codex force bytes\n", "Codex force retains unowned bytes");
			const priorBytes = readFileSync(codexTamperedPath, "utf8");
			const interrupted = createRenderManifest({
				...codexTarget.manifest,
				sources: codexTarget.manifest.sources.map((source, index) =>
					index === 0 ? { ...source, contents: `${source.contents}\nCodex rollback probe\n` } : source,
				),
			});
			await assert.rejects(
				async () => compileRender(interrupted, { outputDir: codexTarget.outputDir, failBeforeSwap: true }),
				/render\.staged_failure/,
			);
			assert.equal(readFileSync(codexTamperedPath, "utf8"), priorBytes, "Codex interrupted swap preserves the prior target");
			return "targeted Codex render is deterministic, checkout-independent, carries the direct lifecycle hook, and exposes pull-only discovery without control readiness";
		}
		const packed = assertPackedSyncTargets(root);
		await assertPackedLegacyChannel(packed);
		const compatibilityOut = path.join(root, "compatibility-cc");
		const compatibility = typedCompat.render({ target: "cc", outDir: compatibilityOut, items: plans.cc, packageVersion });
		assert.equal(compatibility.tampered.length, 0, "public sync compatibility entrypoint delegates to the typed compiler");
		assert.equal(typedCompat.checkDrift({ target: "cc", outDir: compatibilityOut, items: plans.cc, packageVersion }).clean, true, "typed compiler owns production sync check");
		cc.syncMcpChannelDeps({ repoRoot: repositoryRoot, outDir: compatibilityOut });
		assert(existsSync(path.join(compatibilityOut, "mcp", "channel", "index.js")), "typed cc plan preserves the current channel entrypoint");
		assert(existsSync(path.join(compatibilityOut, "mcp", "channel", "node_modules", "@modelcontextprotocol", "sdk")), "typed cc plan preserves the nested closure");
		assert(existsSync(path.join(compatibilityOut, "mcp", "golem-mcp.mjs")), "typed cc plan carries the relocatable artifact candidate");
		const generatedMcpConfig = readFileSync(path.join(compatibilityOut, ".mcp.json"), "utf8");
		assert.match(generatedMcpConfig, /mcp\/channel\/index\.js/);
		const pluginLock = inspectRender(path.join(repositoryRoot, "plugin"));
		assert(pluginLock, "plugin records generator ownership in a typed render lock");
		if (target !== "codex") {
			assert.equal(pluginLock.manifestSha256, manifestSha256(manifestFor("cc", plans.cc)), "plugin lock matches the typed cc generator manifest");
			for (const file of pluginLock.files) {
				assert.deepEqual(
					readFileSync(path.join(repositoryRoot, "plugin", file.outputPath)),
					readFileSync(path.join(compatibilityOut, file.outputPath)),
					`plugin ${file.outputPath} is compiler round-trip output, not a hand edit`,
				);
			}
		}

		const ccTarget = manifests.get("cc");
		assert(ccTarget, "cc target must be compiled");
		assertRefusalPreservesTarget(root, ccTarget.manifest, "malformed", "{");
		assertRefusalPreservesTarget(root, ccTarget.manifest, "invalid", "{}\n");
		assertRefusalPreservesTarget(root, ccTarget.manifest, "unmanaged");
		if (target !== "codex") await assertCatalogContracts();

		const ccLock = inspectRender(ccTarget.outputDir);
		const regularFile = ccLock?.files.find((file) => !file.managedRegion);
		assert(regularFile, "cc lock must record a non-managed rendered source");
		const tamperedPath = path.join(ccTarget.outputDir, regularFile.outputPath);
		const forceOwnerPath = path.join(ccTarget.outputDir, "owner-preserved-by-force.txt");
		writeFileSync(forceOwnerPath, "unowned force-recovery bytes\n");
		writeFileSync(tamperedPath, "hand edit\n");
		const refused = compileRender(ccTarget.manifest, { outputDir: ccTarget.outputDir });
		assert.equal(refused.status, "refused");
		assert.equal(refused.refusal?.code, "render.tampered");
		assert.equal(readFileSync(tamperedPath, "utf8"), "hand edit\n", "tamper refusal preserves the target");
		const forced = compileRender(ccTarget.manifest, { outputDir: ccTarget.outputDir, force: true });
		assert.equal(forced.status, "rendered", "explicit force repairs a refused managed target");
		assert.equal(readFileSync(forceOwnerPath, "utf8"), "unowned force-recovery bytes\n", "force retains unowned bytes");
		assert(inspectRender(ccTarget.outputDir), "force converges to a valid replacement lock");

		const openCodeTarget = manifests.get("opencode");
		assert(openCodeTarget, "opencode target must be compiled");
		const openCodeLock = inspectRender(openCodeTarget.outputDir);
		const managedFile = openCodeLock?.files.find((file) => file.managedRegion);
		assert(managedFile?.managedRegion, "opencode lock must record one managed region");
		const managedPath = path.join(openCodeTarget.outputDir, managedFile.outputPath);
		const unknownConfig = path.join(openCodeTarget.outputDir, "owner.config.jsonc");
		const unknownBytes = Buffer.from("// user-owned config\n{\"opaque\":\"\u0000\"}\n", "utf8");
		writeFileSync(unknownConfig, unknownBytes);
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
		assert.deepEqual(readFileSync(unknownConfig), unknownBytes, "valid rerender carries unknown owner config bytes through the sibling stage");
		const refreshedLock = inspectRender(openCodeTarget.outputDir);
		const refreshedManaged = refreshedLock?.files.find((file) => file.outputPath === managedFile.outputPath);
		assert(refreshedManaged?.managedRegion);
		const refreshedSource = refreshedOpenCode.sources.find((source) => source.outputPath === managedFile.outputPath);
		assert(refreshedSource);
		const framed = `${refreshedManaged.managedRegion.begin}\n${refreshedSource.contents.endsWith("\n") ? refreshedSource.contents : `${refreshedSource.contents}\n`}${refreshedManaged.managedRegion.end}\n`;
		assert.equal(refreshedManaged.sha256, createHash("sha256").update(framed).digest("hex"), "managed lock hash frames canonical managed bytes");

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

		const recoveryDir = path.join(root, "interrupted-swap");
		assert.equal(compileRender(piTarget.manifest, { outputDir: recoveryDir }).status, "rendered");
		const recoveryPrior = `${recoveryDir}.golem-prior`;
		renameSync(recoveryDir, recoveryPrior);
		writeFileSync(
			`${recoveryDir}.golem-render-swap.json`,
			JSON.stringify({ schemaVersion: "golem.render-swap/v1", state: "prior-moved", manifestSha256: "interrupted" }),
		);
		assert.equal(compileRender(changed, { outputDir: recoveryDir }).status, "rendered", "durable marker restores an interrupted prior target before the next swap");
		assert.equal(existsSync(recoveryPrior), false, "recovery consumes prior only after restoring or completing a marked swap");

		await assertRelocatableArtifact(root);
		return "typed production cc/marketplace/codex/opencode/pi manifests and a freshly installed packed CLI retain the live legacy channel closure while carrying a deferred artifact candidate; an independent retained 22-tool table proves public schemas/routes/defaults and trusted caller injection; normal/force lock recovery preserves owner bytes; the packed channel registers and cleans up its route; and a copied bearer-authenticated artifact initializes, lists, reads, rejects an invalid write, performs a real write, and shuts down without checkout dependencies";
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.stdout.write(`${await exerciseRenderMcpClosure()}\n`);
}
