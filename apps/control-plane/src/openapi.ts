import { z } from "zod";

import {
	ApiErrorResponseJsonSchema,
	BrowserEchoBodySchema,
	BrowserEchoResponseSchema,
	BrowserSessionResponseSchema,
	HealthResponseSchema,
	MetaResponseSchema,
	ProjectionResponseSchema,
	RuntimeIngestReceiptSchema,
	RuntimeIngestRequestSchema,
	RuntimeProjectionResponseSchema,
} from "./schemas.js";

type JsonRecord = Record<string, unknown>;

function schema(value: z.ZodType): JsonRecord {
	return z.toJSONSchema(value, {
		target: "draft-2020-12",
		unrepresentable: "any",
		reused: "inline",
	}) as JsonRecord;
}

function response(description: string, value: z.ZodType): JsonRecord {
	return {
		description,
		content: { "application/json": { schema: schema(value) } },
	};
}

const error = ApiErrorResponseJsonSchema;
const managementResult = {
	type: "object",
	additionalProperties: true,
	properties: {
		schema_version: { type: "string", const: "golem.management/v1" },
		result: {},
	},
	required: ["schema_version", "result"],
};

function managementResponses() {
	return {
		"200": {
			description: "management result",
			content: { "application/json": { schema: managementResult } },
		},
		"201": {
			description: "management result",
			content: { "application/json": { schema: managementResult } },
		},
		"400": {
			description: "invalid management request",
			content: { "application/json": { schema: error } },
		},
		"401": {
			description: "unauthorized",
			content: { "application/json": { schema: error } },
		},
		"403": {
			description: "forbidden",
			content: { "application/json": { schema: error } },
		},
		"404": {
			description: "not found",
			content: { "application/json": { schema: error } },
		},
		"409": {
			description: "conflict",
			content: { "application/json": { schema: error } },
		},
	};
}

function typedApiResponses() {
	return {
		"200": {
			description: "typed result",
			content: {
				"application/json": {
					schema: { type: "object", additionalProperties: true },
				},
			},
		},
		"201": {
			description: "typed command accepted",
			content: {
				"application/json": {
					schema: { type: "object", additionalProperties: true },
				},
			},
		},
		"400": {
			description: "invalid request",
			content: { "application/json": { schema: error } },
		},
		"401": {
			description: "unauthorized",
			content: { "application/json": { schema: error } },
		},
		"403": {
			description: "caller rejected",
			content: { "application/json": { schema: error } },
		},
		"404": {
			description: "not found",
			content: { "application/json": { schema: error } },
		},
		"409": {
			description: "optimistic conflict",
			content: { "application/json": { schema: error } },
		},
	};
}

function typedApiPaths(): JsonRecord {
	const body = (
		schemaValue: JsonRecord = {
			type: "object",
			additionalProperties: true,
		},
	) => ({
		required: true,
		content: { "application/json": { schema: schemaValue } },
	});
	const compareAndSwapBody = {
		type: "object",
		additionalProperties: true,
		required: ["expected_revision"],
		properties: {
			expected_revision: { type: "integer", minimum: 1 },
		},
	};
	const path = (
		operationId: string,
		method: "get" | "post" | "patch",
		requestBody: false | true | JsonRecord = false,
	) => ({
		[method]: {
			operationId,
			...(requestBody
				? {
						requestBody: body(requestBody === true ? undefined : requestBody),
					}
				: {}),
			responses: typedApiResponses(),
		},
	});
	return {
		"/api/v1/tracker/tickets": {
			get: path("trackerListTickets", "get").get,
			post: path("trackerCreateTicket", "post", true).post,
		},
		"/api/v1/tracker/tickets/search": {
			get: path("trackerSearchTickets", "get").get,
		},
		"/api/v1/tracker/tickets/{id}": {
			get: path("trackerGetTicket", "get").get,
			patch: path("trackerUpdateTicket", "patch", compareAndSwapBody).patch,
		},
		"/api/v1/tracker/tickets/{id}/transition": {
			post: path("trackerTransitionTicket", "post", compareAndSwapBody).post,
		},
		"/api/v1/tracker/tickets/{id}/close": {
			post: path("trackerExceptionalClose", "post", true).post,
		},
		"/api/v1/tracker/tickets/{id}/comments": {
			post: path("trackerAddComment", "post", true).post,
		},
		"/api/v1/tracker/tickets/{id}/comments/{commentId}": {
			patch: path("trackerUpdateComment", "patch", true).patch,
		},
		"/api/v1/tracker/tickets/{id}/comments/{commentId}/reply": {
			post: path("trackerReplyComment", "post", true).post,
		},
		"/api/v1/tracker/streams": {
			get: path("trackerListStreams", "get").get,
			post: path("trackerUpsertStream", "post", true).post,
		},
		"/api/v1/delivery/envelopes": {
			post: path("deliveryEnqueue", "post", true).post,
		},
		"/api/v1/delivery/claims": {
			post: path("deliveryClaim", "post", true).post,
		},
		"/api/v1/delivery/claims/{token}/prepare": {
			post: path("deliveryPrepare", "post").post,
		},
		"/api/v1/delivery/claims/{token}/ack": {
			post: path("deliveryAcknowledge", "post", true).post,
		},
		"/api/v1/delivery/claims/{token}/delivered": {
			post: path("deliveryDelivered", "post").post,
		},
		"/api/v1/delivery/claims/{token}/fail": {
			post: path("deliveryFail", "post", true).post,
		},
		"/api/v1/bus/events": {
			get: path("busList", "get").get,
			post: path("busAppend", "post", true).post,
		},
		"/api/v1/subscriptions": {
			get: path("subscriptionsList", "get").get,
			post: path("subscriptionsCreate", "post", true).post,
		},
		"/api/v1/subscriptions/unsubscribe": {
			post: path("subscriptionsUnsubscribe", "post", true).post,
		},
		"/api/v1/subscriptions/{id}/pending": {
			get: path("subscriptionsPending", "get").get,
		},
		"/api/v1/subscriptions/{id}/commit": {
			post: path("subscriptionsCommit", "post", true).post,
		},
	};
}

export function controlPlaneOpenApiDocument(): JsonRecord {
	return {
		openapi: "3.1.1",
		info: { title: "Golem control plane", version: "v1" },
		paths: {
			...typedApiPaths(),
			"/api/v1/management/roles": {
				get: {
					operationId: "managementListRoles",
					parameters: [
						{
							name: "project_id",
							in: "query",
							required: true,
							schema: { type: "string" },
						},
					],
					responses: managementResponses(),
				},
				post: {
					operationId: "managementCreateRole",
					requestBody: {
						required: true,
						content: {
							"application/json": {
								schema: { type: "object", additionalProperties: true },
							},
						},
					},
					responses: managementResponses(),
				},
			},
			"/api/v1/management/roles/{role_id}/assign": {
				post: {
					operationId: "managementAssignRole",
					parameters: [
						{
							name: "role_id",
							in: "path",
							required: true,
							schema: { type: "string" },
						},
					],
					requestBody: {
						required: true,
						content: {
							"application/json": {
								schema: { type: "object", additionalProperties: true },
							},
						},
					},
					responses: managementResponses(),
				},
			},
			"/api/v1/management/gates": {
				get: {
					operationId: "managementListGates",
					parameters: [
						{
							name: "project_id",
							in: "query",
							required: true,
							schema: { type: "string" },
						},
					],
					responses: managementResponses(),
				},
				post: {
					operationId: "managementCreateGate",
					requestBody: {
						required: true,
						content: {
							"application/json": {
								schema: { type: "object", additionalProperties: true },
							},
						},
					},
					responses: managementResponses(),
				},
			},
			"/api/v1/management/gates/{gate_id}/verdict": {
				post: {
					operationId: "managementAnswerGate",
					parameters: [
						{
							name: "gate_id",
							in: "path",
							required: true,
							schema: { type: "string" },
						},
					],
					requestBody: {
						required: true,
						content: {
							"application/json": {
								schema: { type: "object", additionalProperties: true },
							},
						},
					},
					responses: managementResponses(),
				},
			},
			"/api/v1/management/ideas": {
				get: {
					operationId: "managementListIdeas",
					parameters: [
						{
							name: "project_id",
							in: "query",
							required: true,
							schema: { type: "string" },
						},
					],
					responses: managementResponses(),
				},
				post: {
					operationId: "managementCreateIdea",
					requestBody: {
						required: true,
						content: {
							"application/json": {
								schema: { type: "object", additionalProperties: true },
							},
						},
					},
					responses: managementResponses(),
				},
			},
			"/api/v1/management/ideas/{idea_id}/pop": {
				post: {
					operationId: "managementPopIdea",
					parameters: [
						{
							name: "idea_id",
							in: "path",
							required: true,
							schema: { type: "string" },
						},
					],
					requestBody: {
						required: true,
						content: {
							"application/json": {
								schema: { type: "object", additionalProperties: true },
							},
						},
					},
					responses: managementResponses(),
				},
			},
			"/api/v1/management/ideas/{idea_id}/promote": {
				post: {
					operationId: "managementPromoteIdea",
					parameters: [
						{
							name: "idea_id",
							in: "path",
							required: true,
							schema: { type: "string" },
						},
					],
					requestBody: {
						required: true,
						content: {
							"application/json": {
								schema: { type: "object", additionalProperties: true },
							},
						},
					},
					responses: managementResponses(),
				},
			},
			"/api/v1/management/communications": {
				post: {
					operationId: "managementCreateCommunication",
					requestBody: {
						required: true,
						content: {
							"application/json": {
								schema: { type: "object", additionalProperties: true },
							},
						},
					},
					responses: managementResponses(),
				},
			},
			"/api/v1/management/control": {
				get: {
					operationId: "managementListControls",
					parameters: [
						{
							name: "project_id",
							in: "query",
							required: true,
							schema: { type: "string" },
						},
					],
					responses: managementResponses(),
				},
				post: {
					operationId: "managementCreateControl",
					requestBody: {
						required: true,
						content: {
							"application/json": {
								schema: { type: "object", additionalProperties: true },
							},
						},
					},
					responses: managementResponses(),
				},
			},
			"/api/v1/management/control/{operation_id}": {
				get: {
					operationId: "managementGetControl",
					parameters: [
						{
							name: "operation_id",
							in: "path",
							required: true,
							schema: { type: "string" },
						},
						{
							name: "project_id",
							in: "query",
							required: true,
							schema: { type: "string" },
						},
					],
					responses: managementResponses(),
				},
			},
			"/api/v1/management/assets": {
				post: {
					operationId: "managementPutAsset",
					requestBody: {
						required: true,
						content: {
							"application/json": {
								schema: { type: "object", additionalProperties: true },
							},
						},
					},
					responses: managementResponses(),
				},
			},
			"/api/v1/management/assets/{asset_id}": {
				get: {
					operationId: "managementGetAsset",
					parameters: [
						{
							name: "asset_id",
							in: "path",
							required: true,
							schema: { type: "string" },
						},
						{
							name: "project_id",
							in: "query",
							required: true,
							schema: { type: "string" },
						},
						{
							name: "ticket_id",
							in: "query",
							required: true,
							schema: { type: "string" },
						},
					],
					responses: managementResponses(),
				},
			},
			"/api/v1/management/audit": {
				get: {
					operationId: "managementAudit",
					parameters: [
						{
							name: "project_id",
							in: "query",
							required: true,
							schema: { type: "string" },
						},
					],
					responses: managementResponses(),
				},
			},
			"/api/v1/runtime/events": {
				post: {
					operationId: "controlPlaneRuntimeIngest",
					requestBody: {
						required: true,
						content: {
							"application/json": {
								schema: schema(RuntimeIngestRequestSchema),
							},
						},
					},
					responses: {
						"202": response("durably spooled", RuntimeIngestReceiptSchema),
						"400": {
							description: "invalid runtime signal",
							content: { "application/json": { schema: error } },
						},
						"401": {
							description: "unauthorized",
							content: { "application/json": { schema: error } },
						},
						"503": {
							description: "runtime ingress unavailable",
							content: { "application/json": { schema: error } },
						},
					},
				},
			},
			"/api/v1/runtime/{stream}": {
				get: {
					operationId: "runtimeProjection",
					parameters: [
						{
							name: "stream",
							in: "path",
							required: true,
							schema: {
								type: "string",
								enum: ["live", "history", "diagnostics"],
							},
						},
						{
							name: "project_id",
							in: "query",
							required: false,
							schema: { type: "string", maxLength: 256 },
						},
						{
							name: "cursor",
							in: "query",
							required: false,
							schema: { type: "integer", minimum: 0, maximum: 1_000_000 },
						},
						{
							name: "limit",
							in: "query",
							required: false,
							schema: { type: "integer", minimum: 1, maximum: 100 },
						},
					],
					responses: {
						"200": response(
							"runtime projection",
							RuntimeProjectionResponseSchema,
						),
						"401": {
							description: "unauthorized",
							content: { "application/json": { schema: error } },
						},
						"400": {
							description: "invalid projection query",
							content: { "application/json": { schema: error } },
						},
						"503": {
							description: "runtime projection unavailable",
							content: { "application/json": { schema: error } },
						},
					},
				},
			},
			"/api/v1/health/live": {
				get: {
					operationId: "controlPlaneLive",
					responses: { "200": response("live", HealthResponseSchema) },
				},
			},
			"/api/v1/health/ready": {
				get: {
					operationId: "controlPlaneReady",
					responses: {
						"200": response("ready", HealthResponseSchema),
						"401": {
							description: "unauthorized",
							content: { "application/json": { schema: error } },
						},
					},
				},
			},
			"/api/v1/meta": {
				get: {
					operationId: "controlPlaneMeta",
					responses: {
						"200": response("metadata", MetaResponseSchema),
						"401": {
							description: "unauthorized",
							content: { "application/json": { schema: error } },
						},
					},
				},
			},
			"/api/v1/projections/{stream}": {
				get: {
					operationId: "controlPlaneProjection",
					parameters: [
						{
							name: "stream",
							in: "path",
							required: true,
							schema: { type: "string" },
						},
					],
					responses: {
						"200": response("projection", ProjectionResponseSchema),
						"401": {
							description: "unauthorized",
							content: { "application/json": { schema: error } },
						},
					},
				},
			},
			"/api/v1/browser/session": {
				post: {
					operationId: "controlPlaneBrowserSession",
					responses: {
						"200": response("browser session", BrowserSessionResponseSchema),
						"401": {
							description: "unauthorized",
							content: { "application/json": { schema: error } },
						},
					},
				},
			},
			"/api/v1/browser/echo": {
				post: {
					operationId: "controlPlaneBrowserEcho",
					requestBody: {
						required: true,
						content: {
							"application/json": { schema: schema(BrowserEchoBodySchema) },
						},
					},
					responses: {
						"200": response("echo", BrowserEchoResponseSchema),
						"400": {
							description: "invalid request",
							content: { "application/json": { schema: error } },
						},
						"401": {
							description: "unauthorized",
							content: { "application/json": { schema: error } },
						},
						"403": {
							description: "csrf failed",
							content: { "application/json": { schema: error } },
						},
						"409": {
							description: "canonical revision regressed",
							content: { "application/json": { schema: error } },
						},
					},
				},
			},
		},
	};
}

export function stableOpenApiJson(): string {
	return `${JSON.stringify(controlPlaneOpenApiDocument(), null, 2)}\n`;
}
