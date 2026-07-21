import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createTemporaryHome } from "@golem/testkit";
import { openControlPlanePersistence } from "../../apps/control-plane/dist/persistence.js";
import { composeControlPlaneManagementServices, composeControlPlaneTrackerCoreServices } from "../../apps/control-plane/dist/index.js";
import { startControlPlane } from "../../apps/control-plane/dist/index.js";
import { TrackerManagementError } from "@golem/tracker";

function clock() {
	return { now: () => "2026-07-21T00:00:00.000Z", after: (ms) => new Date(Date.parse("2026-07-21T00:00:00.000Z") + ms).toISOString() };
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
		const role = management.roles.create({ projectId: "mgmt-project", name: "operator", actor: "human:manager", definition: { token: "do-not-persist", display: "Operator" } });
		const assignmentA = management.roles.assign({ projectId: "mgmt-project", roleId: role.id, sessionId: "session-one", actor: "human:manager", idempotencyKey: "assign-one" });
		const assignmentB = management.roles.assign({ projectId: "mgmt-project", roleId: role.id, sessionId: "session-one", actor: "human:manager", idempotencyKey: "assign-one" });
		assert.equal(assignmentA.id, assignmentB.id, "role assignment retry is idempotent");
		const gate = management.gates.create({ projectId: "mgmt-project", kind: "approval", question: "Approve deployment?", assignee: "human", actor: "human:manager", idempotencyKey: "gate-one" });
		assert.equal(gate.status, "awaiting", "human gates are never auto-answered");
		assert.equal(management.gates.answer({ projectId: "mgmt-project", gateId: gate.id, status: "approved", verdict: { approved: true }, actor: "human" }).status, "approved");
		const idea = management.ideas.create({ projectId: "mgmt-project", body: "Promote this idea", actor: "human:manager", idempotencyKey: "idea-one" });
		management.ideas.pop({ projectId: "mgmt-project", ideaId: idea.id, actor: "human:manager" });
		const promotedA = management.ideas.promote({ projectId: "mgmt-project", ideaId: idea.id, actor: "human:manager" });
		const promotedB = management.ideas.promote({ projectId: "mgmt-project", ideaId: idea.id, actor: "human:manager" });
		assert.equal(promotedA.promotedTicketId, promotedB.promotedTicketId, "idea promotion is exactly-once under retry");
		const operationA = management.controls.request({ projectId: "mgmt-project", command: "brief", payload: { token: "secret-value", message: "hello" }, actor: "human:manager", idempotencyKey: "control-one" });
		const operationB = management.controls.request({ projectId: "mgmt-project", command: "brief", payload: { token: "secret-value", message: "hello" }, actor: "human:manager", idempotencyKey: "control-one" });
		assert.equal(operationA.id, operationB.id, "control request retry is idempotent");
		assert.equal(JSON.stringify(operationA.payload).includes("secret-value"), false, "persisted operation payload redacts token values");
		assert.equal(JSON.stringify(management.audit("mgmt-project")).includes("do-not-persist"), false, "audit output remains redacted");
		const staticDirectory = path.join(home.root, "static");
		fs.mkdirSync(staticDirectory, { recursive: true });
		fs.writeFileSync(path.join(staticDirectory, "index.html"), "management fixture");
		const server = await startControlPlane({ token: "management-test-token-01234567890123456789", stateDirectory: path.join(home.root, "control-plane"), staticDirectory, management });
		try {
			const response = await fetch(`${server.origin}/api/v1/management/roles?project_id=mgmt-project`, { headers: { authorization: "Bearer management-test-token-01234567890123456789" } });
			assert.equal(response.status, 200);
			assert.equal((await response.json()).result[0].name, "operator", "the shipped management route delegates to typed storage");
		} finally {
			await server.close();
		}
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
		assert.equal(opened.management.assets.read({ projectId: "asset-project", ticketId: ticket.id, assetId: stored.id }).bytes.byteLength, bytes.byteLength);
		assert.throws(() => opened.management.assets.put({ projectId: "asset-project", ticketId: ticket.id, relativePath: "../escape", mimeType: "image/png", bytes, actor: "human:manager" }), (error) => error instanceof TrackerManagementError && error.code === "management.asset_invalid");
		assert.throws(() => opened.management.assets.put({ projectId: "asset-project", ticketId: ticket.id, relativePath: "bad.txt", mimeType: "text/plain", bytes, actor: "human:manager" }), (error) => error instanceof TrackerManagementError && error.code === "management.asset_invalid");
		const root = path.join(home.root, "assets", "asset-project", ticket.id);
		fs.mkdirSync(root, { recursive: true });
		fs.symlinkSync(home.root, path.join(root, "linked"));
		assert.throws(() => opened.management.assets.put({ projectId: "asset-project", ticketId: ticket.id, relativePath: "linked/escape.png", mimeType: "image/png", bytes, actor: "human:manager" }), (error) => error instanceof TrackerManagementError && error.code === "management.asset_invalid");
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
