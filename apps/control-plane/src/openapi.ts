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

export function controlPlaneOpenApiDocument(): JsonRecord {
	return {
		openapi: "3.1.1",
		info: { title: "Golem control plane", version: "v1" },
		paths: {
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
