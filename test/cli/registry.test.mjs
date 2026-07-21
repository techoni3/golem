import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const entry = path.join(root, "dist/apps/cli/golem.js");

function invoke(args, home) {
	try {
		return { status: 0, stdout: execFileSync(process.execPath, [entry, ...args], { cwd: root, env: { ...process.env, GOLEM_HOME: home }, encoding: "utf8" }) };
	} catch (error) {
		return { status: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
	}
}

test("typed registry preserves compact grammar, redaction, and pre-spawn qualification", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "golem-cli-registry-"));
	try {
		const before = fs.readdirSync(home);
		const help = invoke(["help"], home);
		assert.equal(help.status, 0);
		assert.match(help.stdout, /codex \[options\]/);
		assert.match(help.stdout, /opencode \[options\]/);
		assert.doesNotMatch(help.stdout, /^\s+launch(?:\s|$)/mu);
		for (const command of ["codex", "opencode", "claude"]) {
			const commandHelp = invoke([command, "--help"], home);
			assert.equal(commandHelp.status, 0, `${command} --help is read-only and successful`);
			assert.match(commandHelp.stdout, new RegExp(`Usage: golem ${command}`));
		}
		const metadata = invoke(["--json-schema"], home);
		assert.equal(metadata.status, 0);
		const schema = JSON.parse(metadata.stdout);
		assert.equal(schema.schemaVersion, "golem.cli-registry/v1");
		assert.deepEqual(schema.commands.map((command) => command.name), ["codex", "opencode", "opencode:setup", "opencode:refresh", "opencode:doctor", "claude", "dashboard", "dashboard:restart", "codex-supervisor", "status", "doctor", "sync", "role", "sessions", "migrate-home", "help"]);
		const managedPassthrough = invoke(["codex", "--dry-run", "--json", "--", "--profile", "safe"], home);
		assert.equal(managedPassthrough.status, 2, "native Codex passthrough cannot silently select or be ignored by the managed route");
		assert.match(managedPassthrough.stderr, /managed codex does not accept native passthrough arguments/);
		assert.equal(managedPassthrough.stderr.includes("secret-value"), false);
		const unavailable = invoke(["claude", "--dry-run", "--json"], home);
		assert.equal(unavailable.status, 3);
		assert.equal(JSON.parse(unavailable.stdout).error.code, "launcher.launch.unavailable");
		const invalid = invoke(["opencode", "local", "--dry-run", "--json", "--model", "api_key=secret-value"], home);
		assert.equal(invalid.status, 3);
		assert.equal(JSON.parse(invalid.stdout).error.code, "launcher.model.invalid");
		assert.equal(invalid.stdout.includes("secret-value"), false);
		assert.deepEqual(fs.readdirSync(home), before, "read-only CLI paths do not write GOLEM_HOME");
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});
