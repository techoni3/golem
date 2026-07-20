import createClient from "openapi-fetch";

import type { paths } from "./generated/openapi.js";

export interface ApiClientBoundary {
	readonly transport: "openapi-fetch";
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
