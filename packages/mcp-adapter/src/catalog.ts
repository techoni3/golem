import { JsonObjectSchema } from "@golem/contracts";

import type { McpInputSchema, McpToolDefinition } from "./types.js";

export const legacyToolNames = [
	"ack",
	"consult_reply",
	"consult_request",
	"consult_status",
	"respond",
	"session_notify",
	"session_role",
	"sessions_dispatchable",
	"stream_create",
	"stream_list",
	"subscribe",
	"subscriptions_list",
	"ticket_comment",
	"ticket_comment_reply",
	"ticket_comment_update",
	"ticket_create",
	"ticket_dispatch",
	"ticket_get",
	"ticket_list",
	"ticket_transition",
	"ticket_update",
	"unsubscribe",
] as const;

function objectSchema(required: readonly string[] = []): McpInputSchema {
	return {
		safeParse(input) {
			const parsed = JsonObjectSchema.safeParse(input);
			if (!parsed.success) return { success: false, error: parsed.error };
			for (const key of required) {
				if (typeof parsed.data[key] !== "string" || !parsed.data[key])
					return { success: false, error: `mcp.input.required:${key}` };
			}
			return { success: true, data: parsed.data };
		},
	};
}

const genericSchema = objectSchema();
const ticketGetSchema = objectSchema(["id"]);
const ticketCreateSchema = objectSchema(["title"]);

function genericDefinition(name: string): McpToolDefinition {
	return {
		name,
		description: `Golem compatibility tool: ${name}. Inputs are validated before API delegation.`,
		inputSchema: { type: "object", additionalProperties: true },
		schema: genericSchema,
		method: "POST",
		path: () => `/api/mcp/${encodeURIComponent(name)}`,
	};
}

export const toolCatalog: readonly McpToolDefinition[] = [
	{
		name: "ticket_get",
		description: "Golem tracker — fetch one ticket by its public id.",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string", minLength: 1 } },
			required: ["id"],
			additionalProperties: false,
		},
		schema: ticketGetSchema,
		method: "GET",
		path: (input) => `/api/tickets/${encodeURIComponent(String(input.id))}`,
	},
	{
		name: "ticket_create",
		description:
			"Golem tracker — create a ticket after validating the write request.",
		inputSchema: {
			type: "object",
			properties: { title: { type: "string", minLength: 1 } },
			required: ["title"],
			additionalProperties: true,
		},
		schema: ticketCreateSchema,
		method: "POST",
		path: () => "/api/tickets",
	},
	...legacyToolNames
		.filter((name) => name !== "ticket_get" && name !== "ticket_create")
		.map(genericDefinition),
];

export function listMcpTools(): readonly {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
}[] {
	return toolCatalog.map(({ name, description, inputSchema }) => ({
		name,
		description,
		inputSchema,
	}));
}
