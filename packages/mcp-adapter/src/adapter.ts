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

function typedConflictCode(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const code = (value as { readonly code?: unknown }).code;
	return code === "tracker.conflict" ||
		code === "delivery.conflict" ||
		code === "bus.conflict"
		? code
		: undefined;
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
	try {
		const request = definition.request({
			...parsed.data,
			__golem_trusted_caller: client.caller,
		});
		if (!request) return text({ ok: true });
		const response = await client.request(request);
		if (response.status < 200 || response.status >= 300)
			return error(
				name,
				response.status === 409
					? (typedConflictCode(response.body) ?? "mcp.api.rejected")
					: "mcp.api.rejected",
			);
		return text(response.body);
	} catch {
		return error(name, "mcp.api.unavailable");
	}
}
