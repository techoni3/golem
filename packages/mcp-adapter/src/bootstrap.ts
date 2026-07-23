import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
// Provenance is established by the server's durable `adapter: "mcp"` binding,
// not by which compatible environment spelling supplied the credential.
function localCredential(): string | undefined {
	const configured = process.env.GOLEM_CONTROL_PLANE_TOKEN_FILE;
	const home =
		process.env.GOLEM_HOME ??
		(process.env.XDG_CONFIG_HOME
			? path.join(process.env.XDG_CONFIG_HOME, "golem")
			: path.join(os.homedir(), ".golem"));
	const target = configured?.trim()
		? configured
		: path.join(home, "control-plane", "service-token");
	try {
		return fs.readFileSync(target, "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}
const mcpCredential =
	process.env.GOLEM_CONTROL_PLANE_MCP_CREDENTIAL ||
	process.env.GOLEM_CONTROL_PLANE_BEARER ||
	localCredential();
const caller: TrustedCallerContext = callerSessionId
	? callerProjectId
		? { sessionId: callerSessionId, projectId: callerProjectId }
		: { sessionId: callerSessionId }
	: callerProjectId
		? { projectId: callerProjectId }
		: {};

const running = await startMcpServer(
	createFetchApiClient(controlPlaneUrl, {
		...(mcpCredential ? { bearerToken: mcpCredential } : {}),
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
