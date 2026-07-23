import {
	type BrowserControlPlaneClient,
	type BrowserWorkStream,
	createBrowserWorkSynchronizer,
} from "@golem/api-client";
import {
	type QueryKey,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import * as React from "react";

import type {
	WorkCommand,
	WorkConnectionState,
	WorkProjectionFor,
} from "./types.js";

const liveStreams = [
	"tracker.tree",
	"management.controls",
	"communication.operations",
] as const satisfies readonly BrowserWorkStream[];

type ConnectionMap = Readonly<
	Record<(typeof liveStreams)[number], WorkConnectionState>
>;

type WorkDataContextValue = Readonly<{
	client: BrowserControlPlaneClient;
	connections: ConnectionMap;
	enabled: boolean;
}>;

const WorkDataContext = React.createContext<WorkDataContextValue | undefined>(
	undefined,
);

export function workProjectionKey(stream: BrowserWorkStream): QueryKey {
	return ["browser-work", "projection", stream] as const;
}

export function workDetailKey(opaqueId: string): QueryKey {
	return ["browser-work", "detail", opaqueId] as const;
}

function setConnection(
	setter: React.Dispatch<React.SetStateAction<ConnectionMap>>,
	stream: (typeof liveStreams)[number],
	state: WorkConnectionState,
) {
	setter((current) =>
		current[stream] === state ? current : { ...current, [stream]: state },
	);
}

/**
 * Browser-work sockets carry snapshots and invalidation hints, never rows to
 * merge into the UI. The synchronizer replaces or refetches a complete typed
 * resource; tracker-tree invalidations also refetch the board projection.
 */
export function WorkDataProvider({
	children,
	client,
	enabled,
}: React.PropsWithChildren<{
	readonly client: BrowserControlPlaneClient;
	readonly enabled: boolean;
}>) {
	const queryClient = useQueryClient();
	const [connections, setConnections] = React.useState<ConnectionMap>({
		"tracker.tree": "connecting",
		"management.controls": "connecting",
		"communication.operations": "connecting",
	});

	React.useEffect(() => {
		if (!enabled) return;
		let stopped = false;
		const sockets = new Set<WebSocket>();
		const retries = new Set<number>();

		const open = (stream: (typeof liveStreams)[number]) => {
			if (stopped) return;
			const synchronizer = synchronizers.get(stream);
			if (!synchronizer) return;
			const cursor = synchronizer.state();
			const url =
				cursor.instance_id !== undefined && cursor.sequence !== undefined
					? client.browserWorkWebSocketUrl(stream, {
							instanceId: cursor.instance_id,
							sequence: cursor.sequence,
						})
					: client.browserWorkWebSocketUrl(stream);
			setConnection(
				setConnections,
				stream,
				cursor.instance_id === undefined ? "connecting" : "reconnecting",
			);
			const socket = new WebSocket(url);
			sockets.add(socket);
			let consume = Promise.resolve();

			socket.addEventListener("open", () => {
				if (!stopped) setConnection(setConnections, stream, "connected");
			});
			socket.addEventListener("message", (message) => {
				consume = consume
					.then(async () => {
						if (stopped) return;
						await synchronizer.consume(String(message.data));
						if (
							synchronizer.state().instance_id === undefined &&
							socket.readyState === WebSocket.OPEN
						)
							socket.close();
					})
					.catch(() => {
						if (stopped) return;
						setConnection(setConnections, stream, "error");
						socket.close();
					});
			});
			socket.addEventListener("error", () => {
				if (!stopped) setConnection(setConnections, stream, "reconnecting");
			});
			socket.addEventListener("close", () => {
				sockets.delete(socket);
				if (stopped) return;
				setConnection(setConnections, stream, "reconnecting");
				const retry = globalThis.setTimeout(() => {
					retries.delete(retry);
					open(stream);
				}, 250);
				retries.add(retry);
			});
		};

		const synchronizers = new Map(
			liveStreams.map((stream) => [
				stream,
				createBrowserWorkSynchronizer({
					key: { kind: "stream", stream },
					async refetch() {
						const snapshot = await client.browserWorkProjection(stream);
						if (stream === "tracker.tree")
							await queryClient.invalidateQueries({
								queryKey: workProjectionKey("tracker.board"),
							});
						return snapshot;
					},
					onSnapshot(snapshot) {
						if (snapshot.schema_version !== "golem.browser-work-projection/v1")
							return;
						queryClient.setQueryData(workProjectionKey(stream), snapshot);
						setConnection(setConnections, stream, "connected");
						if (stream === "tracker.tree")
							void queryClient.invalidateQueries({
								queryKey: workProjectionKey("tracker.board"),
							});
					},
					onInvalidation() {
						setConnection(setConnections, stream, "reconnecting");
					},
				}),
			]),
		);

		liveStreams.forEach(open);
		return () => {
			stopped = true;
			retries.forEach((retry) => {
				globalThis.clearTimeout(retry);
			});
			sockets.forEach((socket) => {
				socket.close();
			});
		};
	}, [client, enabled, queryClient]);

	const value = React.useMemo<WorkDataContextValue>(
		() => ({ client, connections, enabled }),
		[client, connections, enabled],
	);
	return (
		<WorkDataContext.Provider value={value}>
			{children}
		</WorkDataContext.Provider>
	);
}

function useWorkData(): WorkDataContextValue {
	const context = React.useContext(WorkDataContext);
	if (!context) throw new Error("work route rendered outside WorkDataProvider");
	return context;
}

export function useWorkProjection<Stream extends BrowserWorkStream>(
	stream: Stream,
) {
	const { client, enabled } = useWorkData();
	return useQuery<WorkProjectionFor<Stream>>({
		queryKey: workProjectionKey(stream),
		enabled,
		staleTime: Number.POSITIVE_INFINITY,
		retry: 1,
		queryFn: async () => {
			const projection = await client.browserWorkProjection(stream);
			if (projection.stream !== stream)
				throw new Error("browser-work projection returned the wrong stream");
			return projection as WorkProjectionFor<Stream>;
		},
	});
}

export function useWorkDetail(opaqueId: string | undefined) {
	const { client, enabled } = useWorkData();
	return useQuery({
		queryKey: workDetailKey(opaqueId ?? ""),
		enabled: enabled && opaqueId !== undefined,
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
		queryFn: () => client.browserWorkDetail(opaqueId ?? ""),
	});
}

export function useWorkAsset(
	opaqueId: string | undefined,
	assetId: string | undefined,
) {
	const { client, enabled } = useWorkData();
	return useQuery({
		queryKey: ["browser-work", "asset", opaqueId ?? "", assetId ?? ""],
		enabled: enabled && opaqueId !== undefined && assetId !== undefined,
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
		queryFn: () => client.browserWorkAsset(opaqueId ?? "", assetId ?? ""),
	});
}

export function useWorkConnections(): ConnectionMap {
	return useWorkData().connections;
}

export function useWorkCommand() {
	const { client } = useWorkData();
	const queryClient = useQueryClient();
	return useMutation({
		retry: false,
		mutationFn: (command: WorkCommand) => client.browserWorkCommand(command),
		onSettled: (_result, _error, command) => {
			void queryClient.invalidateQueries({
				queryKey: ["browser-work", "projection"],
			});
			if ("opaque_id" in command)
				void queryClient.invalidateQueries({
					queryKey: workDetailKey(command.opaque_id),
				});
			if (command.kind === "stream.create")
				void queryClient.invalidateQueries({
					queryKey: ["browser-work", "detail"],
				});
			if (
				command.kind === "ticket.create" &&
				command.parent_opaque_id !== undefined
			)
				void queryClient.invalidateQueries({
					queryKey: workDetailKey(command.parent_opaque_id),
				});
		},
	});
}

export function useRefreshWork() {
	const queryClient = useQueryClient();
	return React.useCallback(
		() =>
			queryClient.invalidateQueries({
				queryKey: ["browser-work"],
			}),
		[queryClient],
	);
}
