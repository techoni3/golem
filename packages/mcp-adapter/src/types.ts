import type { ApiClientBoundary } from "@golem/api-client";

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
	readonly schema: McpInputSchema;
	readonly method: "GET" | "POST";
	path(input: Record<string, unknown>): string;
}

export interface McpAdapterBoundary {
	readonly client: ApiClientBoundary;
}
