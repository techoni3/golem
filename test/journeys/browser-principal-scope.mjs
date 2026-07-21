import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTemporaryHome } from "@golem/testkit";
import { createFetchApiClient } from "../../packages/api-client/dist/index.js";
import { invokeMcpTool } from "../../packages/mcp-adapter/dist/index.js";
import {
	createBrowserPrincipalResolver,
	composeControlPlaneTrackerCoreServices,
	composeControlPlaneTrackerServices,
	startControlPlane,
} from "../../apps/control-plane/dist/index.js";
import { openControlPlanePersistence } from "../../apps/control-plane/dist/persistence.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const alphaToken = "golem-principal-alpha-token-000000000000";
const betaToken = "golem-principal-beta-token-0000000000000";

function json(response) {
	return response.json().then((body) => ({ status: response.status, body }));
}

function cookie(response) {
	const value = response.headers.get("set-cookie");
	if (!value) throw new Error("browser bootstrap did not issue a cookie");
	return value.split(";", 1)[0];
}

function browserHeaders(origin, session, csrf) {
	return {
		origin,
		cookie: session,
		"x-golem-csrf": csrf,
		"content-type": "application/json",
	};
}

export async function exerciseBrowserPrincipalScopeAuthority() {
	const home = createTemporaryHome("golem-gol78-principal-");
	const staticRoot = path.join(home.root, "static");
	fs.mkdirSync(staticRoot, { recursive: true });
	fs.writeFileSync(path.join(staticRoot, "index.html"), "<!doctype html><title>principal</title>\n");
	let now = Date.parse("2026-07-21T00:00:00.000Z");
	const clock = {
		now: () => new Date(now).toISOString(),
		after: (milliseconds) => new Date(now + milliseconds).toISOString(),
	};
	const writer = openControlPlanePersistence({
		runtimePath: home.runtimeDb,
		trackerPath: home.trackerDb,
		lockPath: path.join(home.root, "owner.lock"),
	}, { clock, ownerId: "gol78-principal-journey" });
	const principals = writer.browserPrincipalStorage();
	principals.provision({
		id: "principal_local_operator",
		actorId: "human:local-operator",
		role: "operator",
		defaultProjectId: "project-alpha",
		scopeProjectIds: ["project-alpha"],
	});
	principals.provision({
		id: "principal_beta_operator",
		actorId: "human:beta-operator",
		role: "operator",
		defaultProjectId: "project-beta",
		scopeProjectIds: ["project-beta"],
	});
	principals.bindCredential({ bindingId: "principal_local_operator", adapter: "bearer", credential: alphaToken });
	principals.bindCredential({ bindingId: "principal_beta_operator", adapter: "bearer", credential: betaToken });
	principals.bindCredential({ bindingId: "principal_local_operator", adapter: "mcp", credential: "mcp-alpha" });
	principals.bindCredential({ bindingId: "principal_local_operator", adapter: "internal", credential: "internal-alpha" });
	const resolver = createBrowserPrincipalResolver({
		storage: principals,
		localOperatorBindingId: "principal_local_operator",
		clock: { now: () => now },
		ttlMs: 1_000,
	});
	const core = composeControlPlaneTrackerCoreServices({ writer, clock });
	const services = composeControlPlaneTrackerServices({ writer, clock, eligibility: { resolve: () => undefined } });
	let service;
	try {
		service = await startControlPlane({
			token: alphaToken,
			stateDirectory: path.join(home.root, "control-plane"),
			staticDirectory: staticRoot,
			trackerCore: core,
			trackerServices: services,
			principalResolver: resolver,
		});
		const origin = service.origin;
		const missing = await json(await fetch(`${origin}/api/v1/tracker/tickets`));
		assert.equal(missing.status, 401, "missing bindings fail closed");
		assert.equal(missing.body.code, "browser.auth.required");
		const bootstrapResponse = await fetch(`${origin}/api/v1/browser/session`, { method: "POST", headers: { origin } });
		const bootstrap = await json(bootstrapResponse);
		assert.equal(bootstrap.status, 200, "server-configured local binding alone can bootstrap a browser cookie");
		const session = cookie(bootstrapResponse);
		const csrf = bootstrap.body.csrf_token;
		const created = await json(await fetch(`${origin}/api/v1/tracker/tickets`, {
			method: "POST",
			headers: browserHeaders(origin, session, csrf),
			body: JSON.stringify({ title: "Alpha browser ticket", kind: "work-item" }),
		}));
		assert.equal(created.status, 201, "durable browser principal performs a policy-permitted mutation");
		const alphaTicket = created.body.result;
		const betaCreate = await json(await fetch(`${origin}/api/v1/tracker/tickets`, {
			method: "POST",
			headers: { authorization: `Bearer ${betaToken}`, "content-type": "application/json" },
			body: JSON.stringify({ title: "Beta scoped ticket", kind: "work-item" }),
		}));
		assert.equal(betaCreate.status, 201, "durably bound bearer resolves its server-owned scope");
		const betaTicket = betaCreate.body.result;
		const betaCommentCreate = await json(await fetch(`${origin}/api/v1/tracker/tickets/${betaTicket.id}/comments`, {
			method: "POST",
			headers: { authorization: `Bearer ${betaToken}`, "content-type": "application/json" },
			body: JSON.stringify({ body: "beta-owned parent comment" }),
		}));
		assert.equal(betaCommentCreate.status, 201, "the beta bearer can create its own parent comment");
		const betaComment = betaCommentCreate.body.result;
		const auditBeforeForgery = writer.trackerCoreStorage().auditCore().length;
		const forged = await json(await fetch(`${origin}/api/v1/tracker/tickets`, {
			method: "POST",
			headers: {
				...browserHeaders(origin, session, csrf),
				"x-golem-caller-project": "project-beta",
			},
			body: JSON.stringify({ title: "forged", actor: "human:forged", role: "manager", project_id: "project-beta", approval: "yes", fence: 99, storage: "override" }),
		}));
		assert.equal(forged.status, 403, "request authority overrides are rejected before service execution");
		assert.equal(forged.body.code, "browser.forbidden");
		assert.equal(JSON.stringify(forged.body).includes("human:forged"), false, "forged actor is never reflected");
		assert.equal(writer.trackerCoreStorage().auditCore().length, auditBeforeForgery, "forged browser request causes no audit or write");
		const browserCrossDetail = await json(await fetch(`${origin}/api/v1/tracker/tickets/${betaTicket.id}`, { headers: browserHeaders(origin, session, csrf) }));
		assert.equal(browserCrossDetail.status, 404, "cross-project browser detail is indistinguishable from absent");
		assert.equal(JSON.stringify(browserCrossDetail.body).includes(betaTicket.id), false, "cross-project detail does not disclose its target");
		const browserCrossCommand = await json(await fetch(`${origin}/api/v1/tracker/tickets/${betaTicket.id}/comments`, {
			method: "POST",
			headers: browserHeaders(origin, session, csrf),
			body: JSON.stringify({ body: "must not reach beta" }),
		}));
		assert.equal(browserCrossCommand.status, 404, "cross-project browser command is non-disclosing");
		const betaCommentCountBeforeReply = core.compatibility.getTicket(betaTicket.id).comments.length;
		const auditBeforeCrossReply = writer.trackerCoreStorage().auditCore().length;
		const bearerCrossReply = await json(await fetch(`${origin}/api/v1/tracker/tickets/${betaTicket.id}/comments/${betaComment.id}/reply`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${alphaToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ body: "alpha must not reply to beta" }),
		}));
		assert.equal(bearerCrossReply.status, 404, "cross-project typed reply is non-disclosing");
		assert.equal(bearerCrossReply.body.code, "tracker.not_found");
		assert.equal(JSON.stringify(bearerCrossReply.body).includes(betaTicket.id), false, "cross-project reply does not disclose its target");
		assert.equal(core.compatibility.getTicket(betaTicket.id).comments.length, betaCommentCountBeforeReply, "denied typed reply creates no comment");
		assert.equal(writer.trackerCoreStorage().auditCore().length, auditBeforeCrossReply, "denied typed reply creates no audit or outbox event");
		const legacyCrossDetail = await json(await fetch(`${origin}/api/tickets/${betaTicket.id}`, {
			headers: browserHeaders(origin, session, csrf),
		}));
		assert.equal(legacyCrossDetail.status, 404, "legacy compatibility detail shares the durable scope policy");
		assert.equal(JSON.stringify(legacyCrossDetail.body).includes(betaTicket.id), false, "legacy compatibility detail does not disclose its target");
		const legacyCrossCommand = await json(await fetch(`${origin}/api/tickets/${betaTicket.id}/comments`, {
			method: "POST",
			headers: browserHeaders(origin, session, csrf),
			body: JSON.stringify({ body: "must not reach beta through legacy compatibility" }),
		}));
		assert.equal(legacyCrossCommand.status, 404, "legacy compatibility command shares non-disclosing project scope");
		const alphaMcp = createFetchApiClient(origin, { bearerToken: alphaToken, caller: { projectId: "ignored", sessionId: "ignored" } });
		const mcpCross = await invokeMcpTool(alphaMcp, "ticket_get", { id: betaTicket.id });
		assert.equal(mcpCross.isError, true, "MCP shares the bearer resolver and cannot disclose a foreign ticket");
		assert.equal(mcpCross.content[0].text.includes(betaTicket.id), false, "MCP error does not serialize the foreign target");
		assert.equal(resolver.resolveMcp("mcp-alpha")?.source, "mcp", "MCP has the same durable context shape without trusting tool payload identity");
		const internal = resolver.resolveInternal("internal-alpha");
		assert.ok(internal, "internal adapters resolve through the same durable binding store");
		assert.equal(resolver.policy.allowsProject(internal, "project-beta"), false, "internal scope is not a broad default");
		now += 2_000;
		const expired = await json(await fetch(`${origin}/api/v1/tracker/tickets`, { headers: browserHeaders(origin, session, csrf) }));
		assert.equal(expired.status, 401, "expired browser sessions fail closed");
		assert.equal(expired.body.code, "browser.auth.required");
		principals.revokeBinding("principal_local_operator", new Date(now).toISOString());
		const revoked = await json(await fetch(`${origin}/api/v1/tracker/tickets`, { headers: { authorization: `Bearer ${alphaToken}` } }));
		assert.equal(revoked.status, 401, "revoked bearer binding fails closed after durable revocation");
		assert.equal(revoked.body.code, "browser.auth.required");
		assert.equal(alphaTicket.project_id, "project-alpha");
		return "real SQLite browser cookie/CSRF, bearer, MCP, and internal principal resolution fail closed and keep cross-project detail/commands non-disclosing";
	} finally {
		if (service) await service.close();
		await writer.close();
		home.cleanup();
		assert.equal(fs.existsSync(home.root), false, "principal journey removes its temporary SQLite home");
	}
}
