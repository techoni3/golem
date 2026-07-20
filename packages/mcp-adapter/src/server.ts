import type { ApiClientBoundary } from "@golem/api-client";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { invokeMcpTool } from "./adapter.js";
import { listMcpTools } from "./catalog.js";

export interface RunningMcpServer {
	close(): Promise<void>;
}

export async function startMcpServer(
	client: ApiClientBoundary,
): Promise<RunningMcpServer> {
	const server = new Server(
		{ name: "golem", version: "1.0.0" },
		{ capabilities: { tools: {} } },
	);
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: listMcpTools(),
	}));
	server.setRequestHandler(
		CallToolRequestSchema,
		async (request) =>
			(await invokeMcpTool(
				client,
				request.params.name,
				request.params.arguments ?? {},
			)) as never,
	);
	const transport = new StdioServerTransport();
	await server.connect(transport);
	return {
		async close() {
			await server.close();
			await transport.close();
		},
	};
}
