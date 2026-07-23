import type { ApiClientRequest, TrustedCallerContext } from "@golem/api-client";

import type { McpInputSchema, McpToolDefinition } from "./types.js";

/** The stable public names retained from the legacy channel MCP. */
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

type Field =
	| { readonly type: "string"; readonly minLength?: number }
	| { readonly type: "boolean" }
	| { readonly type: "integer" }
	| { readonly type: "array"; readonly items: Field }
	| { readonly type: "enum"; readonly values: readonly string[] }
	| { readonly type: "null" }
	| { readonly type: "anyOf"; readonly values: readonly Field[] };

type FieldMap = Readonly<Record<string, Field>>;

const apiResultSchema = {
	anyOf: [
		{ $ref: "urn:golem:contracts:api-command-outcome:v1" },
		{ $ref: "urn:golem:contracts:api-page:v1" },
		{ type: "object" },
		{ type: "array" },
	],
};

const apiErrorSchema = { $ref: "urn:golem:contracts:api-error:v1" };

const string = (minLength?: number): Field =>
	minLength === undefined ? { type: "string" } : { type: "string", minLength };
const boolean: Field = { type: "boolean" };
const integer: Field = { type: "integer" };
const nullableString: Field = {
	type: "anyOf",
	values: [string(), { type: "null" }],
};
const nullableInteger: Field = {
	type: "anyOf",
	values: [integer, { type: "null" }],
};
const stringArray: Field = { type: "array", items: string() };
const phase: Field = {
	type: "enum",
	values: [
		"queued",
		"building",
		"blocked",
		"built",
		"verifying",
		"verified",
		"rejected",
		"done",
		"parked",
	],
};

function fieldSchema(field: Field): Record<string, unknown> {
	if (field.type === "array")
		return { type: "array", items: fieldSchema(field.items) };
	if (field.type === "enum") return { type: "string", enum: field.values };
	if (field.type === "anyOf") return { anyOf: field.values.map(fieldSchema) };
	const schema: Record<string, unknown> = { type: field.type };
	if (field.type === "string" && field.minLength)
		schema.minLength = field.minLength;
	return schema;
}

function accepts(value: unknown, field: Field): boolean {
	if (field.type === "string")
		return (
			typeof value === "string" &&
			(field.minLength === undefined || value.trim().length >= field.minLength)
		);
	if (field.type === "boolean") return typeof value === "boolean";
	if (field.type === "integer") return Number.isInteger(value);
	if (field.type === "null") return value === null;
	if (field.type === "array")
		return (
			Array.isArray(value) && value.every((item) => accepts(item, field.items))
		);
	if (field.type === "enum")
		return typeof value === "string" && field.values.includes(value);
	return field.values.some((candidate) => accepts(value, candidate));
}

function exactSchema(
	fields: FieldMap,
	required: readonly string[] = [],
): McpInputSchema {
	return {
		safeParse(input) {
			if (!input || typeof input !== "object" || Array.isArray(input))
				return { success: false, error: "mcp.input.object" };
			const data = input as Record<string, unknown>;
			for (const key of Object.keys(data))
				if (!(key in fields))
					return { success: false, error: `mcp.input.unknown:${key}` };
			for (const key of required)
				if (!(key in data) || !fields[key] || !accepts(data[key], fields[key]))
					return { success: false, error: `mcp.input.required:${key}` };
			for (const [key, value] of Object.entries(data))
				if (!fields[key] || !accepts(value, fields[key]))
					return { success: false, error: `mcp.input.invalid:${key}` };
			return { success: true, data };
		},
	};
}

function query(path: string, values: Record<string, unknown>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined || value === null || value === false) continue;
		search.set(key, String(value));
	}
	const encoded = search.toString();
	return encoded ? `${path}?${encoded}` : path;
}

function trustedCaller(input: Record<string, unknown>): TrustedCallerContext {
	const candidate = input.__golem_trusted_caller;
	if (!candidate || typeof candidate !== "object") return {};
	const caller = candidate as TrustedCallerContext;
	return {
		...(typeof caller.sessionId === "string"
			? { sessionId: caller.sessionId }
			: {}),
		...(typeof caller.projectId === "string"
			? { projectId: caller.projectId }
			: {}),
	};
}

function defined(input: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(input).filter(([, value]) => value !== undefined),
	);
}

function projectFor(input: Record<string, unknown>): string | undefined {
	// Scope selection is server-owned. Retain old tool fields for schema
	// compatibility, but never serialize model/composition project metadata into
	// the HTTP request: the durable bearer binding supplies the active scope.
	void input;
	return undefined;
}

function definition(input: {
	readonly name: (typeof legacyToolNames)[number];
	readonly description: string;
	readonly fields: FieldMap;
	readonly required?: readonly string[];
	readonly request: (
		input: Record<string, unknown>,
	) => ApiClientRequest | undefined;
}): McpToolDefinition {
	return {
		name: input.name,
		description: input.description,
		inputSchema: {
			type: "object",
			properties: Object.fromEntries(
				Object.entries(input.fields).map(([name, field]) => [
					name,
					fieldSchema(field),
				]),
			),
			...(input.required?.length ? { required: input.required } : {}),
			additionalProperties: false,
		},
		resultSchema: apiResultSchema,
		errorSchema: apiErrorSchema,
		schema: exactSchema(input.fields, input.required),
		request: input.request,
	};
}

const ticketFields = { id: string() } as const;

/**
 * Exact compatibility routing: inputs are validated here, before the injected
 * API port is called. These definitions deliberately contain no tracker or
 * identity logic; composition supplies any trusted actor fields.
 */
export const toolCatalog: readonly McpToolDefinition[] = [
	definition({
		name: "ack",
		description: "Acknowledge a correlated control envelope.",
		fields: {
			kind: string(),
			gate_id: string(),
			envelope_id: string(),
			summary: string(),
		},
		required: ["kind", "summary"],
		request: (input) => {
			if (typeof input.envelope_id !== "string") return undefined;
			return {
				method: "POST",
				path: `/api/message-envelopes/${encodeURIComponent(input.envelope_id)}/ack`,
				body: defined({
					kind: input.kind,
					summary: input.summary,
					target_session_id: trustedCaller(input).sessionId,
				}),
			};
		},
	}),
	definition({
		name: "respond",
		description: "Reply to a correlated control envelope.",
		fields: {
			text: string(),
			kind: string(),
			gate_id: string(),
			envelope_id: string(),
		},
		required: ["text"],
		request: (input) => {
			if (typeof input.envelope_id !== "string") return undefined;
			return {
				method: "POST",
				path: `/api/message-envelopes/${encodeURIComponent(input.envelope_id)}/reply`,
				body: defined({
					kind: input.kind ?? "brief",
					text: input.text,
					target_session_id: trustedCaller(input).sessionId,
				}),
			};
		},
	}),
	definition({
		name: "ticket_list",
		description: "List tracker tickets.",
		fields: {
			project: string(),
			all: boolean,
			mine: boolean,
			state: string(),
			assignee: nullableString,
			kind: string(),
		},
		request: (input) => ({
			method: "GET",
			path: query("/api/v1/tracker/tickets", {
				project: input.all ? undefined : projectFor(input),
				assignee: input.mine ? trustedCaller(input).sessionId : input.assignee,
				state: input.state,
				kind: input.kind,
			}),
		}),
	}),
	definition({
		name: "ticket_get",
		description: "Fetch one tracker ticket.",
		fields: ticketFields,
		required: ["id"],
		request: (input) => ({
			method: "GET",
			path: `/api/v1/tracker/tickets/${encodeURIComponent(String(input.id))}`,
		}),
	}),
	definition({
		name: "ticket_create",
		description: "Create a tracker ticket.",
		fields: {
			idempotency_key: string(),
			title: string(),
			body: string(),
			kind: string(),
			priority: string(),
			state: string(),
			labels: stringArray,
			stream_id: string(),
			parent_id: string(),
			wave: nullableInteger,
			assignee: nullableString,
			project: string(),
		},
		required: ["title"],
		request: (input) => ({
			method: "POST",
			path: "/api/v1/tracker/tickets",
			body: defined({
				project_id: projectFor(input),
				idempotency_key: input.idempotency_key,
				title: input.title,
				body: input.body,
				kind: input.kind,
				priority: input.priority,
				state: input.state,
				labels: input.labels,
				stream_id: input.stream_id,
				parent_id: input.parent_id,
				wave: input.wave,
				assignee: input.assignee,
			}),
		}),
	}),
	definition({
		name: "ticket_update",
		description: "Patch tracker ticket metadata.",
		fields: {
			...ticketFields,
			expected_revision: integer,
			state: string(),
			title: string(),
			body: string(),
			kind: string(),
			priority: string(),
			labels: stringArray,
			stream_id: string(),
			parent_id: string(),
			wave: nullableInteger,
			assignee: nullableString,
			idempotency_key: string(),
		},
		required: ["id"],
		request: (input) => ({
			method: "PATCH",
			path: `/api/v1/tracker/tickets/${encodeURIComponent(String(input.id))}`,
			body: defined({
				expected_revision: input.expected_revision,
				state: input.state,
				title: input.title,
				body: input.body,
				kind: input.kind,
				priority: input.priority,
				labels: input.labels,
				stream_id: input.stream_id,
				parent_id: input.parent_id,
				wave: input.wave,
				assignee: input.assignee,
				idempotency_key: input.idempotency_key,
			}),
		}),
	}),
	definition({
		name: "ticket_transition",
		description: "Move a ticket through the enforced phase machine.",
		fields: {
			...ticketFields,
			expected_revision: integer,
			phase,
			reason: string(),
			skip_reason: string(),
			idempotency_key: string(),
		},
		required: ["id", "phase"],
		request: (input) => ({
			method: "POST",
			path: `/api/v1/tracker/tickets/${encodeURIComponent(String(input.id))}/transition`,
			body: defined({
				expected_revision: input.expected_revision,
				phase: input.phase,
				reason: input.reason,
				skip_reason: input.skip_reason,
				idempotency_key: input.idempotency_key,
			}),
		}),
	}),
	definition({
		name: "ticket_comment",
		description: "Add a tracker comment.",
		fields: {
			...ticketFields,
			body: string(),
			quote: string(),
			prefix: string(),
			suffix: string(),
			section: string(),
			section_id: string(),
			tag: string(),
			status: string(),
			parent_id: string(),
			idempotency_key: string(),
		},
		required: ["id", "body"],
		request: (input) => ({
			method: "POST",
			path: `/api/v1/tracker/tickets/${encodeURIComponent(String(input.id))}/comments`,
			body: defined({
				body: input.body,
				quote: input.quote,
				prefix: input.prefix,
				suffix: input.suffix,
				section: input.section,
				section_id: input.section_id,
				tag: input.tag,
				status: input.status,
				parent_id: input.parent_id,
				idempotency_key: input.idempotency_key,
			}),
		}),
	}),
	definition({
		name: "ticket_comment_update",
		description: "Update a tracker comment.",
		fields: {
			...ticketFields,
			comment_id: string(),
			body: string(),
			tag: string(),
			status: string(),
			idempotency_key: string(),
		},
		required: ["id", "comment_id"],
		request: (input) => ({
			method: "PATCH",
			path: `/api/v1/tracker/tickets/${encodeURIComponent(String(input.id))}/comments/${encodeURIComponent(String(input.comment_id))}`,
			body: defined({ body: input.body, tag: input.tag, status: input.status, idempotency_key: input.idempotency_key }),
		}),
	}),
	definition({
		name: "ticket_comment_reply",
		description: "Reply to a tracker comment.",
		fields: {
			...ticketFields,
			comment_id: string(),
			body: string(),
			idempotency_key: string(),
		},
		required: ["id", "comment_id", "body"],
		request: (input) => ({
			method: "POST",
			path: `/api/v1/tracker/tickets/${encodeURIComponent(String(input.id))}/comments/${encodeURIComponent(String(input.comment_id))}/reply`,
			body: defined({
				body: input.body,
				idempotency_key: input.idempotency_key,
			}),
		}),
	}),
	definition({
		name: "ticket_dispatch",
		description:
			"Queue canonical tracker delivery for the ticket's current assignee. session_id is a legacy hint only.",
		fields: {
			...ticketFields,
			session_id: string(),
			expected_revision: integer,
			idempotency_key: string(),
			note: string(),
			when_idle: boolean,
			workspace: string(),
		},
		required: ["id"],
		request: (input) => ({
			method: "POST",
			path: `/api/v1/tracker/tickets/${encodeURIComponent(String(input.id))}/dispatch`,
			body: defined({
				session_id: input.session_id,
				expected_revision: input.expected_revision,
				idempotency_key: input.idempotency_key,
			}),
		}),
	}),
	definition({
		name: "stream_create",
		description: "Create a project stream.",
		fields: {
			project: string(),
			name: string(),
			mode: { type: "enum", values: ["sequential", "parallel"] },
			description: string(),
			idempotency_key: string(),
		},
		required: ["name"],
		request: (input) => ({
			method: "POST",
			path: "/api/v1/tracker/streams",
			body: defined({
				project_id: projectFor(input),
				name: input.name,
				mode: input.mode,
				description: input.description,
				idempotency_key: input.idempotency_key,
			}),
		}),
	}),
	definition({
		name: "stream_list",
		description: "List project streams.",
		fields: { project: string() },
		request: (input) => ({
			method: "GET",
			path: query("/api/v1/tracker/streams", { project: projectFor(input) }),
		}),
	}),
	definition({
		name: "sessions_dispatchable",
		description: "List dispatchable sessions.",
		fields: { project: string() },
		request: (input) => ({
			method: "GET",
			path: query("/api/sessions/dispatchable", { project: projectFor(input) }),
		}),
	}),
	definition({
		name: "subscribe",
		description: "Create a durable subscription.",
		fields: { topic: string(), classes: stringArray },
		required: ["topic"],
		request: (input) => ({
			method: "POST",
			path: "/api/v1/subscriptions",
			body: defined({
				name: `mcp:${trustedCaller(input).sessionId ?? "caller"}:${input.topic as string}`,
				recipient_id: trustedCaller(input).sessionId,
				topic: input.topic,
				classes: input.classes,
			}),
		}),
	}),
	definition({
		name: "unsubscribe",
		description: "Remove a durable subscription.",
		fields: { topic: string() },
		required: ["topic"],
		request: (input) => ({
			method: "POST",
			path: "/api/v1/subscriptions/unsubscribe",
			body: defined({
				topic: input.topic,
			}),
		}),
	}),
	definition({
		name: "subscriptions_list",
		description: "List durable subscriptions.",
		fields: {},
		request: (_input) => ({
			method: "GET",
			path: "/api/v1/subscriptions",
		}),
	}),
	definition({
		name: "session_notify",
		description: "Notify one live session through the control plane.",
		fields: {
			to: string(),
			text: string(),
			ticket: string(),
		},
		required: ["to", "text"],
		request: (input) => ({
			method: "POST",
			path: "/api/messages/notify",
			body: defined({
				session_id: input.to,
				text: input.ticket ? `${input.ticket}: ${input.text}` : input.text,
				sender_id: trustedCaller(input).sessionId,
				project_id: trustedCaller(input).projectId,
			}),
		}),
	}),
	definition({
		name: "session_role",
		description: "Set one session role.",
		fields: {
			role: string(),
		},
		required: ["role"],
		request: (input) => ({
			method: "POST",
			path: `/api/sessions/${encodeURIComponent(String(trustedCaller(input).sessionId))}/role`,
			body: { role: input.role === "clear" ? null : input.role },
		}),
	}),
	definition({
		name: "consult_request",
		description: "Deliver a consult request through the control plane.",
		fields: {
			to: string(),
			question: string(),
			context: string(),
		},
		required: ["to", "question"],
		request: (input) => ({
			method: "POST",
			path: "/api/messages/control",
			body: defined({
				session_id: input.to,
				sender_id: trustedCaller(input).sessionId,
				kind: "consult_request",
				content: input.question,
				metadata: { context: input.context ?? "" },
				project_id: trustedCaller(input).projectId,
			}),
		}),
	}),
	definition({
		name: "consult_reply",
		description: "Deliver a consult reply through the control plane.",
		fields: {
			to_session: string(),
			text: string(),
			consult_id: string(),
		},
		required: ["to_session", "text"],
		request: (input) => ({
			method: "POST",
			path: "/api/messages/control",
			body: defined({
				session_id: input.to_session,
				sender_id: trustedCaller(input).sessionId,
				kind: "consult_reply",
				content: input.text,
				metadata: { consult_id: input.consult_id },
				project_id: trustedCaller(input).projectId,
			}),
		}),
	}),
	definition({
		name: "consult_status",
		description: "Deliver a consult status request through the control plane.",
		fields: {
			to: string(),
			consult_id: string(),
			note: string(),
		},
		required: ["to"],
		request: (input) => ({
			method: "POST",
			path: "/api/messages/control",
			body: defined({
				session_id: input.to,
				sender_id: trustedCaller(input).sessionId,
				kind: "consult_status",
				content: input.note ?? "",
				metadata: { consult_id: input.consult_id },
				project_id: trustedCaller(input).projectId,
			}),
		}),
	}),
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
