import type { ApiClientBoundary } from "@golem/api-client";

export interface McpAdapterBoundary {
	readonly client: ApiClientBoundary;
}
