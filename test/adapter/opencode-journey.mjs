import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RuntimeSignalV1Schema } from "@golem/contracts";
import { emptyDomainState, reduceDomain } from "@golem/domain";
import {
	OpenCodeAdapter,
	OpenCodeConfigError,
	openCodeProviderCapabilities,
	qualifyOpenCodeProvider,
	setupOpenCodeConfig,
} from "@golem/adapter-opencode";

const projectId = "prj_11111111-1111-4111-8111-111111111111";
const producerInstanceId = "prod_22222222-2222-4222-8222-222222222222";
const now = "2026-07-21T00:00:00.000Z";

function observations({ local = true } = {}) {
	return [
		{ provider: "openai", modelPattern: "gpt-*", version: "1.0.0", available: true, credentials: true, daemon: false, responseObserved: true, deliveryObserved: true, observedAt: now },
		{ provider: "ollama_cloud", modelPattern: "cloud-*", version: "1.0.0", available: true, credentials: true, daemon: false, responseObserved: true, deliveryObserved: true, observedAt: now },
		{ provider: "ollama_local", modelPattern: "local-*", version: "1.0.0", available: local, credentials: false, daemon: local, responseObserved: local, deliveryObserved: local, observedAt: now },
	];
}

export async function runOpenCodeAdapterJourney() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "golem-j10-opencode-"));
	const configPath = path.join(root, "opencode.jsonc");
	const original = `// keep this user comment\n{\n  "provider": { "user": { "baseURL": "https://example.invalid" } },\n  "theme": "user-theme"\n}\n`;
	fs.writeFileSync(configPath, original);
	try {
		const setup = await setupOpenCodeConfig({ path: configPath, observations: observations() });
		assert.equal(setup.dryRun, true);
		assert.equal(fs.readFileSync(configPath, "utf8"), original, "dry-run does not mutate user config");
		assert.match(setup.text, /golem\.opencode\.providers\/v1/u);
		assert.doesNotMatch(setup.text, /ollama launch opencode/u);
		await setupOpenCodeConfig({ path: configPath, observations: observations(), apply: true });
		const applied = fs.readFileSync(configPath, "utf8");
		assert.match(applied, /keep this user comment/u);
		assert.match(applied, /example\.invalid/u);
		assert.match(applied, /"openai"/u);
		assert.match(applied, /"ollama_cloud"/u);
		assert.match(applied, /"ollama_local"/u);
		const rollbackFiles = new Map([[configPath, original]]);
		const rollbackPort = {
			readText: async (name) => rollbackFiles.get(name),
			writeBackup: async (name, text) => rollbackFiles.set(name, text),
			writeTemporary: async (name, text) => { rollbackFiles.set(name, text); throw new Error("simulated temporary write interruption"); },
			commitTemporary: async () => { throw new Error("must not commit interrupted stage"); },
			rollback: async (name, backup) => rollbackFiles.set(name, rollbackFiles.get(backup) ?? original),
			removeTemporary: async (name) => rollbackFiles.delete(name),
		};
		await assert.rejects(
			() => setupOpenCodeConfig({ path: configPath, observations: observations(), apply: true, port: rollbackPort }),
			(error) => error instanceof OpenCodeConfigError && error.code === "adapter.opencode.config.atomic_write_failed",
		);
		assert.equal(rollbackFiles.get(configPath), original, "interrupted setup restores prior bytes");
		assert.equal(rollbackFiles.has(`${configPath}.golem-opencode.tmp`), false, "interrupted setup cleans the temporary file");

		const caps = openCodeProviderCapabilities(observations());
		assert.deepEqual(caps.map((capability) => capability.capability.capability_id), [
			"opencode.ollama-cloud.direct",
			"opencode.ollama-local.direct",
			"opencode.openai.direct",
		]);
		assert(caps.every((capability) => capability.capability.qualification === "supported"));
		const missingLocal = openCodeProviderCapabilities(observations({ local: false }));
		assert.equal(missingLocal.find((capability) => capability.backend === "openai")?.capability.qualification, "supported");
		assert.equal(missingLocal.find((capability) => capability.backend === "ollama_cloud")?.capability.qualification, "supported");
		assert.equal(qualifyOpenCodeProvider(observations({ local: false })[2], now).launchable, false);

		const calls = [];
		const adapter = new OpenCodeAdapter({ projectId, producerInstanceId, now: () => now });
		const created = adapter.consume({ type: "session.created", properties: { info: { id: "ses_opencode_parent", title: "Parent", time: { created: now } } } });
		assert(created);
		assert.equal(RuntimeSignalV1Schema.safeParse(created).success, true);
		const child = adapter.consume({ type: "session.created", properties: { info: { id: "ses_opencode_child", parentID: "ses_opencode_parent" } } });
		assert.equal(child, undefined, "child sessions never become dispatchable signals");
		const state = adapter.stateFor("ses_opencode_parent");
		assert(state);
		const bridge = adapter.bridge({
			sessionId: state.sessionId,
			fence: { generationId: state.generationId, ownerFence: "fence-1", eligible: true },
			port: { promptAsync: async (input) => { calls.push(input); return { accepted: true, receipt: "receipt-1" }; } },
		});
		const accepted = await bridge.deliver({ deliveryId: "del-1", sessionId: state.sessionId, text: "hello", fence: { generationId: state.generationId, ownerFence: "fence-1", eligible: true } });
		assert.equal(accepted.status, "accepted");
		assert.equal((await bridge.deliver({ deliveryId: "del-1", sessionId: state.sessionId, text: "hello", fence: { generationId: state.generationId, ownerFence: "fence-1", eligible: true } })).status, "accepted");
		assert.equal(calls.length, 1, "idempotent delivery calls promptAsync once");
		const stale = await bridge.deliver({ deliveryId: "del-stale", sessionId: state.sessionId, text: "must-not-send", fence: { generationId: state.generationId, ownerFence: "old-fence", eligible: true } });
		assert.equal(stale.code, "adapter.opencode.fence_stale");
		assert.equal(calls.length, 1, "stale fence is refused before adapter call");
		bridge.setFence({ generationId: state.generationId, ownerFence: "fence-2", eligible: false });
		assert.equal((await bridge.deliver({ deliveryId: "del-held", sessionId: state.sessionId, text: "must-not-send", fence: { generationId: state.generationId, ownerFence: "fence-2", eligible: false } })).code, "adapter.opencode.delivery.ineligible");
		assert.equal(calls.length, 1, "ineligible delivery is refused before adapter call");

		const events = [
			adapter.consume({ type: "session.status", properties: { sessionID: "ses_opencode_parent", status: { type: "busy" } } }),
			adapter.consume({ type: "session.updated", properties: { info: { id: "ses_opencode_parent", title: "Renamed", model: "gpt-5" } } }),
			adapter.consume({ type: "session.deleted", properties: { info: { id: "ses_opencode_parent" } } }),
		];
		assert.equal(events.filter(Boolean).length, 3);
		assert.equal(events.at(-1)?.payload.kind, "session.ended");
		let domain = emptyDomainState();
		for (const event of [created, ...events].filter(Boolean)) domain = reduceDomain(domain, event, { materializedAt: now }).state;
		const generation = Object.values(domain.generations)[0];
		assert.equal(generation?.state, "ended", "canonical domain owns terminal lifecycle state");
		return "OpenCode provider coexistence, marked JSONC dry-run/apply preservation, canonical lifecycle signals, child exclusion, idempotent promptAsync, and stale-fence refusal verified";
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		assert.equal(fs.existsSync(root), false);
	}
}

export async function runOpenCodeResumeBridgeJourney() {
	const adapter = new OpenCodeAdapter({ projectId, producerInstanceId, now: () => now });
	const created = adapter.consume({ type: "session.created", properties: { info: { id: "ses_opencode_recovery", time: { created: now } } } });
	assert(created);
	const resumed = adapter.consume({ type: "session.resumed", properties: { sessionID: "ses_opencode_recovery" } });
	assert.equal(resumed?.payload.kind, "session.resumed");
	const state = adapter.stateFor("ses_opencode_recovery");
	assert(state);
	let attempts = 0;
	const bridge = adapter.bridge({
		sessionId: state.sessionId,
		fence: { generationId: state.generationId, ownerFence: "recover-fence", eligible: true },
		port: { promptAsync: async () => { attempts += 1; if (attempts === 1) throw new Error("simulated bridge crash"); return { accepted: true, receipt: "recovered" }; } },
	});
	const request = { deliveryId: "del-recover", sessionId: state.sessionId, text: "resume", fence: { generationId: state.generationId, ownerFence: "recover-fence", eligible: true } };
	assert.equal((await bridge.deliver(request)).status, "retry");
	assert.equal((await bridge.deliver(request)).status, "accepted");
	assert.equal(attempts, 2, "bridge retry is bounded and reuses canonical fence");
	bridge.setFence({ generationId: state.generationId, ownerFence: "new-fence", eligible: true });
	const stale = await bridge.deliver({ ...request, deliveryId: "del-old-fence" });
	assert.equal(stale.code, "adapter.opencode.fence_stale");
	return "real adapter bridge crash/retry, idempotent delivery, and replacement-fence refusal verified";
}
