import {
	BrowserWorkProjectionResponseSchema,
	BrowserWorkStreamSchema,
	BrowserWorkWebSocketFrameSchema,
	type BrowserWorkStream,
	type BrowserWorkWebSocketFrame,
	LegacyControlPlaneProjectionResponseSchema,
	type LegacyControlPlaneProjectionResponse,
	LegacyControlPlaneProjectionStreamSchema,
	type WebSocketFrameV1,
	WebSocketFrameV1Schema,
} from "@golem/contracts";
import type { z } from "zod";
import createClient from "openapi-fetch";

import type { paths } from "./generated/openapi.js";

export {
	applyProjectionDelta,
	type ProjectionStateLike,
	replaceProjectionSnapshot,
} from "./projection-state.js";
export {
	createProjectionSynchronizer,
	type ProjectionConnectionState,
	type ProjectionSocket,
	type ProjectionSynchronizer,
} from "./projection-sync.js";

export type ApiClientMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface ApiClientRequest {
	readonly method: ApiClientMethod;
	readonly path: string;
	readonly body?: unknown;
}

export interface ApiClientResponse {
	readonly status: number;
	readonly body: unknown;
}

/** Process-composed identity; never accepted from an MCP tool payload. */
export interface TrustedCallerContext {
	readonly sessionId?: string;
	readonly projectId?: string;
}

/** The only application seam available to CLI, MCP, and rendered clients. */
export interface ApiClientBoundary {
	readonly transport: "openapi-fetch";
	readonly caller: TrustedCallerContext;
	request(input: ApiClientRequest): Promise<ApiClientResponse>;
}

export interface FetchApiClientOptions {
	/** Loopback bearer injected at process composition; it is never serialized. */
	readonly bearerToken?: string;
	/** Compatibility metadata for local composition only. HTTP never serializes it:
	 * the server derives actor/project scope from its durable bearer binding. */
	readonly caller?: TrustedCallerContext;
}

export function createFetchApiClient(
	baseUrl: string,
	options: FetchApiClientOptions = {},
): ApiClientBoundary {
	const base = new URL(baseUrl);
	return {
		transport: "openapi-fetch",
		caller: options.caller ?? {},
		async request(input) {
			const init: RequestInit = { method: input.method };
			const headers: Record<string, string> = {};
			if (options.bearerToken)
				headers.authorization = `Bearer ${options.bearerToken}`;
			if (input.body !== undefined) {
				headers["content-type"] = "application/json";
				init.body = JSON.stringify(input.body);
			}
			if (Object.keys(headers).length) init.headers = headers;
			const response = await fetch(new URL(input.path, base), init);
			const text = await response.text();
			let body: unknown = null;
			if (text) {
				try {
					body = JSON.parse(text) as unknown;
				} catch {
					body = text;
				}
			}
			return { status: response.status, body };
		},
	};
}

export interface ControlPlaneClientOptions {
	readonly baseUrl: string;
	readonly token: string;
}

export function createControlPlaneClient(options: ControlPlaneClientOptions) {
	return createClient<paths>({
		baseUrl: options.baseUrl,
		headers: { authorization: `Bearer ${options.token}` },
	});
}

/** Explicit typed runtime read-model client; transport remains OpenAPI-backed. */
export function createRuntimeProjectionClient(
	options: ControlPlaneClientOptions,
) {
	const client = createControlPlaneClient(options);
	return Object.freeze({
		live(query?: {
			readonly project_id?: string;
			readonly cursor?: number;
			readonly limit?: number;
			readonly state?: string;
		}) {
			return client.GET("/api/v1/runtime/{stream}", {
				params: {
					path: { stream: "live" },
					...(query === undefined ? {} : { query }),
				},
			});
		},
		history(query?: {
			readonly project_id?: string;
			readonly cursor?: number;
			readonly limit?: number;
			readonly state?: string;
		}) {
			return client.GET("/api/v1/runtime/{stream}", {
				params: {
					path: { stream: "history" },
					...(query === undefined ? {} : { query }),
				},
			});
		},
		diagnostics(query?: { readonly cursor?: number; readonly limit?: number }) {
			return client.GET("/api/v1/runtime/{stream}", {
				params: {
					path: { stream: "diagnostics" },
					...(query === undefined ? {} : { query }),
				},
			});
		},
	});
}

export type LegacyControlPlaneStream = z.infer<
	typeof LegacyControlPlaneProjectionStreamSchema
>;
/** Retains the shared HTTP projection route's complete prior stream surface. */
export type ControlPlaneStream = LegacyControlPlaneStream | BrowserWorkStream;
export type ControlPlaneProjection = LegacyControlPlaneProjectionResponse["payload"];
export type ControlPlaneProjectionResponse = LegacyControlPlaneProjectionResponse;

export class ControlPlaneClientError extends Error {
	readonly status: number;

	constructor(status: number, operation: string) {
		super(`control-plane ${operation} failed with HTTP ${status}`);
		this.name = "ControlPlaneClientError";
		this.status = status;
	}
}

function requireData<T>(
	data: T | undefined,
	response: Response,
	operation: string,
): T {
	if (data !== undefined) return data;
	throw new ControlPlaneClientError(response.status, operation);
}

/**
 * Browser-only typed client. It relies on an HttpOnly same-origin session and
 * is the sole owner of REST paths, CSRF state, and WebSocket frame validation.
 */
export interface BrowserControlPlaneClientOptions {
	/** Process-composed test/CLI credentials; browser callers leave this empty. */
	readonly headers?: HeadersInit;
}

export function createBrowserControlPlaneClient(
	baseUrl: string,
	options: BrowserControlPlaneClientOptions = {},
) {
	const client = createClient<paths>({
		baseUrl,
		credentials: "same-origin",
		...(options.headers === undefined ? {} : { headers: options.headers }),
	});
	let csrfToken: string | undefined;
	const browserHeaders = () =>
		csrfToken === undefined ? {} : { "x-golem-csrf": csrfToken };
	function projection(
		stream: BrowserWorkStream,
	): Promise<ReturnType<typeof BrowserWorkProjectionResponseSchema.parse>>;
	function projection(
		stream: LegacyControlPlaneStream,
	): Promise<LegacyControlPlaneProjectionResponse>;
	async function projection(stream: ControlPlaneStream) {
		const result = await client.GET("/api/v1/projections/{stream}", {
			headers: browserHeaders(),
			params: { path: { stream } },
		});
		const data = requireData(result.data, result.response, "projection fetch");
		return BrowserWorkStreamSchema.safeParse(stream).success
			? BrowserWorkProjectionResponseSchema.parse(data)
			: LegacyControlPlaneProjectionResponseSchema.parse(data);
	}

	return Object.freeze({
		async bootstrap() {
			const result = await client.POST("/api/v1/browser/session");
			const data = requireData(
				result.data,
				result.response,
				"browser bootstrap",
			);
			csrfToken = data.csrf_token;
			return data;
		},
		async meta() {
			const result = await client.GET("/api/v1/meta", {
				headers: browserHeaders(),
			});
			return requireData(result.data, result.response, "metadata fetch");
		},
		projection,
		async browserWorkProjection(stream: BrowserWorkStream) {
			return projection(stream);
		},
		async runtimeProjection(
			stream: "live" | "history" | "diagnostics",
			query?: {
				readonly project_id?: string;
				readonly cursor?: number;
				readonly limit?: number;
				readonly state?: string;
			},
		) {
			const result = await client.GET("/api/v1/runtime/{stream}", {
				headers: browserHeaders(),
				params: {
					path: { stream },
					...(query === undefined ? {} : { query }),
				},
			});
			return requireData(
				result.data,
				result.response,
				"runtime projection fetch",
			);
		},
		async echo(value: string) {
			if (!csrfToken)
				throw new Error(
					"control-plane browser session has not been bootstrapped",
				);
			const result = await client.POST("/api/v1/browser/echo", {
				body: { value },
				headers: { "x-golem-csrf": csrfToken },
			});
			return requireData(result.data, result.response, "browser mutation");
		},
		webSocketUrl(
			stream: LegacyControlPlaneStream,
			cursor?: {
				readonly instanceId: string;
				readonly sequence: number;
			},
		) {
			const url = new URL("/api/v1/ws", baseUrl);
			url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
			url.searchParams.set("stream", stream);
			if (cursor) {
				url.searchParams.set("instance_id", cursor.instanceId);
				url.searchParams.set("cursor", String(cursor.sequence));
			}
			return url.toString();
		},
		parseWebSocketFrame(raw: string): WebSocketFrameV1 {
			return WebSocketFrameV1Schema.parse(JSON.parse(raw));
		},
		browserWorkWebSocketUrl(
			stream: BrowserWorkStream,
			cursor?: {
				readonly instanceId: string;
				readonly sequence: number;
			},
		) {
			const url = new URL("/api/v1/ws", baseUrl);
			url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
			url.searchParams.set("stream", stream);
			if (cursor) {
				url.searchParams.set("instance_id", cursor.instanceId);
				url.searchParams.set("cursor", String(cursor.sequence));
			}
			return url.toString();
		},
		parseBrowserWorkWebSocketFrame(raw: string): BrowserWorkWebSocketFrame {
			return BrowserWorkWebSocketFrameSchema.parse(JSON.parse(raw));
		},
	});
}

export type BrowserControlPlaneClient = ReturnType<
	typeof createBrowserControlPlaneClient
>;
