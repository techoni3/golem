#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "golem-package-"));
const packageDirectory = path.join(temporaryRoot, "pack");
const installDirectory = path.join(temporaryRoot, "install");
const home = path.join(temporaryRoot, "home");
const state = path.join(temporaryRoot, "state");
const cache = path.join(temporaryRoot, "empty-cache");
const npmExecutable = process.env.npm_execpath;
const checkoutBytes = Buffer.from(repositoryRoot);

function run(file, arguments_, options = {}) {
	return execFileSync(file, arguments_, {
		cwd: options.cwd ?? temporaryRoot,
		env: options.env ?? process.env,
		encoding: "utf8",
		stdio: "pipe",
	});
}

function npm(arguments_, cwd, env) {
	return npmExecutable
		? run(process.execPath, [npmExecutable, ...arguments_], { cwd, env })
		: run("npm", arguments_, { cwd, env });
}

function packageEnvironment() {
	return {
		...process.env,
		HOME: home,
		GOLEM_HOME: state,
		XDG_CONFIG_HOME: path.join(temporaryRoot, "xdg"),
		npm_config_cache: cache,
		NODE_PATH: "",
		PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
	};
}

function listTarball(tarball) {
	return run("tar", ["-tzf", tarball]).trim().split("\n");
}

function assertAllowlist(entries) {
	const allowed = [
		"package/cli/",
		"package/dashboard/dist/",
		"package/dist/release/",
		"package/docs/architecture/",
		"package/docs/contributing/",
		"package/lib/",
		"package/packages/mcp-adapter/dist/golem-mcp.mjs",
		"package/scripts/postinstall-validate.mjs",
		"package/shims/",
		"package/substrate/",
	];
	const rootFiles = new Set([
		"package/CONTRIBUTING.md",
		"package/LICENSE",
		"package/PRIVACY.md",
		"package/README.md",
		"package/SECURITY.md",
		"package/dashboard/README.md",
		"package/docs/release-readiness.md",
		"package/package.json",
	]);
	const unexpected = entries.filter(
		(entry) =>
			entry !== "package/" &&
			!rootFiles.has(entry) &&
			!allowed.some((prefix) => entry.startsWith(prefix)),
	);
	assert.deepEqual(unexpected, [], `unexpected packed files:\n${unexpected.join("\n")}`);
	for (const pattern of [
		/\/node_modules\//u,
		/\/apps\//u,
		/\/tools\//u,
		/\/mcp\/channel\//u,
		/\/plugin\//u,
		/\/dashboard\/(?:server|web)\//u,
		/\.tsx?$/u,
		/(?:playwright|openapi-codegen|openapi-typescript)/iu,
	]) {
		const matches = entries.filter((entry) => pattern.test(entry));
		assert.equal(
			matches.length > 0,
			false,
			`forbidden packed path matched ${pattern}:\n${matches.join("\n")}`,
		);
	}
}

function assertNoCheckoutPath(extractedRoot) {
	const candidates = [
		"cli/golem.js",
		"dist/release/golem-cli.mjs",
		"dist/release/control-plane.mjs",
		"dist/release/legacy-dashboard.mjs",
		"packages/mcp-adapter/dist/golem-mcp.mjs",
	];
	for (const relative of candidates) {
		const bytes = readFileSync(path.join(extractedRoot, relative));
		assert.equal(
			bytes.includes(checkoutBytes),
			false,
			`${relative} retained the checkout path`,
		);
	}
}

function rpcClient(child) {
	let nextId = 0;
	let buffer = "";
	const pending = new Map();
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			const message = JSON.parse(line);
			const waiter = pending.get(message.id);
			if (waiter) {
				pending.delete(message.id);
				waiter.resolve(message);
			}
		}
	});
	return {
		request(method, params) {
			const id = ++nextId;
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			return new Promise((resolve, reject) => {
				const timeout = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`MCP timeout: ${method}`));
				}, 5_000);
				pending.set(id, {
					resolve: (value) => {
						clearTimeout(timeout);
						resolve(value);
					},
				});
			});
		},
		notify(method, params = {}) {
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
		},
	};
}

async function verifyMcp(artifact, env) {
	const child = spawn(process.execPath, [artifact], {
		cwd: path.dirname(artifact),
		env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	try {
		const client = rpcClient(child);
		const initialized = await client.request("initialize", {
			protocolVersion: "2025-03-26",
			capabilities: {},
			clientInfo: { name: "package-verification", version: "1" },
		});
		assert.equal(initialized.result?.serverInfo?.name, "golem");
		client.notify("notifications/initialized");
		const listed = await client.request("tools/list", {});
		assert.ok(listed.result?.tools?.length >= 20, "packed MCP exposes the tracker surface");
	} finally {
		child.kill("SIGTERM");
	}
}

function readyLine(child) {
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(
			() => reject(new Error(`control-plane readiness timeout\n${stderr}`)),
			10_000,
		);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			const line = stdout.split("\n").find((candidate) => candidate.trim());
			if (!line) return;
			clearTimeout(timeout);
			resolve(JSON.parse(line));
		});
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("exit", (code) => {
			if (code === null || stdout.trim()) return;
			clearTimeout(timeout);
			reject(new Error(`control plane exited ${code}\n${stderr}`));
		});
	});
}

async function verifyService(packageRoot, env) {
	const token = "package-verification-loopback-token";
	const child = spawn(
		process.execPath,
		[path.join(packageRoot, "dist", "release", "control-plane.mjs")],
		{
			cwd: installDirectory,
			env: {
				...env,
				GOLEM_CONTROL_PLANE_TOKEN: token,
				GOLEM_CONTROL_PLANE_PORT: "0",
				GOLEM_CONTROL_PLANE_STATIC_ROOT: path.join(
					packageRoot,
					"dashboard",
					"dist",
					"control-plane",
				),
				GOLEM_CLI_ENTRY: path.join(packageRoot, "cli", "golem.js"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	try {
		const ready = await readyLine(child);
		assert.equal(ready.type, "ready");
		const health = await fetch(`${ready.origin}/api/health`);
		assert.equal(health.status, 200);
		const ui = await fetch(`${ready.origin}/`);
		assert.equal(ui.status, 200);
		assert.match(await ui.text(), /<div id="root">/u);
		return ready.origin;
	} finally {
		child.kill("SIGTERM");
		await new Promise((resolve) => child.once("exit", resolve));
	}
}

function verifySqlite(installedRequire) {
	const Database = installedRequire("better-sqlite3");
	const databasePath = path.join(state, "native-proof.db");
	mkdirSync(state, { recursive: true });
	let database = new Database(databasePath);
	const journal = database.pragma("journal_mode = WAL", { simple: true });
	assert.equal(String(journal).toLowerCase(), "wal");
	database.exec("create table proof(value text not null); insert into proof values ('durable')");
	const versions = database
		.prepare("select sqlite_version() as sqlite_version")
		.get();
	database.close();
	database = new Database(databasePath);
	assert.equal(database.prepare("select count(*) as count from proof").get().count, 1);
	assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
	database.close();
	return {
		addon: installedRequire("better-sqlite3/package.json").version,
		sqlite: versions.sqlite_version,
		node: process.version,
		abi: process.versions.modules,
		platform: `${process.platform}/${process.arch}`,
	};
}

try {
	mkdirSync(packageDirectory, { recursive: true });
	mkdirSync(installDirectory, { recursive: true });
	mkdirSync(home, { recursive: true });
	mkdirSync(cache, { recursive: true });
	const env = packageEnvironment();
	const suppliedTarball = process.env.GOLEM_PACKAGE_TARBALL
		? path.resolve(process.env.GOLEM_PACKAGE_TARBALL)
		: undefined;
	const tarballName = suppliedTarball
		? path.basename(suppliedTarball)
		: npm(
				["pack", "--silent", "--pack-destination", packageDirectory],
				repositoryRoot,
				env,
			)
				.trim()
				.split("\n")
				.at(-1);
	const tarball = suppliedTarball ?? path.join(packageDirectory, tarballName);
	assert.ok(existsSync(tarball), `package tarball does not exist: ${tarball}`);
	const entries = listTarball(tarball);
	assertAllowlist(entries);

	const extracted = path.join(temporaryRoot, "extracted");
	mkdirSync(extracted, { recursive: true });
	run("tar", ["-xzf", tarball, "-C", extracted]);
	assertNoCheckoutPath(path.join(extracted, "package"));

	npm(["init", "-y"], installDirectory, env);
	const installOutput = npm(
		[
			"install",
			"--omit=dev",
			"--foreground-scripts",
			"--no-audit",
			"--no-fund",
			tarball,
		],
		installDirectory,
		env,
	);
	assert.match(installOutput, /service remains stopped/u);
	assert.equal(existsSync(state), false, "postinstall must not create GOLEM_HOME");

	const installedRequire = createRequire(path.join(installDirectory, "package.json"));
	const packageRoot = path.resolve(
		path.dirname(installedRequire.resolve("@laveesingh/golem")),
		"..",
	);
	assert.notEqual(packageRoot, repositoryRoot);
	const installedPackage = JSON.parse(
		readFileSync(path.join(packageRoot, "package.json"), "utf8"),
	);
	assert.equal(installedPackage.dependencies["better-sqlite3"], "12.11.1");
	assert.equal(existsSync(path.join(packageRoot, "tools")), false);
	assert.equal(existsSync(path.join(packageRoot, "apps")), false);
	assert.equal(existsSync(path.join(packageRoot, "mcp", "channel")), false);
	assert.equal(
		existsSync(path.join(installDirectory, "node_modules", "typescript")),
		false,
	);
	assert.equal(
		existsSync(path.join(installDirectory, "node_modules", "openapi-typescript")),
		false,
	);

	const cli = path.join(packageRoot, "cli", "golem.js");
	run(process.execPath, [cli, "help"], { cwd: installDirectory, env });
	run(process.execPath, [cli, "completions", "zsh"], {
		cwd: installDirectory,
		env,
	});
	for (const target of ["cc", "cc-marketplace", "codex", "opencode", "pi"]) {
		run(process.execPath, [cli, "sync", "--target", target], {
			cwd: installDirectory,
			env,
		});
	}
	assert.equal(
		existsSync(path.join(state, "renders", "cc-plugin", "mcp", "channel")),
		false,
	);
	const renderedMcp = path.join(
		state,
		"renders",
		"cc-plugin",
		"mcp",
		"golem-mcp.mjs",
	);
	await verifyMcp(renderedMcp, {
		...env,
		GOLEM_CONTROL_PLANE_URL: "http://127.0.0.1:1",
		GOLEM_CONTROL_PLANE_BEARER: "unreachable-package-proof",
	});

	const serviceOrigin = await verifyService(packageRoot, env);
	const native = verifySqlite(installedRequire);
	const sha256 = crypto
		.createHash("sha256")
		.update(readFileSync(tarball))
		.digest("hex");
	writeFileSync(
		path.join(temporaryRoot, "evidence.json"),
		`${JSON.stringify(
			{
				tarball: tarballName,
				sha256,
				files: entries.length,
				packageRoot,
				serviceOrigin,
				native,
			},
			null,
			2,
		)}\n`,
	);
	process.stdout.write(
		`package verification PASS: ${tarballName} ${entries.length} files sha256=${sha256}\n`,
	);
	process.stdout.write(
		`native PASS: better-sqlite3 ${native.addon}, SQLite ${native.sqlite}, ${native.node} ABI ${native.abi} ${native.platform}\n`,
	);
	process.stdout.write("postinstall stopped; checkout-hidden CLI/UI/API/MCP/render PASS\n");
} finally {
	if (!process.env.GOLEM_KEEP_PACKAGE_EVIDENCE)
		rmSync(temporaryRoot, { recursive: true, force: true });
}
