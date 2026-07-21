import {
	type BrowserControlPlaneClient,
	type ControlPlaneStream,
	createProjectionSynchronizer,
	type ProjectionConnectionState,
} from "@golem/api-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
	asRuntimePage,
	type RuntimePage,
	type RuntimeStream,
} from "./types.js";

const runtimeStreams = [
	["live", "runtime.live"],
	["history", "runtime.history"],
	["diagnostics", "runtime.diagnostics"],
] as const satisfies readonly (readonly [RuntimeStream, ControlPlaneStream])[];

type ConnectionMap = Readonly<Record<RuntimeStream, ProjectionConnectionState>>;

type RuntimeDataContextValue = Readonly<{
	client: BrowserControlPlaneClient;
	connection: ProjectionConnectionState;
	enabled: boolean;
}>;

const RuntimeDataContext = React.createContext<
	RuntimeDataContextValue | undefined
>(undefined);

function aggregateConnection(states: ConnectionMap): ProjectionConnectionState {
	if (Object.values(states).includes("error")) return "error";
	if (Object.values(states).includes("resyncing")) return "resyncing";
	if (Object.values(states).includes("disconnected")) return "disconnected";
	if (Object.values(states).every((state) => state === "connected"))
		return "connected";
	return "connecting";
}

/**
 * A stream never mutates a rendered runtime page directly. Snapshots and deltas
 * only invalidate the typed REST projection, so a transient socket epoch cannot
 * combine rows from different authoritative revisions in the operator UI.
 */
export function RuntimeDataProvider({
	children,
	client,
	enabled,
}: React.PropsWithChildren<{
	readonly client: BrowserControlPlaneClient;
	readonly enabled: boolean;
}>) {
	const queryClient = useQueryClient();
	const [states, setStates] = React.useState<ConnectionMap>({
		live: "connecting",
		history: "connecting",
		diagnostics: "connecting",
	});

	React.useEffect(() => {
		if (!enabled) return;
		const synchronizers = runtimeStreams.map(
			([runtimeStream, transportStream]) =>
				createProjectionSynchronizer({
					client,
					stream: transportStream,
					onState: (state) =>
						setStates((current) => ({ ...current, [runtimeStream]: state })),
					onSnapshot: () => {
						void queryClient.invalidateQueries({ queryKey: ["runtime-page"] });
					},
					onDelta: () => {
						void queryClient.invalidateQueries({ queryKey: ["runtime-page"] });
					},
				}),
		);
		synchronizers.forEach((synchronizer) => synchronizer.start());
		return () => synchronizers.forEach((synchronizer) => synchronizer.stop());
	}, [client, enabled, queryClient]);

	const value = React.useMemo<RuntimeDataContextValue>(
		() => ({
			client,
			connection: aggregateConnection(states),
			enabled,
		}),
		[client, enabled, states],
	);
	return (
		<RuntimeDataContext.Provider value={value}>
			{children}
		</RuntimeDataContext.Provider>
	);
}

function useRuntimeData(): RuntimeDataContextValue {
	const context = React.useContext(RuntimeDataContext);
	if (!context)
		throw new Error("runtime route rendered outside RuntimeDataProvider");
	return context;
}

export function useRuntimePage(
	stream: RuntimeStream,
	query?: Readonly<{
		project_id?: string;
		cursor?: number;
		limit?: number;
		state?: string;
	}>,
) {
	const { client, enabled } = useRuntimeData();
	const key = React.useMemo(
		() =>
			[
				"runtime-page",
				stream,
				query?.project_id ?? "",
				query?.cursor ?? 0,
				query?.limit ?? 100,
				query?.state ?? "",
			] as const,
		[query?.cursor, query?.limit, query?.project_id, query?.state, stream],
	);
	return useQuery<RuntimePage>({
		queryKey: key,
		enabled,
		staleTime: Number.POSITIVE_INFINITY,
		retry: 1,
		queryFn: async () =>
			asRuntimePage(await client.runtimeProjection(stream, query)),
	});
}

export function useRuntimeConnection(): ProjectionConnectionState {
	return useRuntimeData().connection;
}
