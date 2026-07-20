import type { ApiClientBoundary } from "@golem/api-client";

import { toolCatalog } from "./catalog.js";
import type { McpToolResult } from "./types.js";

function error(text: string): McpToolResult {
	return { isError: true, content: [{ type: "text", text }] };
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
	if (!definition) return error(`unknown tool: ${name}`);
	const parsed = definition.schema.safeParse(input);
	if (!parsed.success) return error(`${name}: validation failed`);
	try {
		const response = await client.request({
			method: definition.method,
			path: definition.path(parsed.data),
			...(definition.method === "POST" ? { body: parsed.data } : {}),
		});
		if (response.status < 200 || response.status >= 300)
			return error(`${name}: API request failed (${response.status})`);
		return text(response.body);
	} catch (cause) {
		return error(
			`${name}: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
	}
}
