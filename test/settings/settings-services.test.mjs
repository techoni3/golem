import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createTemporaryHome } from "@golem/testkit";

import {
	BrowserSettingsServiceError,
	createBrowserSettingsServices,
} from "../../apps/control-plane/dist/browser-settings-services.js";

const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const cliEntry = path.join(repositoryRoot, "cli", "golem.js");
const migrationFixture = path.join(
	repositoryRoot,
	"test",
	"fixtures",
	"migration",
	"strong-only",
);
const hostileToken = "gol56_SETTINGS_SECRET_000000000000";
const hostilePrompt = "IGNORE_PREVIOUS_GOL56_PRIVATE_PROMPT";

function runtimeProjection() {
	return {
		projects: () => [],
		sessions: () => [],
		endpoints: () => [],
		events: () => [],
		diagnostics: () => [],
		watermarks: () => [],
		revision: () => 0,
	};
}

function fakeService(home) {
	let loaded = false;
	const calls = [];
	const runner = {
		run(arguments_) {
			calls.push([...arguments_]);
			if (arguments_[0] === "print")
				return {
					status: loaded ? 0 : 113,
					stdout: loaded ? "managed service loaded" : "",
					stderr: loaded ? "" : "not loaded",
				};
			if (
				arguments_[0] === "bootstrap" ||
				arguments_[0] === "kickstart"
			)
				loaded = true;
			if (
				arguments_[0] === "kill" ||
				arguments_[0] === "bootout"
			)
				loaded = false;
			return { status: 0, stdout: "", stderr: "" };
		},
	};
	const credentialPath = path.join(
		home.golemHome,
		"control-plane",
		"service-token",
	);
	const directory = path.join(home.root, "launch-agents");
	return {
		calls,
		credentialPath,
		directory,
		options: {
			directory,
			uid: 501,
			runner,
			credentialPath,
			credential: hostileToken,
			definition: {
				label: "dev.golem.control-plane",
				program: process.execPath,
				arguments: [path.join(repositoryRoot, "apps/control-plane/dist/main.js")],
				workingDirectory: repositoryRoot,
				environment: {
					GOLEM_HOME: home.golemHome,
					GOLEM_CONTROL_PLANE_TOKEN_FILE: credentialPath,
				},
			},
		},
	};
}

function settings(home, service, substrateRoot) {
	const openCodeConfigPath = path.join(
		home.xdgConfigHome,
		"opencode",
		"opencode.jsonc",
	);
	return {
		openCodeConfigPath,
		create: () =>
			createBrowserSettingsServices({
				home: home.golemHome,
				runtimeProjection: runtimeProjection(),
				cliEntry,
				openCodeConfigPath,
				environment: {
					...home.env,
					PATH: process.env.PATH,
					OPENAI_API_KEY: hostileToken,
					GOL56_PROMPT: hostilePrompt,
					...(substrateRoot
						? { GOLEM_SUBSTRATE_ROOT: substrateRoot }
						: {}),
				},
				service: service.options,
			}),
	};
}

function completed(response) {
	assert.equal(response.status, "completed");
	assert(response.result, "settings command returns a completed typed result");
	return response.result;
}

async function previewApply(
	service,
	preview,
	apply,
) {
	const plan = completed(await service.command(preview));
	assert(plan.plan_hash, "preview returns an exact hash");
	return service.command(apply(plan.plan_hash));
}

function assertSafe(value, home) {
	const serialized = JSON.stringify(value);
	for (const forbidden of [
		hostileToken,
		hostilePrompt,
		home.root,
		"authorization",
		"cookie",
		"csrf",
	])
		assert.equal(
			serialized.toLowerCase().includes(forbidden.toLowerCase()),
			false,
			`public settings output excludes ${forbidden}`,
		);
}

test("GOL-56 settings service composes compiler, provider, preset, lifecycle, and durable idempotency authorities", async () => {
	const home = createTemporaryHome("golem-gol56-settings-");
	const managedService = fakeService(home);
	const cleanSubstrate = path.join(home.root, "substrate-fixture");
	fs.cpSync(path.join(repositoryRoot, "substrate"), cleanSubstrate, {
		recursive: true,
	});
	fs.rmSync(path.join(cleanSubstrate, "roles", "standalone.md"), {
		force: true,
	});
	fs.rmSync(path.join(cleanSubstrate, "skills", "night-shift"), {
		recursive: true,
		force: true,
	});
	const setup = settings(home, managedService, cleanSubstrate);
	const launcherPath = path.join(home.golemHome, "launcher.jsonc");
	const originalOpenCode = `{
  "provider": {
    "custom-owner": { "model": "owner/model" }
  },
  "theme": "owner-dark"
}
`;
	const originalLauncher = `{
  "schema_version": "golem.launcher-config/v1",
  "launch": { "harness_defaults": {}, "presets": [] },
  "owner_ui": { "density": "compact" }
}
`;
	fs.mkdirSync(path.dirname(setup.openCodeConfigPath), { recursive: true });
	fs.writeFileSync(setup.openCodeConfigPath, originalOpenCode, "utf8");
	fs.writeFileSync(launcherPath, originalLauncher, "utf8");
	try {
		let service = setup.create();
		const initial = await service.snapshot();
		assert.equal(
			initial.capabilities.some((entry) => entry.harness === "pi"),
			true,
			"capability matrix includes truthful Pi next-turn support",
		);
		assert.equal(initial.service.api, "ready");
		assert.equal(initial.service.process, "stopped");
		assertSafe(initial, home);

		const renderApplied = await previewApply(
			service,
			{
				kind: "render.preview",
				target: "pi",
				idempotency_key: "gol56-render-preview-first",
			},
			(plan_hash) => ({
				kind: "render.apply",
				target: "pi",
				plan_hash,
				confirm: true,
				idempotency_key: "gol56-render-apply-first",
			}),
		);
		assert.equal(completed(renderApplied).outcome, "applied");
		const cleanPreview = completed(
			await service.command({
				kind: "render.preview",
				target: "pi",
				idempotency_key: "gol56-render-preview-second",
			}),
		);
		assert.equal(cleanPreview.changed, false);
		const secondApplyInput = {
			kind: "render.apply",
			target: "pi",
			plan_hash: cleanPreview.plan_hash,
			confirm: true,
			idempotency_key: "gol56-render-apply-second",
		};
		const secondApply = await service.command(secondApplyInput);
		assert.equal(completed(secondApply).rollback_available, true);
		assert.deepEqual(
			await service.command(secondApplyInput),
			secondApply,
			"an identical command key replays one durable outcome",
		);
		await assert.rejects(
			() =>
				service.command({
					...secondApplyInput,
					target: "codex",
				}),
			(error) =>
				error instanceof BrowserSettingsServiceError &&
				error.code === "command.idempotency_mismatch",
			"one key cannot authorize a differing target",
		);

		const render = (await service.snapshot()).renders.find(
			(entry) => entry.target === "pi",
		);
		assert(render?.managed_files[0], "real compiler render owns at least one file");
		fs.appendFileSync(
			path.join(
				home.golemHome,
				"renders",
				"pi",
				render.managed_files[0],
			),
			"\nGOL56 tamper\n",
		);
		assert.equal(
			(await service.snapshot()).renders.find(
				(entry) => entry.target === "pi",
			)?.status,
			"tamper",
		);
		assert.equal(
			completed(
				await service.command({
					kind: "render.rollback",
					target: "pi",
					confirm: true,
					idempotency_key: "gol56-render-rollback",
				}),
			).outcome,
			"rolled_back",
		);

		const providerApplied = await previewApply(
			service,
			{
				kind: "provider.preview",
				provider: "openai",
				idempotency_key: "gol56-provider-preview",
			},
			(plan_hash) => ({
				kind: "provider.apply",
				provider: "openai",
				plan_hash,
				confirm: true,
				idempotency_key: "gol56-provider-apply",
			}),
		);
		assertSafe(providerApplied, home);
		const configured = fs.readFileSync(setup.openCodeConfigPath, "utf8");
		assert.match(configured, /custom-owner/u);
		assert.match(configured, /owner-dark/u);
		assert.match(configured, /golem\.opencode\.providers\/v1/u);
		await service.command({
			kind: "provider.rollback",
			provider: "openai",
			confirm: true,
			idempotency_key: "gol56-provider-rollback",
		});
		assert.equal(
			fs.readFileSync(setup.openCodeConfigPath, "utf8"),
			originalOpenCode,
		);

		const presetInput = {
			name: "reviewed",
			harness: "codex",
			backend: "openai",
			model_selector: "gpt-*",
			delivery_mode: "managed_app_server",
		};
		const presetApplied = await previewApply(
			service,
			{
				kind: "preset.preview",
				preset: presetInput,
				idempotency_key: "gol56-preset-preview",
			},
			(plan_hash) => ({
				kind: "preset.apply",
				preset: presetInput,
				plan_hash,
				confirm: true,
				idempotency_key: "gol56-preset-apply",
			}),
		);
		assertSafe(presetApplied, home);
		const launcher = fs.readFileSync(launcherPath, "utf8");
		assert.match(launcher, /"owner_ui"/u);
		assert.match(launcher, /"reviewed"/u);
		assert.equal(launcher.includes(hostileToken), false);
		await service.command({
			kind: "preset.rollback",
			confirm: true,
			idempotency_key: "gol56-preset-rollback",
		});
		assert.equal(fs.readFileSync(launcherPath, "utf8"), originalLauncher);

		const installApplied = await previewApply(
			service,
			{
				kind: "service.preview",
				action: "install",
				idempotency_key: "gol56-service-preview-install",
			},
			(plan_hash) => ({
				kind: "service.apply",
				action: "install",
				plan_hash,
				confirm: true,
				idempotency_key: "gol56-service-apply-install",
			}),
		);
		assertSafe(installApplied, home);
		const plist = fs.readFileSync(
			path.join(
				managedService.directory,
				"dev.golem.control-plane.plist",
			),
			"utf8",
		);
		assert.equal(plist.includes(hostileToken), false);
		assert.match(plist, /GOLEM_CONTROL_PLANE_TOKEN_FILE/u);
		assert.equal(
			fs.readFileSync(managedService.credentialPath, "utf8").trim(),
			hostileToken,
			"credential bytes stay in the private credential file",
		);
		await previewApply(
			service,
			{
				kind: "service.preview",
				action: "update",
				idempotency_key: "gol56-service-preview-update",
			},
			(plan_hash) => ({
				kind: "service.apply",
				action: "update",
				plan_hash,
				confirm: true,
				idempotency_key: "gol56-service-apply-update",
			}),
		);
		await previewApply(
			service,
			{
				kind: "service.preview",
				action: "rollback",
				idempotency_key: "gol56-service-preview-rollback",
			},
			(plan_hash) => ({
				kind: "service.apply",
				action: "rollback",
				plan_hash,
				confirm: true,
				idempotency_key: "gol56-service-apply-rollback",
			}),
		);

		service = setup.create();
		assert.deepEqual(
			await service.command(secondApplyInput),
			secondApply,
			"restart replay returns the byte-equivalent original outcome",
		);
		const receipts = fs.readFileSync(
			path.join(
				home.golemHome,
				"control-plane",
				"settings-command-receipts.json",
			),
			"utf8",
		);
		for (const forbidden of [
			hostileToken,
			hostilePrompt,
			"gol56-render-apply-second",
			home.root,
		])
			assert.equal(
				receipts.includes(forbidden),
				false,
				"durable receipts contain only hashed command identity and safe results",
			);
	} finally {
		home.cleanup();
	}
	assert.equal(fs.existsSync(home.root), false);
});

test("GOL-56 migration settings recheck the exact dry-run and expose rollback", async () => {
	const home = createTemporaryHome("golem-gol56-migration-settings-");
	fs.cpSync(migrationFixture, home.golemHome, {
		recursive: true,
		force: true,
	});
	const managedService = fakeService(home);
	const setup = settings(home, managedService);
	try {
		let service = setup.create();
		const previewInput = {
			kind: "migration.preview",
			idempotency_key: "gol56-migration-preview",
		};
		const preview = completed(await service.command(previewInput));
		assert(preview.plan_hash);
		const applyInput = {
			kind: "migration.apply",
			plan_hash: preview.plan_hash,
			confirm: true,
			idempotency_key: "gol56-migration-apply",
		};
		const applied = await service.command(applyInput);
		assert.equal(completed(applied).rollback_available, true);
		assert.equal((await service.snapshot()).migration.status, "applied");
		service = setup.create();
		assert.deepEqual(
			await service.command(applyInput),
			applied,
			"migration apply replays without importing twice after restart",
		);
		const rolledBack = completed(
			await service.command({
				kind: "migration.rollback",
				confirm: true,
				idempotency_key: "gol56-migration-rollback",
			}),
		);
		assert.equal(rolledBack.outcome, "rolled_back");
		assert.equal((await service.snapshot()).migration.status, "rolled_back");
		assertSafe(applied, home);
		assertSafe(rolledBack, home);
	} finally {
		home.cleanup();
	}
	assert.equal(fs.existsSync(home.root), false);
});
