import type { ApiClientBoundary } from "@golem/api-client";

import { toolCatalog } from "./catalog.js";
import type { McpToolResult } from "./types.js";

function error(tool: string, code: string): McpToolResult {
	return {
		isError: true,
		content: [
			{
				type: "text",
				text: JSON.stringify({
					schema_version: "golem.mcp-error/v1",
					tool,
					code,
				}),
			},
		],
	};
}

function text(value: unknown): McpToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/** Validate one public MCP tool then delegate it through the injected API port. */
export async function invokeMcpTool(
	client: ApiClientBoundary,
	name: string,
	input: unknown,
): Promise<McpToolResult> {
	const definition = toolCatalog.find((candidate) => candidate.name === name);
	if (!definition) return error(name, "mcp.tool.unknown");
	const parsed = definition.schema.safeParse(input);
	if (!parsed.success) return error(name, "mcp.input.invalid");
	const caller = client.caller;
	if (
		(name.startsWith("ticket_") &&
			(!caller.projectId ||
				(((name === "ticket_list" && parsed.data.mine === true) ||
					name === "ticket_create" ||
					name === "ticket_update" ||
					name === "ticket_transition" ||
					name.startsWith("ticket_comment") ||
					name === "subscribe" ||
					name === "unsubscribe") &&
					!caller.sessionId))) ||
		((name === "subscribe" || name === "unsubscribe") &&
			(!caller.sessionId || !caller.projectId))
	)
		return error(name, "mcp.caller.required");
	try {
		const request = definition.request({
			...parsed.data,
			__golem_trusted_caller: client.caller,
		});
		if (!request) return text({ ok: true });
		const response = await client.request(request);
		if (response.status < 200 || response.status >= 300)
			return error(name, "mcp.api.rejected");
		return text(response.body);
	} catch {
		return error(name, "mcp.api.unavailable");
	}
}
