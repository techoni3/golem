import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createTemporaryHome } from "@golem/testkit";
import { createSessionService } from "@golem/runtime";
import { openControlPlanePersistence } from "../../apps/control-plane/dist/persistence.js";
import { composeControlPlaneManagementServices, composeControlPlaneTrackerCoreServices } from "../../apps/control-plane/dist/index.js";
import { startControlPlane } from "../../apps/control-plane/dist/index.js";
import { TrackerManagementError } from "@golem/tracker";
import { provisionBearerPrincipal } from "../fixtures/control-plane-principal.mjs";

function clock() {
	return { now: () => "2026-07-21T00:00:00.000Z", after: (ms) => new Date(Date.parse("2026-07-21T00:00:00.000Z") + ms).toISOString() };
}

function seedCanonical(owner, projectId, sessionId, generationId, suffix) {
	owner.runtimeProjectStorage().observe({
		projectId,
		name: `management-${suffix}`,
		location: {
			locationId: `location-${suffix}`,
			canonicalPath: `/tmp/${suffix}`,
			relation: "main",
			source: "register",
			evidence: { fixture: true },
			observedAt: "2026-07-21T00:00:00.000Z",
		},
		source: "register",
		eventId: `event-project-${suffix}`,
		deduplicationKey: `management-project-${suffix}`,
		payload: { kind: "project.observed" },
		provenance: { source: "fixture", confidence: "verified" },
		occurredAt: "2026-07-21T00:00:00.000Z",
	});
	return createSessionService({
		projects: owner.runtimeProjectStorage(),
		sessions: owner.runtimeSessionStorage(),
	}).apply({
		schema_version: "golem.runtime-signal/v1",
		event_id: `event-session-${suffix}`,
		event_kind: "session.started",
		producer: "management-fixture",
		producer_instance_id: `producer-${suffix}`,
		producer_sequence: 1,
		harness: "claude",
		correlation_id: `correlation-${suffix}`,
		deduplication_key: `management-session-${suffix}`,
		clocks: {
			source_observed_at: "2026-07-21T00:00:00.000Z",
			received_at: "2026-07-21T00:00:00.001Z",
			materialized_at: "2026-07-21T00:00:00.002Z",
		},
		provenance: { source: "fixture", confidence: "verified", evidence_id: suffix },
		clear_fields: [],
		payload: {
			kind: "session.started",
			generation: { project_id: projectId, session_id: sessionId, generation_id: generationId },
			metadata: { name: `management-${suffix}`, model: "sonnet", role: "manager" },
		},
	});
}

function open(home, suffix = "") {
	const writer = openControlPlanePersistence({ runtimePath: home.runtimeDb, trackerPath: home.trackerDb, lockPath: path.join(home.root, "management-owner.lock") }, { ownerId: `management-${suffix || "one"}` });
	const core = composeControlPlaneTrackerCoreServices({ writer, clock: clock() });
	const management = composeControlPlaneManagementServices({ writer, clock: clock(), assetRoot: path.join(home.root, "assets"), tickets: core.tickets });
	return { writer, core, management };
}

test("roles gates ideas and controls are typed, idempotent, audited, and restart durable", async () => {
	const home = createTemporaryHome("golem-j6-management-");
	let opened;
	try {
		opened = open(home);
		const { management } = opened;
		seedCanonical(opened.writer, "mgmt-project", "session-one", "generation-one", "primary");
		seedCanonical(opened.writer, "foreign-project", "foreign-session", "foreign-generation", "foreign");
		const role = management.roles.create({ projectId: "mgmt-project", name: "operator", actor: "human:manager", definition: { token: "do-not-persist", display: "Operator" } });
		const roleRetry = management.roles.create({ projectId: "mgmt-project", name: "operator", actor: "human:manager token=retry-secret", definition: { display: "Operator", token: "do-not-persist" } });
		assert.equal(roleRetry.id, role.id, "identical role retry returns the canonical role");
		assert.equal(roleRetry.revision, role.revision, "identical role retry does not advance revision");
		const assignmentA = management.roles.assign({ projectId: "mgmt-project", roleId: role.id, sessionId: "session-one", generationId: "generation-one", actor: "human:manager", idempotencyKey: "assign-one" });
		const assignmentB = management.roles.assign({ projectId: "mgmt-project", roleId: role.id, sessionId: "session-one", generationId: "generation-one", actor: "human:manager", idempotencyKey: "assign-one" });
		assert.equal(assignmentA.id, assignmentB.id, "role assignment retry is idempotent");
		const gate = management.gates.create({ projectId: "mgmt-project", kind: "approval", question: "Approve deployment?", assignee: "human:approver", actor: "human:manager token=gate-secret", idempotencyKey: "gate-one" });
		assert.equal(gate.status, "awaiting", "human gates are never auto-answered");
		assert.throws(() => management.gates.answer({ projectId: "mgmt-project", gateId: gate.id, status: "approved", verdict: { approved: true }, actor: "human:attacker" }), (error) => error instanceof TrackerManagementError && error.code === "management.forbidden");
		assert.equal(management.gates.answer({ projectId: "mgmt-project", gateId: gate.id, status: "approved", verdict: { approved: true }, actor: "human:approver" }).status, "approved");
		const idea = management.ideas.create({ projectId: "mgmt-project", body: "Promote this idea", actor: "human:manager", idempotencyKey: "idea-one" });
		management.ideas.pop({ projectId: "mgmt-project", ideaId: idea.id, actor: "human:manager" });
		const promotedA = management.ideas.promote({ projectId: "mgmt-project", ideaId: idea.id, actor: "human:manager" });
		const promotedB = management.ideas.promote({ projectId: "mgmt-project", ideaId: idea.id, actor: "human:manager" });
		assert.equal(promotedA.promotedTicketId, promotedB.promotedTicketId, "idea promotion is exactly-once under retry");
		const operationA = management.controls.request({ projectId: "mgmt-project", command: "brief", payload: { token: "secret-value", message: "hello" }, actor: "human:manager", idempotencyKey: "control-one" });
		const operationB = management.controls.request({ projectId: "mgmt-project", command: "brief", payload: { token: "secret-value", message: "hello" }, actor: "human:manager", idempotencyKey: "control-one" });
		assert.equal(operationA.id, operationB.id, "control request retry is idempotent");
		assert.equal(JSON.stringify(operationA.payload).includes("secret-value"), false, "persisted operation payload redacts token values");
		const audit = management.audit("mgmt-project");
		assert.equal(JSON.stringify(audit).includes("do-not-persist"), false, "audit output remains redacted");
		assert(audit.some((entry) => entry.actor.includes("[REDACTED]")), "audit stores a redacted canonical actor");
		const revisionBeforeForeign = management.roles.list("mgmt-project")[0].revision;
		const staticDirectory = path.join(home.root, "static");
		fs.mkdirSync(staticDirectory, { recursive: true });
		fs.writeFileSync(path.join(staticDirectory, "index.html"), "management fixture");
		const principalResolver = provisionBearerPrincipal(opened.writer, {
			token: "management-test-token-01234567890123456789",
			projectId: "mgmt-project",
			actorId: "human:manager",
			bindingId: "principal_management_fixture",
		});
		const server = await startControlPlane({ token: "management-test-token-01234567890123456789", stateDirectory: path.join(home.root, "control-plane"), staticDirectory, management, principalResolver });
		try {
			const response = await fetch(`${server.origin}/api/v1/management/roles`, { headers: { authorization: "Bearer management-test-token-01234567890123456789" } });
			assert.equal(response.status, 200);
			assert.equal((await response.json()).result[0].name, "operator", "the shipped management route delegates to typed storage");
			const headers = { authorization: "Bearer management-test-token-01234567890123456789", "content-type": "application/json" };
			const foreignAssignment = await fetch(`${server.origin}/api/v1/management/roles/${role.id}/assign`, { method: "POST", headers, body: JSON.stringify({ session_id: "foreign-session", generation_id: "foreign-generation", idempotency_key: "foreign-assignment" }) });
			assert.equal(foreignAssignment.status, 404, "foreign canonical assignment target is rejected at the HTTP boundary");
			const foreignControl = await fetch(`${server.origin}/api/v1/management/control`, { method: "POST", headers, body: JSON.stringify({ session_id: "foreign-session", generation_id: "foreign-generation", command: "brief", payload: {}, idempotency_key: "foreign-control" }) });
			assert.equal(foreignControl.status, 404, "foreign canonical control target is rejected at the HTTP boundary");
			const auditResponse = await fetch(`${server.origin}/api/v1/management/audit`, { headers });
			assert.equal(auditResponse.status, 200);
			assert.equal(JSON.stringify(await auditResponse.json()).includes("retry-secret"), false, "HTTP audit output does not expose actor secrets");
		} finally {
			await server.close();
		}
		assert.equal(management.roles.list("mgmt-project")[0].revision, revisionBeforeForeign, "rejected foreign targets do not mutate role state");
		await opened.writer.close();
		opened = open(home, "-restart");
		assert.equal(opened.management.controls.list("mgmt-project").length, 2, "control and role-assignment operations survive restart");
		assert.equal(opened.management.gates.list("mgmt-project")[0].status, "approved");
		assert.equal(opened.management.ideas.list("mgmt-project")[0].promotedTicketId, promotedA.promotedTicketId);
		assert.equal(opened.management.roles.list("mgmt-project")[0].name, "operator");
	} finally {
		if (opened) await opened.writer.close();
		home.cleanup();
		assert.equal(fs.existsSync(home.root), false);
	}
});

test("ticket assets are bounded, authorized, symlink-safe, and restart durable", async () => {
	const home = createTemporaryHome("golem-j6-assets-");
	let opened;
	try {
		opened = open(home);
		const ticket = opened.core.tickets.create({ projectId: "asset-project", kind: "work-item", title: "asset ticket", body: "asset", actor: "human:manager" });
		const bytes = new TextEncoder().encode("safe asset");
		const stored = opened.management.assets.put({ projectId: "asset-project", ticketId: ticket.id, relativePath: "proofs/fixture.txt", mimeType: "image/png", bytes, actor: "human:manager" });
		assert.deepEqual(
			opened.management.assets.list({
				projectId: "asset-project",
				ticketId: ticket.id,
			}).map((asset) => asset.id),
			[stored.id],
			"asset metadata can be enumerated only within its canonical ticket scope",
		);
		assert.throws(
			() =>
				opened.management.assets.list({
					projectId: "other-project",
					ticketId: ticket.id,
				}),
			(error) =>
				error instanceof TrackerManagementError &&
				error.code === "management.forbidden",
			"foreign project asset enumeration is refused",
		);
		assert.equal(opened.management.assets.read({ projectId: "asset-project", ticketId: ticket.id, assetId: stored.id }).bytes.byteLength, bytes.byteLength);
		assert.throws(() => opened.management.assets.put({ projectId: "asset-project", ticketId: ticket.id, relativePath: "../escape", mimeType: "image/png", bytes, actor: "human:manager" }), (error) => error instanceof TrackerManagementError && error.code === "management.asset_invalid");
		assert.throws(() => opened.management.assets.put({ projectId: "asset-project", ticketId: ticket.id, relativePath: "bad.txt", mimeType: "text/plain", bytes, actor: "human:manager" }), (error) => error instanceof TrackerManagementError && error.code === "management.asset_invalid");
		const root = path.join(home.root, "assets", "asset-project", ticket.id);
		fs.mkdirSync(root, { recursive: true });
		fs.symlinkSync(home.root, path.join(root, "linked"));
		assert.throws(() => opened.management.assets.put({ projectId: "asset-project", ticketId: ticket.id, relativePath: "linked/escape.png", mimeType: "image/png", bytes, actor: "human:manager" }), (error) => error instanceof TrackerManagementError && error.code === "management.asset_invalid");
		const proofDirectory = path.join(root, "proofs");
		const outsideDirectory = path.join(home.root, "asset-outside");
		fs.renameSync(proofDirectory, path.join(root, "proofs-real"));
		fs.mkdirSync(outsideDirectory, { recursive: true });
		fs.writeFileSync(path.join(outsideDirectory, "fixture.txt"), "escaped asset");
		fs.symlinkSync(outsideDirectory, proofDirectory);
		assert.throws(() => opened.management.assets.read({ projectId: "asset-project", ticketId: ticket.id, assetId: stored.id }), (error) => error instanceof TrackerManagementError && error.code === "management.not_found", "parent-directory symlink swaps are rejected");
		fs.unlinkSync(proofDirectory);
		fs.renameSync(path.join(root, "proofs-real"), proofDirectory);
		assert.throws(() => opened.management.assets.read({ projectId: "other-project", ticketId: ticket.id, assetId: stored.id }), (error) => error instanceof TrackerManagementError && error.code === "management.not_found");
		await opened.writer.close();
		opened = open(home, "-restart");
		assert.deepEqual([...opened.management.assets.read({ projectId: "asset-project", ticketId: ticket.id, assetId: stored.id }).bytes], [...bytes]);
	} finally {
		if (opened) await opened.writer.close();
		home.cleanup();
		assert.equal(fs.existsSync(home.root), false);
	}
});
