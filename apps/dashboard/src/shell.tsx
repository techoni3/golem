import {
	type BrowserControlPlaneClient,
	type ControlPlaneStream,
	createBrowserControlPlaneClient,
	createProjectionSynchronizer,
	type ProjectionConnectionState,
} from "@golem/api-client";
import { InlineAlert, Select, Skeleton, StatePanel, useTheme } from "@golem/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";

import { LegacyCompatibilityIsland } from "./legacy-compatibility.js";
import styles from "./shell.module.css";

const projectionStream: ControlPlaneStream = "runtime.live";
const projectionKey = [
	"control-plane",
	"projection",
	projectionStream,
] as const;
const legacyRoutePaths = [
	"/",
	"/dashboard",
	"/tracker",
	"/specs",
	"/projects",
	"/agents",
	"/logs",
	"/settings",
	"/project/:id",
	"/tickets/:id",
] as const;

type ProjectionResponse = Awaited<
	ReturnType<BrowserControlPlaneClient["projection"]>
>;

function objectValue(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function useControlPlaneClient(): BrowserControlPlaneClient {
	return React.useMemo(
		() => createBrowserControlPlaneClient(window.location.origin),
		[],
	);
}

function useLiveProjection(
	client: BrowserControlPlaneClient,
	bootstrapped: boolean,
) {
	const queryClient = useQueryClient();
	const [connection, setConnection] =
		React.useState<ProjectionConnectionState>("connecting");
	const query = useQuery({
		queryKey: projectionKey,
		queryFn: () => client.projection(projectionStream),
		enabled: bootstrapped,
		staleTime: Number.POSITIVE_INFINITY,
		retry: 1,
	});
	const hasProjection = query.data !== undefined;

	React.useEffect(() => {
		if (!bootstrapped || !hasProjection) return;
		const synchronizer = createProjectionSynchronizer({
			client,
			stream: projectionStream,
			onState: setConnection,
			onSnapshot: (snapshot) => {
				queryClient.setQueryData<ProjectionResponse>(
					projectionKey,
					(current) =>
						current && current.resource_revision > snapshot.resource_revision
							? current
							: snapshot,
				);
			},
			onDelta: (frame) => {
				if (frame.payload.kind !== "delta") return;
				const delta = frame.payload.delta;
				queryClient.setQueryData<ProjectionResponse>(
					projectionKey,
					(current) => {
						if (!current || frame.resource_revision < current.resource_revision)
							return current;
						return {
							...current,
							resource_revision: frame.resource_revision,
							payload: {
								...objectValue(current.payload),
								...objectValue(delta),
							},
						};
					},
				);
			},
		});
		synchronizer.start();
		return () => synchronizer.stop();
	}, [bootstrapped, client, hasProjection, queryClient]);

	return { ...query, connection };
}

function ConnectionBanner({
	state,
}: {
	readonly state: ProjectionConnectionState;
}) {
	if (state === "connected") return null;
	const copy =
		state === "resyncing"
			? "Refreshing the authoritative snapshot after a stream gap."
			: state === "error"
				? "The control plane could not refresh yet. It will retry without discarding the current route."
				: state === "disconnected"
					? "Connection lost. Reconnecting with the last safe cursor."
					: "Connecting to the control plane.";
	return <InlineAlert tone="warning">{copy}</InlineAlert>;
}

function LegacyRoutes({
	projection,
}: {
	readonly projection: ProjectionResponse;
}) {
	const island = (
		<LegacyCompatibilityIsland
			payload={projection.payload}
			resourceRevision={projection.resource_revision}
		/>
	);
	return (
		<Routes>
			{legacyRoutePaths.map((path) => (
				<Route element={island} key={path} path={path} />
			))}
			<Route element={island} path="*" />
		</Routes>
	);
}

function RouteContent({
	bootstrapped,
	client,
}: {
	readonly bootstrapped: boolean;
	readonly client: BrowserControlPlaneClient;
}) {
	const projection = useLiveProjection(client, bootstrapped);
	if (!bootstrapped)
		return (
			<section className={styles.loading} aria-live="polite">
				<Skeleton width="15rem" />
				<Skeleton width="100%" />
			</section>
		);
	if (projection.isError || !projection.data)
		return (
			<StatePanel
				description="The dashboard could not retrieve its typed live projection. Reconnect or reload after the service is ready."
				kind="error"
				title="Control plane unavailable"
			/>
		);
	return (
		<>
			<ConnectionBanner state={projection.connection} />
			<LegacyRoutes projection={projection.data} />
		</>
	);
}

function Shell() {
	const client = useControlPlaneClient();
	const bootstrap = useQuery({
		queryKey: ["control-plane", "browser-session"],
		queryFn: () => client.bootstrap(),
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
	});
	const meta = useQuery({
		queryKey: ["control-plane", "meta"],
		queryFn: () => client.meta(),
		enabled: bootstrap.isSuccess,
		staleTime: Number.POSITIVE_INFINITY,
		retry: 1,
	});
	const { preference, setPreference } = useTheme();
	const location = useLocation();

	return (
		<div className={styles.shell} data-testid="dashboard-shell">
			<a className={styles.skipLink} href="#dashboard-content">
				Skip to main content
			</a>
			<header className={styles.typedControls}>
				<span aria-live="polite" className={styles.typedStatus}>
					Typed control-plane shell · {location.pathname}
				</span>
				<Select
					label="Theme"
					onChange={(value) =>
						setPreference(value as "system" | "light" | "dark")
					}
					options={[
						{ id: "system", label: "System" },
						{ id: "light", label: "Light" },
						{ id: "dark", label: "Dark" },
					]}
					testId="dashboard-theme"
					value={preference}
				/>
			</header>
			<main className={styles.main} id="dashboard-content" tabIndex={-1}>
				{bootstrap.isError ? (
					<StatePanel
						description="Browser authentication could not be initialized from this origin."
						kind="error"
						title="Authentication unavailable"
					/>
				) : (
					<RouteContent
						bootstrapped={bootstrap.isSuccess && meta.isSuccess}
						client={client}
					/>
				)}
			</main>
		</div>
	);
}

export function DashboardShell() {
	return (
		<BrowserRouter>
			<Shell />
		</BrowserRouter>
	);
}
