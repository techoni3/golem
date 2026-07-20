import { createFetchApiClient } from "@golem/api-client";

import { startMcpServer } from "./server.js";

const baseUrl = process.env.GOLEM_CONTROL_PLANE_URL;
if (!baseUrl)
	throw new Error(
		"GOLEM_CONTROL_PLANE_URL is required for the rendered MCP artifact",
	);

const running = await startMcpServer(createFetchApiClient(baseUrl));
let closing = false;

async function shutdown(): Promise<void> {
	if (closing) return;
	closing = true;
	await running.close();
	process.exit(0);
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
