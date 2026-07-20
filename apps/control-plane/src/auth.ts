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
	/** A browser WebSocket proves same-origin session possession, never CSRF. */
	validSocket(request: FastifyRequest): boolean;
}

export interface BrowserSessionClock {
	now(): number;
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
	let result: string | undefined;
	for (const part of cookies.split(";")) {
		const separator = part.indexOf("=");
		if (separator < 1) continue;
		const key = part.slice(0, separator).trim();
		const value = part.slice(separator + 1).trim();
		if (key !== name) continue;
		if (!value || value.includes("=") || result) return undefined;
		result = value;
	}
	return result;
}

export function isExpectedHost(host: string | undefined): boolean {
	return Boolean(host && /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/u.test(host));
}

export function isExpectedOrigin(
	origin: string | undefined,
	request: FastifyRequest,
): boolean {
	const host = request.headers.host;
	if (!origin || !host || !isExpectedHost(host)) return false;
	const protocol = request.protocol;
	if (protocol !== "http" && protocol !== "https") return false;
	return constantTimeEqual(origin, `${protocol}://${host}`);
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
	readonly clock?: BrowserSessionClock;
	readonly maxSessions?: number;
	readonly ttlMs?: number;
}): BrowserSessionAuthority {
	const clock = options?.clock ?? Date;
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

	function validSession(request: FastifyRequest): BrowserSession | undefined {
		if (!isExpectedOrigin(request.headers.origin, request)) return undefined;
		const identifier = cookieValue(request, sessionCookieName);
		if (!identifier) return undefined;
		expire(clock.now());
		return sessions.get(identifier);
	}

	return Object.freeze({
		create: () => {
			const now = clock.now();
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
			const csrf = request.headers["x-golem-csrf"];
			if (typeof csrf !== "string") return false;
			const session = validSession(request);
			return Boolean(session && constantTimeEqual(session.csrf, csrf));
		},
		validSocket: (request: FastifyRequest) => Boolean(validSession(request)),
	});
}
