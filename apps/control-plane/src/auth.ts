import crypto from "node:crypto";

import type { FastifyRequest } from "fastify";

const sessionCookieName = "golem_control_plane_session";

interface BrowserSession {
	readonly csrf: string;
	readonly expiresAt: number;
}

export interface BrowserSessionAuthority {
	create(): { readonly csrf: string; readonly setCookie: string };
	validMutation(request: FastifyRequest): boolean;
}

function constantTimeEqual(left: string, right: string): boolean {
	const leftDigest = crypto.createHash("sha256").update(left).digest();
	const rightDigest = crypto.createHash("sha256").update(right).digest();
	return crypto.timingSafeEqual(leftDigest, rightDigest);
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

export function isExpectedHost(host: string | undefined): boolean {
	return Boolean(host && /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/u.test(host));
}

export function isExpectedOrigin(
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

/** Bearer clients are non-browser callers: they never require Origin or CSRF. */
export function bearerIsValid(request: FastifyRequest, token: string): boolean {
	const authorization = request.headers.authorization;
	if (typeof authorization !== "string") return false;
	const match = /^Bearer ([^\s]+)$/u.exec(authorization);
	const presented = match?.[1];
	return typeof presented === "string" && constantTimeEqual(presented, token);
}

export function createBrowserSessionAuthority(options?: {
	readonly maxSessions?: number;
	readonly ttlMs?: number;
}): BrowserSessionAuthority {
	const maxSessions = options?.maxSessions ?? 64;
	const ttlMs = options?.ttlMs ?? 10 * 60_000;
	if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 256)
		throw new Error(
			"browser session capacity must be an integer from 1 to 256",
		);
	if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 24 * 60 * 60_000)
		throw new Error("browser session TTL must be from one second to one day");
	const sessions = new Map<string, BrowserSession>();

	function expire(now: number): void {
		for (const [identifier, session] of sessions)
			if (session.expiresAt <= now) sessions.delete(identifier);
	}

	return Object.freeze({
		create: () => {
			const now = Date.now();
			expire(now);
			while (sessions.size >= maxSessions) {
				const oldest = sessions.keys().next().value;
				if (!oldest) break;
				sessions.delete(oldest);
			}
			const identifier = crypto.randomUUID();
			const csrf = crypto.randomBytes(32).toString("base64url");
			sessions.set(identifier, { csrf, expiresAt: now + ttlMs });
			return Object.freeze({
				csrf,
				setCookie: `${sessionCookieName}=${identifier}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(ttlMs / 1_000)}`,
			});
		},
		validMutation: (request: FastifyRequest) => {
			if (!isExpectedOrigin(request.headers.origin, request)) return false;
			const identifier = cookieValue(request, sessionCookieName);
			const csrf = request.headers["x-golem-csrf"];
			if (!identifier || typeof csrf !== "string") return false;
			const now = Date.now();
			expire(now);
			const session = sessions.get(identifier);
			return Boolean(session && constantTimeEqual(session.csrf, csrf));
		},
	});
}
