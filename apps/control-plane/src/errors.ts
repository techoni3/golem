import crypto from "node:crypto";

import { ApiErrorV1Schema } from "@golem/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";

function correlationId(request: FastifyRequest): string {
	const candidate = request.headers["x-correlation-id"];
	return typeof candidate === "string" &&
		candidate.length > 0 &&
		candidate.length <= 128
		? candidate
		: `corr_${crypto.randomUUID()}`;
}

export function errorEnvelope(
	request: FastifyRequest,
	code: string,
	message: string,
	details?: Record<string, unknown>,
) {
	return ApiErrorV1Schema.parse({
		schema_version: "golem.api-error/v1",
		code,
		message,
		correlation_id: correlationId(request),
		...(details ? { details } : {}),
	});
}

export function fail(
	request: FastifyRequest,
	reply: FastifyReply,
	statusCode: number,
	code: string,
	message: string,
	details?: Record<string, unknown>,
) {
	return reply
		.code(statusCode)
		.send(errorEnvelope(request, code, message, details));
}

export function sendValidated<T extends z.ZodType>(
	request: FastifyRequest,
	reply: FastifyReply,
	schema: T,
	value: unknown,
) {
	const parsed = schema.safeParse(value);
	if (!parsed.success)
		return fail(
			request,
			reply,
			500,
			"response.invalid",
			"typed control-plane response could not be completed",
		);
	return reply.send(parsed.data);
}

export function registerErrorEnvelope(app: FastifyInstance): void {
	app.setErrorHandler((error, request, reply) => {
		const statusCandidate =
			typeof error === "object" && error !== null && "statusCode" in error
				? error.statusCode
				: undefined;
		const statusCode =
			typeof statusCandidate === "number" &&
			statusCandidate >= 400 &&
			statusCandidate < 500
				? statusCandidate
				: 500;
		return fail(
			request,
			reply,
			statusCode,
			statusCode === 500 ? "response.invalid" : "request.invalid",
			statusCode === 500
				? "typed control-plane response could not be completed"
				: "typed control-plane request is invalid",
		);
	});
}
