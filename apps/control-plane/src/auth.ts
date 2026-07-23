import crypto from "node:crypto";

import type {
	BrowserPrincipalStorage,
	PrincipalAdapter,
	PrincipalBinding,
	PrincipalRole,
} from "@golem/persistence";
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

export interface ActorContext {
	readonly principalId: string;
	readonly actorId: string;
	readonly role: PrincipalRole;
	readonly defaultProjectId: string;
	readonly scopeProjectIds: readonly string[];
	readonly source: PrincipalAdapter;
	readonly bindingVersion: number;
}

export interface AuthorizationPolicy {
	allows(context: ActorContext, action: "read" | "mutate"): boolean;
	allowsProject(context: ActorContext, projectId: string): boolean;
}

export interface BrowserPrincipalResolver {
	bootstrap(
		request: FastifyRequest,
	):
		| { readonly ok: true; readonly csrf: string; readonly setCookie: string }
		| { readonly ok: false };
	resolve(
		request: FastifyRequest,
		input: {
			readonly action: "read" | "mutate";
			readonly allowBrowser: boolean;
			readonly allowBearer: boolean;
		},
	): ActorContext | undefined;
	resolveMcp(credential: string): ActorContext | undefined;
	resolveInternal(bindingId: string): ActorContext | undefined;
	policy: AuthorizationPolicy;
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

function actorContext(
	binding: PrincipalBinding,
	source: PrincipalAdapter,
): ActorContext {
	return Object.freeze({
		principalId: binding.id,
		actorId: binding.actorId,
		role: binding.role,
		defaultProjectId: binding.defaultProjectId,
		scopeProjectIds: binding.scopeProjectIds,
		source,
		bindingVersion: binding.version,
	});
}

function nowIso(clock: BrowserSessionClock): string {
	return new Date(clock.now()).toISOString();
}

/** All adapters get the same policy facts; request JSON/headers never supply
 * an actor, role, scope, or selected project. */
export function createAuthorizationPolicy(): AuthorizationPolicy {
	return Object.freeze({
		allows: (context: ActorContext, action: "read" | "mutate") =>
			action === "read" || context.role === "operator",
		allowsProject: (context: ActorContext, projectId: string) =>
			context.scopeProjectIds.includes(projectId),
	});
}

export function createFailClosedBrowserPrincipalResolver(): BrowserPrincipalResolver {
	return Object.freeze({
		policy: createAuthorizationPolicy(),
		bootstrap: () => Object.freeze({ ok: false }),
		resolve: () => undefined,
		resolveMcp: () => undefined,
		resolveInternal: () => undefined,
	});
}

/**
 * Durable browser/bearer principal resolver. The configured local binding is
 * server composition, not a request parameter; an absent, revoked, expired,
 * or unbound credential therefore has no authority to bootstrap a browser.
 */
export function createBrowserPrincipalResolver(options: {
	readonly storage: BrowserPrincipalStorage;
	readonly localOperatorBindingId?: string;
	readonly clock?: BrowserSessionClock;
	readonly ttlMs?: number;
}): BrowserPrincipalResolver {
	const clock = options.clock ?? Date;
	const ttlMs = options.ttlMs ?? 10 * 60_000;
	if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 24 * 60 * 60_000)
		throw new Error("browser session TTL must be from one second to one day");
	const policy = createAuthorizationPolicy();
	const localBindingId = options.localOperatorBindingId;

	function browser(
		request: FastifyRequest,
		action: "read" | "mutate",
	): ActorContext | undefined {
		if (!isExpectedBrowserRequest(request)) return undefined;
		const session = cookieValue(request, sessionCookieName);
		if (!session) return undefined;
		const csrf = request.headers["x-golem-csrf"];
		if (action === "mutate" && typeof csrf !== "string") return undefined;
		const binding = options.storage.resolveBrowserSession({
			session,
			...(typeof csrf === "string" ? { csrf } : {}),
			now: nowIso(clock),
		});
		return binding ? actorContext(binding, "browser") : undefined;
	}

	function bearer(request: FastifyRequest): ActorContext | undefined {
		const authorization = request.headers.authorization;
		const match =
			typeof authorization === "string"
				? /^Bearer ([^\s]+)$/u.exec(authorization)
				: undefined;
		const credential = match?.[1];
		if (!credential) return undefined;
		const binding = options.storage.resolveCredential({
			adapter: "bearer",
			credential,
			now: nowIso(clock),
		});
		if (binding) return actorContext(binding, "bearer");
		const mcp = options.storage.resolveCredential({
			adapter: "mcp",
			credential,
			now: nowIso(clock),
		});
		return mcp ? actorContext(mcp, "mcp") : undefined;
	}

	return Object.freeze({
		policy,
		bootstrap: (request: FastifyRequest) => {
			if (!localBindingId || !isExpectedOrigin(request.headers.origin, request))
				return Object.freeze({ ok: false });
			const now = nowIso(clock);
			const identifier = crypto.randomUUID();
			const csrf = crypto.randomBytes(32).toString("base64url");
			const expiresAt = new Date(clock.now() + ttlMs).toISOString();
			if (
				!options.storage.createBrowserSession({
					bindingId: localBindingId,
					requireOperator: true,
					session: identifier,
					csrf,
					expiresAt,
					now,
				})
			)
				return Object.freeze({ ok: false });
			return Object.freeze({
				ok: true as const,
				csrf,
				setCookie: `${sessionCookieName}=${identifier}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(ttlMs / 1_000)}`,
			});
		},
		resolve: (
			request: FastifyRequest,
			input: {
				readonly action: "read" | "mutate";
				readonly allowBrowser: boolean;
				readonly allowBearer: boolean;
			},
		) => {
			const context = input.allowBrowser
				? browser(request, input.action)
				: undefined;
			const resolved =
				context ?? (input.allowBearer ? bearer(request) : undefined);
			return resolved;
		},
		resolveMcp: (credential: string) => {
			const binding = options.storage.resolveCredential({
				adapter: "mcp",
				credential,
				now: nowIso(clock),
			});
			return binding ? actorContext(binding, "mcp") : undefined;
		},
		resolveInternal: (bindingId: string) => {
			// Internal callers pass an opaque server-owned binding id as a credential
			// through the same durable resolver rather than constructing an actor.
			const binding = options.storage.resolveCredential({
				adapter: "internal",
				credential: bindingId,
				now: nowIso(clock),
			});
			return binding ? actorContext(binding, "internal") : undefined;
		},
	});
}

/** Request authority must be composed before routing. These names are rejected
 * even if their value happens to match a real binding, so no client can turn a
 * transport detail into an actor/scope/fence/approval/storage override. */
export function hasRequestAuthorityOverride(request: FastifyRequest): boolean {
	for (const name of Object.keys(request.headers)) {
		if (
			/^x-golem-(?:caller|actor|role|project|session|principal|scope|bearer|authorization|token|fence|approval|storage)/iu.test(
				name,
			)
		)
			return true;
	}
	const forbidden =
		/^(?:actor|created_?by|role|project(?:_?id)?|session(?:_?id)?|bearer|authorization|token|credential|api_?key|owner(?:_?fence|_?id)?|fence|approval|storage|principal|scope|sender_?id|worker_?id)$/iu;
	const visit = (value: unknown): boolean => {
		if (Array.isArray(value)) return value.some(visit);
		if (!value || typeof value !== "object") return false;
		for (const [key, nested] of Object.entries(
			value as Record<string, unknown>,
		)) {
			if (forbidden.test(key) || visit(nested)) return true;
		}
		return false;
	};
	return visit(request.body) || visit(request.query);
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

/**
 * Fetch omits Origin for some same-origin reads and body-less POSTs. In that
 * browser-only case, require the browser provenance pair as well as the exact
 * loopback Referer; arbitrary headerless clients still fail closed.
 */
export function isExpectedBrowserRequest(request: FastifyRequest): boolean {
	if (isExpectedOrigin(request.headers.origin, request)) return true;
	const host = request.headers.host;
	const referer = request.headers.referer;
	const fetchSite = request.headers["sec-fetch-site"];
	if (
		typeof fetchSite !== "string" ||
		fetchSite !== "same-origin" ||
		typeof referer !== "string" ||
		!host ||
		!isExpectedHost(host)
	)
		return false;
	try {
		const expected = `${request.protocol}://${host}`;
		return constantTimeEqual(new URL(referer).origin, expected);
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
		if (!isExpectedBrowserRequest(request)) return undefined;
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
