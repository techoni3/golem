import path from "node:path";

import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

import { fail } from "./errors.js";

const legacyColumns = [
	"triage",
	"open",
	"in-progress",
	"review",
	"blocked",
	"done",
] as const;

export interface LegacyCompatibilityFrame {
	readonly type: string;
	readonly [key: string]: unknown;
}

export interface LegacyCompatibilitySource {
	snapshot(): Record<string, unknown>;
	subscribe(listener: (frame: LegacyCompatibilityFrame) => void): () => void;
}

export interface LegacyCompatibilityPublisher {
	publish(frame: LegacyCompatibilityFrame): void;
}

/**
 * The only legacy state bridge. Production can inject the real dashboard
 * source later; this shell deliberately owns neither dashboard state nor
 * tracker routes.
 */
export type LegacyCompatibilityPort = LegacyCompatibilitySource &
	LegacyCompatibilityPublisher;

export function createLegacyCompatibilitySource(
	initialSnapshot: Record<string, unknown> = {},
): LegacyCompatibilityPort {
	const listeners = new Set<(frame: LegacyCompatibilityFrame) => void>();
	let snapshot: Readonly<Record<string, unknown>> = Object.freeze({
		projects: [],
		native_sessions: [],
		channels: [],
		recent_milestones: [],
		tickets: [],
		streams: [],
		chat: [],
		...initialSnapshot,
	});
	return Object.freeze({
		snapshot: () => snapshot,
		subscribe: (listener: (frame: LegacyCompatibilityFrame) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		publish: (frame: LegacyCompatibilityFrame) => {
			if (!frame.type)
				throw new Error("legacy compatibility frames require type");
			if (frame.type === "snapshot" && frame.payload) {
				const payload = frame.payload;
				if (typeof payload === "object" && payload !== null)
					snapshot = Object.freeze({ ...snapshot, ...payload });
			}
			if (frame.type === "projects-list" && Array.isArray(frame.projects))
				snapshot = Object.freeze({ ...snapshot, projects: frame.projects });
			for (const listener of listeners) listener(Object.freeze({ ...frame }));
		},
	});
}

interface LegacySocket {
	on(
		event: "close" | "error" | "message",
		listener: (raw?: unknown) => void,
	): void;
	close(code?: number, data?: string): void;
	send(data: string): void;
}

/** Keep headerless dashboard clients on their existing top-level type protocol. */
export function registerLegacyWebSocket(options: {
	readonly app: FastifyInstance;
	readonly source: LegacyCompatibilitySource;
	readonly now?: () => number;
}): () => void {
	const sockets = new Set<LegacySocket>();
	const now = options.now ?? Date.now;
	const broadcast = (frame: LegacyCompatibilityFrame) => {
		for (const socket of sockets) {
			try {
				socket.send(JSON.stringify(frame));
			} catch {
				sockets.delete(socket);
			}
		}
	};
	const unsubscribe = options.source.subscribe(broadcast);
	options.app.get("/ws", { websocket: true }, (socket: LegacySocket) => {
		sockets.add(socket);
		try {
			socket.send(
				JSON.stringify({
					type: "snapshot",
					payload: options.source.snapshot(),
					ts: now(),
				}),
			);
		} catch {
			sockets.delete(socket);
			return;
		}
		socket.on("message", (raw) => {
			try {
				const message = JSON.parse(String(raw)) as { type?: unknown };
				if (message.type === "ping")
					socket.send(JSON.stringify({ type: "pong", ts: now() }));
			} catch {
				// Legacy clients may send malformed keepalive data; ignore it.
			}
		});
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => sockets.delete(socket));
	});
	return () => {
		unsubscribe();
		for (const socket of sockets) socket.close(1001, "service shutting down");
		sockets.clear();
	};
}

/** Keep the concrete legacy discovery surfaces available without importing legacy state. */
export async function registerStaticCompatibility(options: {
	readonly app: FastifyInstance;
	readonly staticDirectory: string;
}): Promise<void> {
	await options.app.register(fastifyStatic, {
		root: path.resolve(options.staticDirectory),
		prefix: "/",
		decorateReply: true,
	});
	options.app.get("/api/health", async () => ({
		ok: true,
		projects_root: null,
		project_count: 0,
		server_time: new Date().toISOString(),
	}));
	options.app.get("/api/meta", async () => ({
		roles: {},
		columns: legacyColumns,
		config: {
			projectsRoot: null,
			ideasRoot: null,
			golemRoot: null,
			channelUrl: null,
			agentActiveWindowMs: null,
			agentIdleTimeoutMs: null,
			ceoLiveWindowMs: null,
		},
	}));
	options.app.setNotFoundHandler((request, reply) => {
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
}
