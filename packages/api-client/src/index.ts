import createClient from "openapi-fetch";

import type { paths } from "./generated/openapi.js";

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
	/** Harness-provided caller binding; it is never model-supplied MCP input. */
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
