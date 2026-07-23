import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import websocket from "@fastify/websocket";
import type { CommittedPublicationStorage } from "@golem/persistence";
import type {
	CommandGateway,
	TrackerCoreServices,
	TrackerManagementServices,
	TrackerServices,
} from "@golem/tracker";
import Fastify from "fastify";
import { registerApiV1Routes } from "./api-v1.js";
import {
	type BrowserPrincipalResolver,
	createFailClosedBrowserPrincipalResolver,
	isExpectedHost,
} from "./auth.js";
import { CommittedPublicationDispatcher } from "./committed-publication.js";
import {
	createLegacyCompatibilitySource,
	type LegacyCompatibilityPort,
	registerLegacyWebSocket,
	registerStaticCompatibility,
} from "./compatibility.js";
import { fail, registerErrorEnvelope } from "./errors.js";
import { registerManagementRoutes } from "./management-routes.js";
import type {
	ControlPlaneProjectionPort,
	ControlPlaneReplayPort,
	RuntimeHealthPort,
	RuntimeIngressPort,
	RuntimeProjectionPort,
} from "./ports.js";
import { registerValidatedRoutes } from "./routes.js";
import type { ControlPlaneStream } from "./schemas.js";
import { acquireServiceLock } from "./service-lock.js";
import { registerTrackerCoreCompatibilityRoutes } from "./tracker-core-routes.js";
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
	readonly runtimeProjection?: RuntimeProjectionPort;
	readonly replay?: ControlPlaneReplayPort;
	readonly legacyCompatibility?: LegacyCompatibilityPort;
	/** Optional until the Wave-5 runtime composition becomes the service main. */
	readonly runtimeIngress?: RuntimeIngressPort;
	readonly runtimeHealth?: RuntimeHealthPort;
	/** Server-owned durable authority. Omission is deliberately fail-closed. */
	readonly principalResolver?: BrowserPrincipalResolver;
	readonly replayWindowSize?: number;
	readonly invalidResponseForTest?: boolean;
	/** Typed management capability composed by the application owner. */
	readonly management?: TrackerManagementServices;
	/** Canonical tracker-core capability composed by the single persistence owner. */
	readonly trackerCore?: TrackerCoreServices;
	/** Durable delivery, bus, and subscription capabilities. */
	readonly trackerServices?: TrackerServices;
	/**
	 * One typed command gateway.  When present, every tracker/management
	 * mutation routes through it so a durable receipt/outcome/idempotency
	 * primitive backs every write path.  Omitted only by legacy journey
	 * fixtures that pre-date the gateway.
	 */
	readonly commandGateway?: CommandGateway;
	/** Persistence-owned committed invalidations; absent only in legacy fixtures. */
	readonly committedPublications?: CommittedPublicationStorage;
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
	const principal =
		options.principalResolver ?? createFailClosedBrowserPrincipalResolver();
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
	let publicationTimer: ReturnType<typeof setInterval> | undefined;

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
			...(options.runtimeProjection
				? { runtimeProjection: options.runtimeProjection }
				: {}),
			replay,
			legacy: legacyCompatibility,
			principal,
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
		if (options.trackerCore) {
			registerTrackerCoreCompatibilityRoutes({
				app,
				tracker: options.trackerCore.compatibility,
				principal,
				...(options.commandGateway ? { gateway: options.commandGateway } : {}),
			});
		}
		if (options.trackerCore && options.trackerServices)
			registerApiV1Routes({
				app,
				principal,
				core: options.trackerCore,
				services: options.trackerServices,
				...(options.commandGateway ? { gateway: options.commandGateway } : {}),
			});
		if (options.management)
			registerManagementRoutes({
				app,
				principal,
				management: options.management,
				...(options.commandGateway ? { gateway: options.commandGateway } : {}),
			});
		closeTypedReplay = registerWsReplay({
			app,
			instanceId,
			principal,
			replay,
			read: (stream: ControlPlaneStream, projectId?: string) =>
				projection.read(stream, projectId),
			revision: (stream: ControlPlaneStream, projectId?: string) =>
				projection.revision(stream, projectId),
			sockets,
		});
		if (options.committedPublications) {
			const dispatcher = new CommittedPublicationDispatcher({
				storage: options.committedPublications,
				replay,
				workerId: `control-plane-${process.pid}`,
				now: () => new Date().toISOString(),
			});
			dispatcher.drain();
			publicationTimer = setInterval(() => dispatcher.drain(), 25);
			publicationTimer.unref();
		}
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
				if (publicationTimer) clearInterval(publicationTimer);
				closeTypedReplay();
				closeLegacyWebSocket();
				for (const socket of sockets)
					socket.close(1001, "service shutting down");
				await app.close();
				lock.release();
			},
		});
	} catch (error) {
		if (publicationTimer) clearInterval(publicationTimer);
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
