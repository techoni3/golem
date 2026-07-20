import {
	createFetchApiClient,
	type TrustedCallerContext,
} from "@golem/api-client";

import { startMcpServer } from "./server.js";

const controlPlaneUrl =
	process.env.GOLEM_CONTROL_PLANE_URL ||
	"http://dashboard.golem.localhost:7420";
const callerSessionId =
	process.env.GOLEM_MCP_CALLER_SESSION_ID ||
	process.env.GOLEM_CEO_SESSION_ID ||
	process.env.CLAUDE_CODE_SESSION_ID;
const callerProjectId =
	process.env.GOLEM_MCP_CALLER_PROJECT_ID || process.env.GOLEM_PROJECT_ID;
const caller: TrustedCallerContext = callerSessionId
	? callerProjectId
		? { sessionId: callerSessionId, projectId: callerProjectId }
		: { sessionId: callerSessionId }
	: callerProjectId
		? { projectId: callerProjectId }
		: {};

const running = await startMcpServer(
	createFetchApiClient(controlPlaneUrl, {
		...(process.env.GOLEM_CONTROL_PLANE_BEARER
			? { bearerToken: process.env.GOLEM_CONTROL_PLANE_BEARER }
			: {}),
		caller,
	}),
);
let closing = false;

async function shutdown(): Promise<void> {
	if (closing) return;
	closing = true;
	await running.close();
	process.exit(0);
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
