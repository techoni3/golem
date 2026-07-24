import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import {
	appendFileSync,
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
	"../..",
);

function run(file, arguments_, cwd, env, allowFailure = false) {
	try {
		return {
			status: 0,
			stdout: execFileSync(file, arguments_, {
				cwd,
				env,
				encoding: "utf8",
				stdio: "pipe",
			}),
		};
	} catch (error) {
		if (!allowFailure) throw error;
		return {
			status: error.status ?? 1,
			stdout: `${error.stdout ?? ""}${error.stderr ?? ""}`,
		};
	}
}

function npm(arguments_, cwd, env, allowFailure = false) {
	const npmExecutable = process.env.npm_execpath;
	return npmExecutable
		? run(
				process.execPath,
				[npmExecutable, ...arguments_],
				cwd,
				env,
				allowFailure,
			)
		: run("npm", arguments_, cwd, env, allowFailure);
}

function installedRoot(directory) {
	const require = createRequire(path.join(directory, "package.json"));
	return {
		require,
		root: path.resolve(
			path.dirname(require.resolve("@laveesingh/golem")),
			"..",
		),
	};
}

function installedVersion(directory) {
	const installed = installedRoot(directory);
	return JSON.parse(
		readFileSync(path.join(installed.root, "package.json"), "utf8"),
	).version;
}

export async function exerciseInstallUpdateRollback() {
	const root = mkdtempSync(path.join(os.tmpdir(), "golem-update-rollback-"));
	const packDirectory = path.join(root, "pack");
	const installDirectory = path.join(root, "install");
	const home = path.join(root, "home");
	const state = path.join(root, "state");
	const cache = path.join(root, "cache");
	const extractDirectory = path.join(root, "next");
	const environment = {
		...process.env,
		HOME: home,
		GOLEM_HOME: state,
		XDG_CONFIG_HOME: path.join(root, "xdg"),
		npm_config_cache: cache,
		NODE_PATH: "",
		COPYFILE_DISABLE: "1",
		PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
	};
	try {
		for (const directory of [
			packDirectory,
			installDirectory,
			home,
			cache,
			extractDirectory,
		])
			mkdirSync(directory, { recursive: true });
		const originalName = npm(
			["pack", "--silent", "--pack-destination", packDirectory],
			repositoryRoot,
			environment,
		).stdout
			.trim()
			.split("\n")
			.at(-1);
		const original = path.join(packDirectory, originalName);
		npm(["init", "-y"], installDirectory, environment);
		npm(
			[
				"install",
				"--omit=dev",
				"--foreground-scripts",
				"--no-audit",
				"--no-fund",
				original,
			],
			installDirectory,
			environment,
		);
		const first = installedVersion(installDirectory);
		const installed = installedRoot(installDirectory);
		const cli = path.join(installed.root, "cli", "golem.js");
		run(process.execPath, [cli, "sync", "--target", "cc"], installDirectory, environment);

		const userFile = path.join(state, "user-owned.json");
		mkdirSync(state, { recursive: true });
		writeFileSync(userFile, '{"unknown_key":"preserve-me"}\n');
		const instructions = path.join(home, ".claude", "CLAUDE.md");
		appendFileSync(instructions, "\nUSER REGION MUST SURVIVE\n");
		const plist = path.join(state, "dev.golem.control-plane.plist");
		writeFileSync(plist, "<plist>user-retained-service-definition</plist>\n");

		const Database = installed.require("better-sqlite3");
		const databasePath = path.join(state, "canonical.db");
		let database = new Database(databasePath);
		database.pragma("journal_mode = WAL");
		database.exec(
			"create table durable(value text not null); insert into durable values ('preserved')",
		);
		database.close();

		run("tar", ["-xzf", original, "-C", extractDirectory], root, environment);
		const nextRoot = path.join(extractDirectory, "package");
		const nextPackagePath = path.join(nextRoot, "package.json");
		const nextPackage = JSON.parse(readFileSync(nextPackagePath, "utf8"));
		const nextVersion = `${first.split(".").slice(0, 2).join(".")}.${Number(first.split(".")[2]) + 1}-next.0`;
		nextPackage.version = nextVersion;
		delete nextPackage.scripts.prepack;
		writeFileSync(nextPackagePath, `${JSON.stringify(nextPackage, null, 2)}\n`);
		const manifestPath = path.join(nextRoot, "dist", "release", "manifest.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		manifest.version = nextVersion;
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
		const nextTarball = path.join(packDirectory, "golem-next.tgz");
		run(
			"tar",
			["-czf", nextTarball, "-C", extractDirectory, "package"],
			root,
			environment,
		);

		npm(
			[
				"install",
				"--omit=dev",
				"--foreground-scripts",
				"--no-audit",
				"--no-fund",
				nextTarball,
			],
			installDirectory,
			environment,
		);
		assert.equal(installedVersion(installDirectory), nextVersion);
		const nextInstalled = installedRoot(installDirectory);
		run(
			process.execPath,
			[path.join(nextInstalled.root, "cli", "golem.js"), "sync", "--target", "cc"],
			installDirectory,
			environment,
		);
		assert.match(readFileSync(instructions, "utf8"), /USER REGION MUST SURVIVE/u);
		assert.equal(readFileSync(userFile, "utf8"), '{"unknown_key":"preserve-me"}\n');
		assert.equal(
			readFileSync(plist, "utf8"),
			"<plist>user-retained-service-definition</plist>\n",
		);

		const corrupt = path.join(packDirectory, "corrupt.tgz");
		writeFileSync(corrupt, "injected update failure");
		const failed = npm(
			["install", "--omit=dev", "--no-audit", "--no-fund", corrupt],
			installDirectory,
			environment,
			true,
		);
		assert.notEqual(failed.status, 0, "injected corrupt update must fail");
		assert.equal(
			installedVersion(installDirectory),
			nextVersion,
			"failed update keeps the active package",
		);

		npm(
			[
				"install",
				"--omit=dev",
				"--foreground-scripts",
				"--no-audit",
				"--no-fund",
				original,
			],
			installDirectory,
			environment,
		);
		assert.equal(installedVersion(installDirectory), first);
		const rolledBack = installedRoot(installDirectory);
		run(
			process.execPath,
			[
				path.join(rolledBack.root, "cli", "golem.js"),
				"sync",
				"--target",
				"cc",
				"--force",
			],
			installDirectory,
			environment,
		);
		assert.match(readFileSync(instructions, "utf8"), /USER REGION MUST SURVIVE/u);
		database = new rolledBack.require("better-sqlite3")(databasePath);
		assert.equal(
			database.prepare("select value from durable").pluck().get(),
			"preserved",
		);
		assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
		database.close();
		const checksum = crypto
			.createHash("sha256")
			.update(readFileSync(original))
			.digest("hex");
		return `real npm ${first}→${nextVersion}→${first}, corrupt-update rollback, render user-region/config/plist preservation, SQLite WAL/integrity; tarball sha256=${checksum}`;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
