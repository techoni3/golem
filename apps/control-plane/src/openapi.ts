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

export function controlPlaneOpenApiDocument(): JsonRecord {
	return {
		openapi: "3.1.1",
		info: { title: "Golem control plane", version: "v1" },
		paths: {
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
