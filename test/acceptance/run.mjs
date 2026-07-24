#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	diagnosticFor,
	exercises,
	isLoopbackUnavailable,
} from "../journeys/exercise.mjs";
import { scenarios } from "../journeys/scenarios.mjs";

const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const evidenceDirectory = path.join(
	repositoryRoot,
	"docs",
	"verification",
	"gol-12",
);
const resultsPath = path.join(evidenceDirectory, "acceptance-results.json");
const matrixPlan = Object.freeze({
	J1: ["install-update-rollback", "dashboard-down-inbox-replay"],
	J2: [
		"cross-harness-session-lifecycle",
		"project-identity-git-worktree-relocation",
	],
	J3: ["materializer-crash-matrix", "codex-managed-delivery-crash-matrix"],
	J4: [
		"claude-lifecycle-channel-recovery",
		"tracker-http-mcp-parity",
		"delivery-api-fence-recheck",
	],
	J5: [
		"compact-launcher-matrix",
		"launcher-launchability-delivery-split",
		"opencode-provider-coexistence",
	],
	J6: [
		"projection-ws-restart-resync",
		"committed-outbox-all-write-paths",
		"roles-gates-ideas-controls",
	],
	J7: ["canonical-cutover-crash-rollback", "migration-apply-crash-rollback"],
	J8: ["dashboard-runtime-lifecycle"],
});

function option(name) {
	const index = process.argv.indexOf(name);
	return index < 0 ? undefined : process.argv[index + 1];
}

const matrixOption = option("--matrix");
const artifactOption = option("--artifact");
assert(matrixOption, "--matrix requires a comma-separated J1-J8 selection");
assert.equal(artifactOption, "packed", "--artifact packed is required");
const requestedMatrices = matrixOption.split(",").filter(Boolean);
assert.deepEqual(
	[...new Set(requestedMatrices)],
	requestedMatrices,
	"matrix ids must be unique",
);
for (const matrix of requestedMatrices)
	assert(matrixPlan[matrix], `unknown acceptance matrix: ${matrix}`);

function renderValue(value) {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function sanitize(value, temporaryRoot) {
	return renderValue(value)
		.replaceAll(repositoryRoot, "<checkout>")
		.replaceAll(temporaryRoot, "<acceptance-home>")
		.replace(
			/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu,
			"<uuid>",
		)
		.replace(/127\.0\.0\.1:\d+/gu, "127.0.0.1:<port>")
		.replace(/\bpid[=:]\s*\d+\b/giu, "pid=<pid>");
}

function run(file, arguments_, options = {}) {
	return execFileSync(file, arguments_, {
		cwd: options.cwd ?? repositoryRoot,
		env: options.env ?? process.env,
		encoding: "utf8",
		stdio: "pipe",
	});
}

function npm(arguments_, options = {}) {
	const executable = process.env.npm_execpath;
	return executable
		? run(process.execPath, [executable, ...arguments_], options)
		: run("npm", arguments_, options);
}

function sha256(file) {
	return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function tarEntries(tarball) {
	return run("tar", ["-tzf", tarball]).trim().split("\n");
}

function selectTarball(temporaryRoot) {
	if (process.env.GOLEM_ACCEPTANCE_TARBALL)
		return path.resolve(process.env.GOLEM_ACCEPTANCE_TARBALL);
	const packDirectory = path.join(temporaryRoot, "pack");
	fs.mkdirSync(packDirectory, { recursive: true });
	const filename = npm(
		["pack", "--ignore-scripts", "--silent", "--pack-destination", packDirectory],
	).trim();
	return path.join(packDirectory, filename.split("\n").at(-1));
}

function verifyTopology() {
	const topology = npm([
		"ls",
		"typescript",
		"openapi-typescript",
		"openapi-fetch",
		"better-sqlite3",
		"--all",
	]);
	for (const expected of [
		"typescript@7.0.2",
		"typescript@5.9.3",
		"openapi-typescript@7.13.0",
		"openapi-fetch@0.17.0",
		"better-sqlite3@12.11.1",
	])
		assert(topology.includes(expected), `development topology omits ${expected}`);
	assert.doesNotMatch(topology, /\binvalid\b|\bUNMET\b/iu);
	npm(["run", "api:check"]);
	npm(["run", "docs:check"]);
	return {
		status: "PASS",
		typescript: {
			root: "7.0.2",
			codegen: "5.9.3",
			openapi_typescript: "7.13.0",
		},
		openapi_fetch: "0.17.0",
		better_sqlite3: "12.11.1",
		api_check: "PASS",
		docs_check: "PASS",
	};
}

function verifyPackedArtifact(tarball, temporaryRoot) {
	assert(fs.existsSync(tarball), `packed artifact does not exist: ${tarball}`);
	const entries = tarEntries(tarball);
	for (const required of [
		"package/dist/release/golem-cli.mjs",
		"package/dist/release/control-plane.mjs",
		"package/dashboard/dist/control-plane/index.html",
		"package/packages/mcp-adapter/dist/golem-mcp.mjs",
	])
		assert(entries.includes(required), `packed artifact omits ${required}`);
	for (const forbidden of [
		/\/node_modules\//u,
		/\/apps\//u,
		/\/tools\//u,
		/\/mcp\/channel\//u,
		/\/plugin\//u,
		/\.tsx?$/u,
		/(?:playwright|openapi-typescript)/iu,
	])
		assert.equal(
			entries.some((entry) => forbidden.test(entry)),
			false,
			`packed artifact contains forbidden ${forbidden}`,
		);

	const installDirectory = path.join(temporaryRoot, "install");
	const state = path.join(temporaryRoot, "state");
	const home = path.join(temporaryRoot, "home");
	const environment = {
		...process.env,
		GOLEM_HOME: state,
		HOME: home,
		NODE_PATH: "",
		PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
		XDG_CONFIG_HOME: path.join(temporaryRoot, "xdg"),
		npm_config_cache: path.join(temporaryRoot, "empty-cache"),
	};
	fs.mkdirSync(installDirectory, { recursive: true });
	fs.mkdirSync(home, { recursive: true });
	npm(["init", "-y"], { cwd: installDirectory, env: environment });
	const installOutput = npm(
		[
			"install",
			"--omit=dev",
			"--foreground-scripts",
			"--no-audit",
			"--no-fund",
			tarball,
		],
		{ cwd: installDirectory, env: environment },
	);
	assert.match(installOutput, /service remains stopped/u);
	assert.doesNotMatch(installOutput, /ERESOLVE|legacy-peer-deps|peer conflict/iu);

	const installedRequire = createRequire(
		path.join(installDirectory, "package.json"),
	);
	const packageRoot = path.resolve(
		path.dirname(installedRequire.resolve("@laveesingh/golem")),
		"..",
	);
	const packageDocument = JSON.parse(
		fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
	);
	assert.notEqual(packageRoot, repositoryRoot);
	for (const absent of [
		"apps",
		"tools",
		"node_modules/typescript",
		"node_modules/openapi-typescript",
	])
		assert.equal(fs.existsSync(path.join(packageRoot, absent)), false);
	assert.equal(
		fs
			.readFileSync(path.join(packageRoot, "dist", "release", "golem-cli.mjs"))
			.includes(Buffer.from(repositoryRoot)),
		false,
	);
	assert.equal(
		installedRequire("openapi-fetch/package.json").version,
		"0.17.0",
	);

	const cli = path.join(packageRoot, "cli", "golem.js");
	run(process.execPath, [cli, "help"], {
		cwd: installDirectory,
		env: environment,
	});
	run(process.execPath, [cli, "completions", "zsh"], {
		cwd: installDirectory,
		env: environment,
	});
	fs.mkdirSync(state, { recursive: true });
	fs.writeFileSync(
		path.join(state, "config.json"),
		`${JSON.stringify({ harnesses: { opencode: { enabled: true } } }, null, 2)}\n`,
	);
	for (const target of ["cc", "cc-marketplace", "codex", "opencode", "pi"])
		run(process.execPath, [cli, "sync", "--target", target], {
			cwd: installDirectory,
			env: environment,
		});

	const Database = installedRequire("better-sqlite3");
	const databasePath = path.join(state, "acceptance.db");
	let database = new Database(databasePath);
	assert.equal(database.pragma("journal_mode = WAL", { simple: true }), "wal");
	database.exec(
		"create table durable(value text not null); insert into durable values ('accepted')",
	);
	database.close();
	database = new Database(databasePath);
	assert.equal(
		database.prepare("select value from durable").pluck().get(),
		"accepted",
	);
	assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
	const sqliteVersion = database
		.prepare("select sqlite_version()")
		.pluck()
		.get();
	database.close();

	return {
		artifact: {
			kind: "packed",
			filename: path.basename(tarball),
			sha256: sha256(tarball),
			files: entries.length,
			package: packageDocument.name,
			version: packageDocument.version,
		},
		entry: {
			status: "PASS",
			checkout_hidden: true,
			postinstall_stopped: true,
			render_targets: ["cc", "cc-marketplace", "codex", "opencode", "pi"],
			node: process.version,
			npm: npm(["--version"]).trim(),
			abi: process.versions.modules,
			platform: `${process.platform}/${process.arch}`,
			better_sqlite3: installedRequire("better-sqlite3/package.json").version,
			sqlite: sqliteVersion,
			openapi_fetch: "0.17.0",
			wal_restart_integrity: "PASS",
			install_flags: ["--omit=dev", "--foreground-scripts", "--no-audit", "--no-fund"],
		},
		packageRoot,
	};
}

const catalog = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
const temporaryRoot = fs.mkdtempSync(
	path.join(os.tmpdir(), "golem-acceptance-"),
);
let result;
try {
	const topology = verifyTopology();
	const tarball = selectTarball(temporaryRoot);
	const packed = verifyPackedArtifact(tarball, temporaryRoot);
	process.env.GOLEM_ACCEPTANCE_TARBALL = tarball;
	process.env.GOLEM_ACCEPTANCE_PACKAGE_ROOT = packed.packageRoot;
	process.stdout.write(
		`ENTRY PASS packed ${packed.artifact.filename} ${packed.artifact.files} files sha256=${packed.artifact.sha256}\n`,
	);

	const matrices = [];
	for (const matrixId of requestedMatrices) {
		const scenarioResults = [];
		for (const scenarioId of matrixPlan[matrixId]) {
			const scenario = catalog.get(scenarioId);
			const exercise = exercises[scenarioId];
			assert(scenario, `scenario catalog omits ${scenarioId}`);
			assert(exercise, `scenario exercise omits ${scenarioId}`);
			process.stdout.write(`RUN ${matrixId} ${scenarioId}\n`);
			try {
				const evidence = await exercise();
				scenarioResults.push({
					id: scenarioId,
					status: "PASS",
					regression: scenario.regression,
					evidence: sanitize(evidence, temporaryRoot),
				});
				process.stdout.write(`PASS ${matrixId} ${scenarioId}\n`);
			} catch (error) {
				const unmet = isLoopbackUnavailable(error);
				const status = unmet ? "UNMET" : "FAIL";
				scenarioResults.push({
					id: scenarioId,
					status,
					regression: scenario.regression,
					evidence: sanitize(
						unmet
							? "sandbox rejected the required real loopback boundary"
							: diagnosticFor(error),
						temporaryRoot,
					),
				});
				process.stdout.write(`${status} ${matrixId} ${scenarioId}\n`);
			}
		}
		const status = scenarioResults.some(({ status }) => status === "FAIL")
			? "FAIL"
			: scenarioResults.some(({ status }) => status === "UNMET")
				? "UNMET"
				: "PASS";
		matrices.push({ id: matrixId, status, scenarios: scenarioResults });
	}
	const overall = matrices.some(({ status }) => status === "FAIL")
		? "FAIL"
		: matrices.some(({ status }) => status === "UNMET")
			? "UNMET"
			: "PASS";
	result = {
		schema_version: "golem.acceptance/v1",
		overall,
		artifact: packed.artifact,
		entry_gate: { ...packed.entry, topology },
		matrices,
		residual_risks: [
			{
				id: "air-gapped-native",
				blocking: false,
				disposition:
					"Unsupported unless the correct native prebuild or cached compiler toolchain is present.",
			},
			{
				id: "external-credential-qualification",
				blocking: false,
				disposition:
					"No credentialed capability is fabricated; absent binaries, models, daemons, or consumption evidence remain unavailable or pull-only/not-ready before spawn.",
			},
			{
				id: "x64-host",
				blocking: false,
				disposition:
					"The same candidate has real x64 Node/addon/SQLite evidence under Rosetta; an independent physical x64 runner remains release-infrastructure hardening.",
			},
		],
	};
} catch (error) {
	result = {
		schema_version: "golem.acceptance/v1",
		overall: "FAIL",
		artifact: {
			kind: "packed",
			filename: path.basename(
				process.env.GOLEM_ACCEPTANCE_TARBALL ?? "unresolved.tgz",
			),
			sha256: "0".repeat(64),
			files: 0,
			package: "@laveesingh/golem",
			version: "unresolved",
		},
		entry_gate: {
			status: "FAIL",
			diagnostic: sanitize(error?.stack ?? error, temporaryRoot),
		},
		matrices: [],
		residual_risks: [],
	};
} finally {
	fs.mkdirSync(evidenceDirectory, { recursive: true });
	fs.writeFileSync(resultsPath, `${JSON.stringify(result, null, 2)}\n`);
	fs.rmSync(temporaryRoot, { force: true, recursive: true });
}

process.stdout.write(
	`acceptance ${result.overall}: ${result.matrices.length} matrices; evidence docs/verification/gol-12/acceptance-results.json\n`,
);
process.exitCode =
	result.overall === "PASS" ? 0 : result.overall === "UNMET" ? 2 : 1;
