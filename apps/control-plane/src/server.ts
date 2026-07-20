import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { ApiErrorV1Schema, WebSocketFrameV1Schema } from "@golem/contracts";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

import { controlPlaneOpenApiDocument } from "./openapi.js";
import {
	BrowserEchoBodySchema,
	BrowserEchoResponseSchema,
	BrowserSessionResponseSchema,
	type ControlPlaneStream,
	HealthResponseSchema,
	MetaResponseSchema,
	ProjectionParamsSchema,
	ProjectionResponseSchema,
} from "./schemas.js";
import { acquireServiceLock, type ServiceLock } from "./service-lock.js";

export interface ControlPlaneProjectionPort {
	read(stream: ControlPlaneStream): Record<string, unknown>;
	revision(stream: ControlPlaneStream): number;
}

export interface ControlPlaneLifecycleOptions {
	readonly token: string;
	readonly stateDirectory: string;
	readonly staticDirectory: string;
	readonly host?: "127.0.0.1";
	readonly port?: number;
	readonly projection?: ControlPlaneProjectionPort;
}

export interface StartedControlPlane {
	readonly origin: string;
	readonly instanceId: string;
	readonly lockPath: string;
	close(): Promise<void>;
}

interface Session {
	readonly csrf: string;
}

const streams = [
	"runtime.live",
	"runtime.history",
	"runtime.diagnostics",
	"projects",
	"tracker.tree",
	"tracker.board",
	"communication.operations",
] as const satisfies readonly ControlPlaneStream[];

function correlationId(request: FastifyRequest): string {
	const candidate = request.headers["x-correlation-id"];
	return typeof candidate === "string" &&
		candidate.length > 0 &&
		candidate.length <= 128
		? candidate
		: `corr_${crypto.randomUUID()}`;
}

function errorEnvelope(
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

function fail(
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

function originFor(request: FastifyRequest): string {
	return `http://127.0.0.1:${request.socket.localPort ?? 0}`;
}

function isExpectedHost(host: string | undefined): boolean {
	if (!host) return false;
	return /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/u.test(host);
}

function isExpectedOrigin(
	origin: string | undefined,
	request: FastifyRequest,
): boolean {
	if (!origin) return false;
	try {
		const value = new URL(origin);
		return (
			(value.hostname === "127.0.0.1" || value.hostname === "localhost") &&
			value.port === String(request.socket.localPort ?? "")
		);
	} catch {
		return false;
	}
}

function bearerIsValid(request: FastifyRequest, token: string): boolean {
	const authorization = request.headers.authorization;
	if (typeof authorization !== "string") return false;
	const match = /^Bearer ([^\s]+)$/u.exec(authorization);
	return match?.[1] === token;
}

function cookieValue(
	request: FastifyRequest,
	name: string,
): string | undefined {
	const cookies = request.headers.cookie;
	if (!cookies) return undefined;
	for (const part of cookies.split(";")) {
		const [key, value] = part.trim().split("=", 2);
		if (key === name && value) return value;
	}
	return undefined;
}

function sessionIsValid(
	request: FastifyRequest,
	sessions: ReadonlyMap<string, Session>,
): boolean {
	const identifier = cookieValue(request, "golem_control_plane_session");
	const csrf = request.headers["x-golem-csrf"];
	return Boolean(
		identifier &&
			typeof csrf === "string" &&
			sessions.get(identifier)?.csrf === csrf,
	);
}

function defaultProjection(): ControlPlaneProjectionPort {
	return {
		read: () => ({}),
		revision: () => 0,
	};
}

function parsePort(value: unknown): number {
	if (typeof value !== "string") return 0;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65_535
		? parsed
		: 0;
}

function frame(
	instanceId: string,
	stream: ControlPlaneStream,
	sequence: number,
	revision: number,
	payload: Record<string, unknown>,
) {
	return WebSocketFrameV1Schema.parse({
		schema_version: "golem.websocket-frame/v1",
		instance_id: instanceId,
		stream,
		sequence,
		resource_revision: revision,
		correlation_id: `corr_${crypto.randomUUID()}`,
		payload,
	});
}

export async function startControlPlane(
	options: ControlPlaneLifecycleOptions,
): Promise<StartedControlPlane> {
	if (options.host && options.host !== "127.0.0.1")
		throw new Error("control plane may bind only to 127.0.0.1");
	if (options.token.trim().length < 24)
		throw new Error(
			"control plane bearer token must contain at least 24 characters",
		);
	if (!fs.existsSync(options.staticDirectory))
		throw new Error(
			`control plane static directory does not exist: ${options.staticDirectory}`,
		);

	const lock = acquireServiceLock(options.stateDirectory);
	const instanceId = `cpi_${crypto.randomUUID()}`;
	const sessions = new Map<string, Session>();
	const projection = options.projection ?? defaultProjection();
	const sockets = new Set<{
		close(code?: number, data?: string): void;
		send(data: string): void;
	}>();
	const app = Fastify({
		logger: {
			level: "warn",
			redact: [
				"req.headers.authorization",
				"req.headers.cookie",
				"res.headers.set-cookie",
			],
		},
		disableRequestLogging: true,
	});
	let closed = false;

	try {
		await app.register(websocket);
		await app.register(fastifyStatic, {
			root: path.resolve(options.staticDirectory),
			prefix: "/",
			decorateReply: true,
		});

		app.addHook("onRequest", async (request, reply) => {
			if (!isExpectedHost(request.headers.host))
				return fail(
					request,
					reply,
					400,
					"host.invalid",
					"loopback Host header is required",
				);
			if (
				["POST", "PUT", "PATCH", "DELETE"].includes(request.method) &&
				request.url.startsWith("/api/v1/") &&
				!isExpectedOrigin(request.headers.origin, request)
			)
				return fail(
					request,
					reply,
					403,
					"origin.invalid",
					"loopback Origin header is required",
				);
		});
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

		app.get("/api/v1/health/live", async (_request, _reply) =>
			HealthResponseSchema.parse({
				schema_version: "golem.control-plane-health/v1",
				status: "live",
				instance_id: instanceId,
			}),
		);

		app.get("/api/v1/health/ready", async (request, reply) => {
			if (!bearerIsValid(request, options.token))
				return fail(
					request,
					reply,
					401,
					"auth.invalid",
					"a valid bearer token is required",
				);
			return HealthResponseSchema.parse({
				schema_version: "golem.control-plane-health/v1",
				status: "ready",
				instance_id: instanceId,
			});
		});

		app.get("/api/v1/meta", async (request, reply) => {
			if (!bearerIsValid(request, options.token))
				return fail(
					request,
					reply,
					401,
					"auth.invalid",
					"a valid bearer token is required",
				);
			return MetaResponseSchema.parse({
				schema_version: "golem.control-plane-meta/v1",
				instance_id: instanceId,
				service: "control-plane",
				projections: streams,
			});
		});

		app.get("/api/v1/openapi.json", async (request, reply) => {
			if (!bearerIsValid(request, options.token))
				return fail(
					request,
					reply,
					401,
					"auth.invalid",
					"a valid bearer token is required",
				);
			return controlPlaneOpenApiDocument();
		});

		app.get("/api/v1/projections/:stream", async (request, reply) => {
			if (!bearerIsValid(request, options.token))
				return fail(
					request,
					reply,
					401,
					"auth.invalid",
					"a valid bearer token is required",
				);
			const parsed = ProjectionParamsSchema.safeParse(request.params);
			if (!parsed.success)
				return fail(
					request,
					reply,
					400,
					"request.invalid",
					"projection stream is invalid",
				);
			const stream = parsed.data.stream;
			return ProjectionResponseSchema.parse({
				schema_version: "golem.control-plane-projection/v1",
				stream,
				resource_revision: projection.revision(stream),
				payload: projection.read(stream),
			});
		});

		app.post("/api/v1/browser/session", async (request, reply) => {
			if (!bearerIsValid(request, options.token))
				return fail(
					request,
					reply,
					401,
					"auth.invalid",
					"a valid bearer token is required",
				);
			const identifier = crypto.randomUUID();
			const csrf = crypto.randomBytes(32).toString("base64url");
			sessions.set(identifier, { csrf });
			reply.header(
				"set-cookie",
				`golem_control_plane_session=${identifier}; HttpOnly; SameSite=Strict; Path=/`,
			);
			return BrowserSessionResponseSchema.parse({
				schema_version: "golem.control-plane-browser-session/v1",
				csrf_token: csrf,
			});
		});

		app.post("/api/v1/browser/echo", async (request, reply) => {
			if (!sessionIsValid(request, sessions))
				return fail(
					request,
					reply,
					403,
					"csrf.invalid",
					"a valid browser session and CSRF token are required",
				);
			const parsed = BrowserEchoBodySchema.safeParse(request.body);
			if (!parsed.success)
				return fail(
					request,
					reply,
					400,
					"request.invalid",
					"browser echo body is invalid",
				);
			return BrowserEchoResponseSchema.parse({
				schema_version: "golem.control-plane-browser-echo/v1",
				value: parsed.data.value,
			});
		});

		app.get("/ws", { websocket: true }, (socket, request) => {
			if (
				!isExpectedHost(request.headers.host) ||
				!bearerIsValid(request, options.token)
			) {
				socket.close(1008, "authentication required");
				return;
			}
			const url = new URL(request.url, originFor(request));
			const parsed = ProjectionParamsSchema.safeParse({
				stream: url.searchParams.get("stream") ?? "runtime.live",
			});
			if (!parsed.success) {
				socket.close(1008, "stream invalid");
				return;
			}
			const stream = parsed.data.stream;
			const suppliedInstance = url.searchParams.get("instance_id");
			const cursor = url.searchParams.get("cursor");
			const revision = projection.revision(stream);
			const payload =
				!suppliedInstance || !cursor
					? { kind: "snapshot", cursor: "0", payload: projection.read(stream) }
					: suppliedInstance !== instanceId
						? {
								kind: "resync_required",
								reason: "instance_changed",
								snapshot_url: `${originFor(request)}/api/v1/projections/${stream}`,
							}
						: cursor === "0"
							? { kind: "delta", cursor: "1", delta: {} }
							: {
									kind: "resync_required",
									reason: "cursor_gap",
									snapshot_url: `${originFor(request)}/api/v1/projections/${stream}`,
								};
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
			socket.send(
				JSON.stringify(frame(instanceId, stream, 0, revision, payload)),
			);
		});

		app.setNotFoundHandler((request, reply) => {
			if (
				request.method === "GET" &&
				request.headers.accept?.includes("text/html")
			)
				return reply.sendFile("index.html");
			return fail(
				request,
				reply,
				404,
				"route.not_found",
				"typed control-plane route was not found",
			);
		});

		const address = await app.listen({
			host: "127.0.0.1",
			port: options.port ?? 0,
		});
		const origin = address.replace("localhost", "127.0.0.1");
		return Object.freeze({
			origin,
			instanceId,
			lockPath: lock.path,
			close: async () => {
				if (closed) return;
				closed = true;
				for (const socket of sockets)
					socket.close(1001, "service shutting down");
				await app.close();
				lock.release();
			},
		});
	} catch (error) {
		lock.release();
		throw error;
	}
}

export function controlPlanePortFromEnvironment(value: unknown): number {
	return parsePort(value);
}

export function controlPlaneLockPath(stateDirectory: string): string {
	return path.join(stateDirectory, "control-plane.lock");
}

export function releaseServiceLock(lock: ServiceLock): void {
	lock.release();
}
