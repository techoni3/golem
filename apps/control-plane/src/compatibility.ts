import path from "node:path";

import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

import { fail } from "./errors.js";

const legacyColumns = [
	"triage",
	"open",
	"in-progress",
	"review",
	"blocked",
	"done",
] as const;

/** Keep the concrete legacy discovery surfaces available without importing legacy state. */
export async function registerStaticCompatibility(options: {
	readonly app: FastifyInstance;
	readonly staticDirectory: string;
}): Promise<void> {
	await options.app.register(fastifyStatic, {
		root: path.resolve(options.staticDirectory),
		prefix: "/",
		decorateReply: true,
	});
	options.app.get("/api/health", async () => ({
		ok: true,
		projects_root: null,
		project_count: 0,
		server_time: new Date().toISOString(),
	}));
	options.app.get("/api/meta", async () => ({
		roles: {},
		columns: legacyColumns,
		config: {
			projectsRoot: null,
			ideasRoot: null,
			golemRoot: null,
			channelUrl: null,
			agentActiveWindowMs: null,
			agentIdleTimeoutMs: null,
			ceoLiveWindowMs: null,
		},
	}));
	options.app.setNotFoundHandler((request, reply) => {
		if (
			request.method === "GET" &&
			request.headers.accept?.includes("text/html")
		)
			return reply.sendFile("index.html");
		return fail(
			request,
			reply,
			404,
			"route.not_found",
			"typed control-plane route was not found",
		);
	});
}
