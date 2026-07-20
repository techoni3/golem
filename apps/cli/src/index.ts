import type { ApiClientBoundary } from "@golem/api-client";
import type { LauncherBoundary } from "@golem/launcher";

export interface CliComposition {
	readonly apiClient: ApiClientBoundary;
	readonly launcher: LauncherBoundary;
}
