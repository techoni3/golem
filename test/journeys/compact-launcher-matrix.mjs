import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { createTemporaryHome } from "@golem/testkit";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
const golem = path.join(root, "cli/golem.js");
const golemc = path.join(root, "apps/cli/src/compat/golemc.mjs");
const golemx = path.join(root, "apps/cli/src/compat/golemx.mjs");

function invoke(home, entry, args, extra = {}) {
	return spawnSync(process.execPath, [entry, ...args], {
		cwd: root,
		encoding: "utf8",
		env: {
			...process.env,
			...home.env,
			PATH: "/private/tmp/golem-node-v24.18.0-arm64/bin:/usr/bin:/bin",
			...extra,
		},
	});
}

function assertSuccess(result, label) {
	assert.equal(result.status, 0, `${label}: ${result.stderr}`);
	return result.stdout;
}

/** J5 compact daily-CLI matrix through the compiled root entrypoint and temp home. */
export async function exerciseCompactLauncherMatrix() {
	const home = createTemporaryHome("golem-gol53-launcher-");
	const golemHome = home.env.GOLEM_HOME;
	try {
		const nonTty = assertSuccess(invoke(home, golem, []), "non-TTY no-argument command");
		assert.match(nonTty, /Usage: golem/);
		assert.doesNotMatch(nonTty, /Choose a qualified launch preset/);

		const preview = assertSuccess(invoke(home, golem, ["presets", "set", "work", "opencode", "--backend", "openai", "--model", "gpt-4o", "--delivery", "prompt_bridge", "--json"]), "preset preview");
		assert.equal(JSON.parse(preview).apply, false);
		assert.equal(fs.existsSync(path.join(golemHome, "launcher.jsonc")), false, "review-only preset mutation must not write config");

		assertSuccess(invoke(home, golem, ["presets", "set", "work", "opencode", "--backend", "openai", "--model", "gpt-4o", "--delivery", "prompt_bridge", "--apply"]), "preset apply");
		const config = fs.readFileSync(path.join(golemHome, "launcher.jsonc"), "utf8");
		assert.match(config, /"work"/);
		assert.match(config, /"schema_version"/);
		const unsafePreset = invoke(home, golem, [
			"presets",
			"set",
			"leak",
			"opencode",
			"--backend",
			"openai",
			"--model",
			"api_key=secret-value",
			"--delivery",
			"prompt_bridge",
			"--apply",
		]);
		assert.equal(unsafePreset.status, 2, "secret-shaped preset values are rejected before a config write");
		assert.equal(fs.readFileSync(path.join(golemHome, "launcher.jsonc"), "utf8"), config);

		const global = assertSuccess(invoke(home, golem, ["@work", "--dry-run", "--json", "--", "--fake-safe"]), "global preset dry-run");
		const globalPlan = JSON.parse(global);
		assert.equal(globalPlan.selection.harness, "opencode");
		assert.deepEqual(globalPlan.effectiveArgvIntent.slice(-1), ["--fake-safe"], "exact passthrough reaches the immutable plan");
		assert.equal(global.includes(home.token), false, "temporary credential token is never displayed");

		for (const [harness, preset] of [["codex", "default"], ["opencode", "local"], ["claude", "local"]]) {
			const stdout = assertSuccess(invoke(home, golem, [harness, preset, "--dry-run", "--json"]), `${harness}/${preset} compact path`);
			assert.equal(JSON.parse(stdout).selection.harness, harness);
		}

		const favoritePreview = assertSuccess(invoke(home, golem, ["presets", "favorite", "work", "--json"]), "favorite preview");
		assert.equal(JSON.parse(favoritePreview).apply, false);
		assertSuccess(invoke(home, golem, ["presets", "favorite", "work", "--apply"]), "favorite apply");
		assert.match(fs.readFileSync(path.join(golemHome, "launcher-history.json"), "utf8"), /"work"/);

		const completion = assertSuccess(invoke(home, golem, ["completions", "fish"]), "fish completion generation");
		assert.match(completion, /complete -c golem -a 'presets'/);
		assert.match(completion, /complete -c golem -a 'aliases'/);
		assertSuccess(invoke(home, golem, ["completions", "zsh", "--apply"]), "zsh completion install");
		assert.equal(fs.existsSync(path.join(golemHome, "completions", "golem.zsh")), true);

		const nativeAlias = invoke(home, golem, ["aliases", "install", "--name", "codex", "--apply"]);
		assert.equal(nativeAlias.status, 2, "native commands are never shadowed");
		assertSuccess(invoke(home, golem, ["aliases", "install", "--shell", "bash", "--apply"]), "safe alias install");
		const aliases = fs.readFileSync(path.join(golemHome, "aliases", "golem.bash"), "utf8");
		assert.match(aliases, /alias golem-codex='golem codex'/);
		assert.doesNotMatch(aliases, /alias codex=/);

		const compatClaude = invoke(home, golemc, ["local", "--dry-run", "--json"]);
		assert.equal(compatClaude.status, 0, compatClaude.stderr);
		assert.match(compatClaude.stderr, /deprecated; use `golem claude`/);
		assert.equal(JSON.parse(compatClaude.stdout).selection.harness, "claude");
		const compatOpenCode = invoke(home, golemx, ["local", "--dry-run", "--json"]);
		assert.equal(compatOpenCode.status, 0, compatOpenCode.stderr);
		assert.match(compatOpenCode.stderr, /deprecated; use `golem opencode`/);
		assert.equal(JSON.parse(compatOpenCode.stdout).selection.harness, "opencode");
		const recursive = invoke(home, golemx, ["local"], { GOLEM_COMPAT_HOP: "1" });
		assert.equal(recursive.status, 2);
		assert.match(recursive.stderr, /compat.recursion/);

		const pickerScript = `
import { runCli } from "./dist/apps/cli/runner.js";
const lines = [];
const exit = await runCli([], { isTTY: true, now: "2026-07-21T00:00:00.000Z", readLine: async () => "1", stdout: (line) => lines.push(line), stderr: (line) => { throw new Error(line); } });
const cancelled = [];
const cancelledExit = await runCli([], { isTTY: true, now: "2026-07-21T00:00:00.000Z", readLine: async () => "q", stdout: (line) => cancelled.push(line), stderr: (line) => { throw new Error(line); } });
process.stdout.write(JSON.stringify({ exit, lines, cancelledExit, cancelled }));
`;
		const picker = execFileSync(process.execPath, ["--input-type=module", "-e", pickerScript], {
			cwd: root,
			encoding: "utf8",
			env: { ...process.env, ...home.env, PATH: "/private/tmp/golem-node-v24.18.0-arm64/bin:/usr/bin:/bin" },
		});
		const pickerResult = JSON.parse(picker);
		assert.equal(pickerResult.exit, 0);
		assert(pickerResult.lines.some((line) => line.startsWith("Choose a qualified launch preset")));
		assert(pickerResult.lines.some((line) => line.startsWith("selected ")));
		assert.equal(pickerResult.cancelledExit, 0, "q cancels without a failed launch");
		assert(pickerResult.cancelled.some((line) => line.startsWith("Choose a qualified launch preset")));
		assert.equal(pickerResult.cancelled.some((line) => line.startsWith("selected ")), false, "picker cancellation never launches a preset");

		return "J5 temporary-home matrix: compact scoped/global launches, picker/non-TTY behavior, explicit preset persistence, registry completions, non-native aliases, exact passthrough, and one-hop golemc/golemx compatibility verified";
	} finally {
		home.cleanup();
		assert.equal(fs.existsSync(home.root), false, "temporary launcher home must be removed");
	}
}
