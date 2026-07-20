import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import websocket from "@fastify/websocket";
import Fastify from "fastify";

import {
	type BrowserSessionAuthority,
	createBrowserSessionAuthority,
	isExpectedHost,
} from "./auth.js";
import {
	createLegacyCompatibilitySource,
	type LegacyCompatibilityPort,
	registerLegacyWebSocket,
	registerStaticCompatibility,
} from "./compatibility.js";
import { fail, registerErrorEnvelope } from "./errors.js";
import type {
	ControlPlaneProjectionPort,
	ControlPlaneReplayPort,
	RuntimeHealthPort,
	RuntimeIngressPort,
} from "./ports.js";
import { registerValidatedRoutes } from "./routes.js";
import type { ControlPlaneStream } from "./schemas.js";
import { acquireServiceLock } from "./service-lock.js";
import {
	BoundedReplayWindow,
	type ControlPlaneSocket,
	registerWsReplay,
} from "./ws-replay.js";

export interface ControlPlaneLifecycleOptions {
	readonly token: string;
	readonly stateDirectory: string;
	readonly staticDirectory: string;
	readonly host?: "127.0.0.1";
	readonly port?: number;
	readonly projection?: ControlPlaneProjectionPort;
	readonly replay?: ControlPlaneReplayPort;
	readonly legacyCompatibility?: LegacyCompatibilityPort;
	/** Optional until the Wave-5 runtime composition becomes the service main. */
	readonly runtimeIngress?: RuntimeIngressPort;
	readonly runtimeHealth?: RuntimeHealthPort;
	/** Injectable only for bounded composition and deterministic journey clocks. */
	readonly browserSessions?: BrowserSessionAuthority;
	readonly replayWindowSize?: number;
	readonly invalidResponseForTest?: boolean;
}

export interface StartedControlPlane {
	readonly origin: string;
	readonly instanceId: string;
	readonly lockPath: string;
	close(): Promise<void>;
}

function defaultProjection(): ControlPlaneProjectionPort {
	return {
		read: () => ({}),
		revision: () => 0,
	};
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
	const projection = options.projection ?? defaultProjection();
	const replay =
		options.replay ?? new BoundedReplayWindow(options.replayWindowSize ?? 32);
	const legacyCompatibility =
		options.legacyCompatibility ?? createLegacyCompatibilitySource();
	const sessions = options.browserSessions ?? createBrowserSessionAuthority();
	const sockets = new Set<ControlPlaneSocket>();
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
	let closeTypedReplay: () => void = () => {};
	let closeLegacyWebSocket: () => void = () => {};

	try {
		await app.register(websocket);
		app.addHook("onRequest", async (request, reply) => {
			if (isExpectedHost(request.headers.host)) return;
			return fail(
				request,
				reply,
				400,
				"host.invalid",
				"loopback Host header is required",
			);
		});
		registerErrorEnvelope(app);
		registerValidatedRoutes({
			app,
			token: options.token,
			instanceId,
			projection,
			replay,
			legacy: legacyCompatibility,
			sessions,
			...(options.runtimeIngress
				? { runtimeIngress: options.runtimeIngress }
				: {}),
			...(options.runtimeHealth
				? { runtimeHealth: options.runtimeHealth }
				: {}),
			...(options.invalidResponseForTest === undefined
				? {}
				: { invalidResponseForTest: options.invalidResponseForTest }),
		});
		closeTypedReplay = registerWsReplay({
			app,
			instanceId,
			token: options.token,
			replay,
			read: (stream: ControlPlaneStream) => projection.read(stream),
			revision: (stream: ControlPlaneStream) => projection.revision(stream),
			sessions,
			sockets,
		});
		closeLegacyWebSocket = registerLegacyWebSocket({
			app,
			source: legacyCompatibility,
		});
		await registerStaticCompatibility({
			app,
			staticDirectory: path.resolve(options.staticDirectory),
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
				closeTypedReplay();
				closeLegacyWebSocket();
				for (const socket of sockets)
					socket.close(1001, "service shutting down");
				await app.close();
				lock.release();
			},
		});
	} catch (error) {
		closeTypedReplay();
		closeLegacyWebSocket();
		lock.release();
		throw error;
	}
}

export function controlPlanePortFromEnvironment(value: unknown): number {
	if (typeof value !== "string") return 0;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65_535
		? parsed
		: 0;
}

export function controlPlaneLockPath(stateDirectory: string): string {
	return path.join(stateDirectory, "control-plane.lock");
}
