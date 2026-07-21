import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RuntimeSignalV1Schema } from "@golem/contracts";
import { createEndpointService, createSessionService } from "@golem/runtime";
import { openControlPlanePersistence } from "../../apps/control-plane/dist/persistence.js";
import {
	CLAUDE_CHANNEL_PROTOCOL,
	CLAUDE_CONSUMPTION_MARKER,
	createClaudeChannelOwner,
	createClaudeAdapter,
	parseClaudeHook,
	qualifyClaude,
} from "@golem/adapter-claude";

const projectId = "prj_00000000-0000-4000-8000-000000000047";
const locationId = "loc_00000000-0000-4000-8000-000000000047";
const sessionId = "ses_00000000-0000-4000-8000-000000000047";
const generationId = "gen_00000000-0000-4000-8000-000000000047";
const ownerSecret = "claude-channel-secret-for-fixture";
const clock = {
	now: () => "2026-07-21T03:00:00.000Z",
	after: (milliseconds) => new Date(Date.parse("2026-07-21T03:00:00.000Z") + milliseconds).toISOString(),
};

function context() {
	return {
		projectId,
		locationId,
		canonicalPath: "/tmp/golem-47-claude",
		relation: "main",
		generationId,
		sessionId,
		producerInstanceId: "prod_00000000-0000-4000-8000-000000000047",
	};
}

test("GOL-47 Claude hooks produce canonical lifecycle/activity signals", async () => {
	const adapter = createClaudeAdapter({ clock });
	const seen = [];
	const started = parseClaudeHook(
		{
			hook_event_name: "SessionStart",
			session_id: sessionId,
			model: "token=claude-secret",
			source: "password=do-not-log",
			prompt: "must never be accepted",
		},
		context(),
		clock,
	);
	assert.deepEqual(started.signals.map((signal) => signal.event_kind), ["project.observed", "session.started"]);
	for (const signal of started.signals) {
		RuntimeSignalV1Schema.parse(signal);
		seen.push(signal);
	}
	const activity = await adapter.ingestHook(
		{ hook_event_name: "UserPromptSubmit", session_id: sessionId },
		context(),
		{ ingest: async (signal) => { seen.push(signal); } },
	);
	assert.equal(activity.failed, false);
	assert.equal(activity.signals[0].payload.kind, "session.activity");
	assert.equal(activity.signals[0].payload.activity_kind, "prompt");
	const waiting = parseClaudeHook(
		{ hook_event_name: "Notification", session_id: sessionId, notification_type: "permission" },
		context(),
		clock,
	);
	assert.equal(waiting.signals[0].event_kind, "session.waiting");
	const ended = parseClaudeHook(
		{ hook_event_name: "Stop", session_id: sessionId, error: true },
		context(),
		clock,
	);
	assert.equal(ended.signals[0].payload.disposition, "errored");
	assert.equal(JSON.stringify(seen).includes("must never be accepted"), false);
	assert.equal(JSON.stringify(seen).includes("claude-secret"), false);
	assert.equal(JSON.stringify(seen).includes("do-not-log"), false);
	assert.equal(JSON.stringify(seen).includes("prompt"), true, "only the activity kind is retained");
	const hostileSecret = "ghp-abcdef1234567890";
	const hostile = parseClaudeHook(
		{
			hook_event_name: "SessionStart",
			session_id: sessionId,
			model: `Bearer ${hostileSecret}`,
			source: `Bearer ${hostileSecret}`,
		},
		{
			...context(),
			canonicalPath: `/tmp/golem-47/${hostileSecret}/canonical`,
			observedPath: `/private/golem-47/${hostileSecret}/observed`,
		},
		clock,
	);
	const hostileProject = hostile.signals.find((signal) => signal.event_kind === "project.observed");
	const hostileSession = hostile.signals.find((signal) => signal.event_kind === "session.started");
	assert.ok(hostileProject);
	assert.ok(hostileSession);
	assert.equal(hostileProject.payload.location.canonical_path.includes(hostileSecret), false);
	assert.equal(hostileProject.payload.location.observed_path.includes(hostileSecret), false);
	assert.equal(hostileSession.payload.metadata.model, "$REDACTED");
	assert.equal(hostileSession.payload.metadata.source, "$REDACTED");
	assert.equal(JSON.stringify(hostile).includes(hostileSecret), false, "credential-shaped Bearer values and paths never reach canonical events");
	const hostileWaiting = parseClaudeHook(
		{ hook_event_name: "Notification", session_id: sessionId, notification_type: "api_key=do-not-log" },
		context(),
		clock,
	);
	assert.equal(JSON.stringify(hostileWaiting).includes("do-not-log"), false);
});

test("GOL-47 Claude channel readiness requires authenticated addressed consumption", async () => {
	const calls = [];
	const endpoint = {
		claim: async (input) => { calls.push(["claim", input]); return { disposition: "accepted", endpointId: "ep_00000000-0000-4000-8000-000000000047", ownerFence: 7 }; },
		heartbeat: async (input) => { calls.push(["heartbeat", input]); return { disposition: "accepted" }; },
		probe: async (input) => { calls.push(["probe", input]); return { disposition: "accepted" }; },
		reportReadiness: async (input) => { calls.push(["readiness", input]); return { disposition: "accepted" }; },
		reportDelivery: async (input) => { calls.push(["delivery", input]); return { disposition: "accepted" }; },
		reportCapability: async (input) => { calls.push(["capability", input]); return { disposition: "accepted" }; },
		release: async (input) => { calls.push(["release", input]); return { disposition: "accepted" }; },
	};
	const owner = createClaudeChannelOwner({ endpoint, generationId, sessionId, ownerInstanceId: "claude-owner", ownerSecret, clock });
	await owner.start();
	assert.equal(owner.ownerFence, 7);
	assert.equal(await owner.handshake({ sessionId, protocol: CLAUDE_CHANNEL_PROTOCOL, ownerSecret: "wrong" }), false);
	assert.equal(calls.filter(([kind]) => kind === "probe").length, 0);
	assert.equal(await owner.handshake({ sessionId, protocol: CLAUDE_CHANNEL_PROTOCOL, ownerSecret }), true);
	assert.equal(owner.snapshot().handshaken, true);
	assert.equal(await owner.consume({ sessionId, marker: "wrong", modelVersion: "sonnet", claudeVersion: "1.0", addressed: true }), false);
	assert.equal(await owner.consume({ sessionId, marker: CLAUDE_CONSUMPTION_MARKER, modelVersion: "token=secret", claudeVersion: "1.0", addressed: true }), false);
	assert.equal(await owner.consume({ sessionId, marker: CLAUDE_CONSUMPTION_MARKER, modelVersion: "sonnet", claudeVersion: "1.0", addressed: true }), true);
	assert.equal(owner.snapshot().qualified, true);
	assert.equal(calls.some(([kind, input]) => kind === "readiness" && input.readiness === "ready"), true);
	assert.equal(JSON.stringify(owner.snapshot()).includes(ownerSecret), false);
	await owner.release();
	assert.equal(calls.at(-1)[0], "release");

	const unsupported = await qualifyClaude({ launch: async () => ({ ok: false }), consume: async () => ({ consumed: false }) });
	assert.equal(unsupported.capability.qualification, "unsupported");
	assert.equal(unsupported.launchable, false);
	const pullOnly = await qualifyClaude({ launch: async () => ({ ok: true, claudeVersion: "1.0" }), consume: async () => ({ consumed: false }) });
	assert.equal(pullOnly.capability.qualification, "unknown");
	assert.equal(pullOnly.readiness, "pull_only");
	const ready = await qualifyClaude({ launch: async () => ({ ok: true }), consume: async () => ({ consumed: true, claudeVersion: "1.0", modelVersion: "sonnet" }) });
	assert.equal(ready.capability.qualification, "supported");
	assert.equal(ready.readiness, "ready");
	const redacted = await qualifyClaude({ launch: async () => ({ ok: true, claudeVersion: "api_key=secret" }), consume: async () => ({ consumed: false }) });
	assert.equal(JSON.stringify(redacted).includes("secret"), false);
});

test("GOL-47 Claude adapter crosses canonical SQLite session and endpoint fences", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "golem-gol47-real-"));
	const owner = openControlPlanePersistence(
		{ runtimePath: path.join(root, "runtime.db"), trackerPath: path.join(root, "tracker.db") },
		{ ownerId: "gol47-real-owner", clock },
	);
	try {
		const adapter = createClaudeAdapter({ clock });
		const endpointService = createEndpointService({ storage: owner.runtimeEndpointStorage() });
		const sessionService = createSessionService({ projects: owner.runtimeProjectStorage(), sessions: owner.runtimeSessionStorage() });
		owner.runtimeProjectStorage().observe({
			projectId,
			name: "golem-47-real",
			location: { locationId, canonicalPath: "/tmp/golem-47-real", relation: "main", source: "hook", evidence: { journey: true }, observedAt: clock.now() },
			source: "hook",
			eventId: "evt_00000000-0000-4000-8000-000000000047",
			deduplicationKey: "golem-47-real-project",
			payload: { kind: "project.observed" },
			provenance: { source: "adapter", confidence: "observed" },
			occurredAt: clock.now(),
		});
		const started = adapter.parseHook({ hook_event_name: "SessionStart", session_id: sessionId }, context());
		assert.equal(sessionService.apply(started.signals[1]).disposition, "accepted");
		const endpoint = {
			claim: (input) => endpointService.claim(input),
			heartbeat: (input) => endpointService.heartbeat(input),
			probe: (input) => endpointService.probe(input),
			reportReadiness: (input) => endpointService.reportReadiness(input),
			reportDelivery: (input) => endpointService.reportDelivery(input),
			reportCapability: (input) => endpointService.reportCapability(input),
			release: (input) => endpointService.release(input),
		};
		const channel = createClaudeChannelOwner({ endpoint, generationId, sessionId, ownerInstanceId: "gol47-real-channel", ownerSecret, clock });
		await channel.start();
		assert.equal(await channel.handshake({ sessionId, protocol: CLAUDE_CHANNEL_PROTOCOL, ownerSecret }), true);
		assert.equal(await channel.consume({ sessionId, marker: CLAUDE_CONSUMPTION_MARKER, modelVersion: "sonnet", claudeVersion: "1.0", addressed: true }), true);
		const stored = endpointService.list(generationId)[0];
		assert.equal(stored?.consumerReady, true);
		assert.equal(stored?.deliveryObserved, true);
		assert.equal(stored?.readiness, "ready");
		const receipt = await adapter.ingestHook(
			{ hook_event_name: "UserPromptSubmit", session_id: sessionId },
			context(),
			{ ingest: (signal) => sessionService.apply(signal) },
		);
		assert.equal(receipt.failed, false);
		assert.equal(sessionService.get(projectId, sessionId)?.activeGenerationId, generationId);
		await channel.release();
		assert.equal(endpointService.get(stored.endpointId)?.state, "released");
	} finally {
		await owner.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
