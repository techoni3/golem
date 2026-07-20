import type { ApiClientBoundary, ApiClientRequest } from "@golem/api-client";

export interface McpToolContent {
	readonly type: "text";
	readonly text: string;
}

export interface McpToolResult {
	readonly isError?: true;
	readonly content: readonly McpToolContent[];
}

export interface SafeParseSuccess {
	readonly success: true;
	readonly data: Record<string, unknown>;
}

export interface SafeParseFailure {
	readonly success: false;
	readonly error: unknown;
}

export interface McpInputSchema {
	safeParse(input: unknown): SafeParseSuccess | SafeParseFailure;
}

export interface McpToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
	/** GOL-26 API envelopes are the public success/error wire boundary. */
	readonly resultSchema: Record<string, unknown>;
	readonly errorSchema: Record<string, unknown>;
	readonly schema: McpInputSchema;
	request(input: Record<string, unknown>): ApiClientRequest | undefined;
}

export interface McpAdapterBoundary {
	readonly client: ApiClientBoundary;
}
