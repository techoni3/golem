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

/** The only application seam available to CLI, MCP, and rendered clients. */
export interface ApiClientBoundary {
	readonly transport: "openapi-fetch";
	request(input: ApiClientRequest): Promise<ApiClientResponse>;
}

export function createFetchApiClient(baseUrl: string): ApiClientBoundary {
	const base = new URL(baseUrl);
	return {
		transport: "openapi-fetch",
		async request(input) {
			const init: RequestInit = { method: input.method };
			if (input.body !== undefined) {
				init.headers = { "content-type": "application/json" };
				init.body = JSON.stringify(input.body);
			}
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
