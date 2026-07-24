import {
	type BrowserControlPlaneClient,
	createBrowserControlPlaneClient,
	createProjectionSynchronizer,
	type LegacyControlPlaneStream,
	type ProjectionConnectionState,
} from "@golem/api-client";
import { InlineAlert, Select, Skeleton, StatePanel, useTheme } from "@golem/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import {
	BrowserRouter,
	NavLink,
	Route,
	Routes,
	useLocation,
} from "react-router-dom";

import { LegacyCompatibilityIsland } from "./legacy-compatibility.js";
import { ReviewRoute } from "./routes/review/index.js";
import { RuntimeDataProvider } from "./routes/runtime/data.js";
import {
	DiagnosticsRoute,
	HistoryRoute,
	OverviewRoute,
	ProjectDetailRoute,
	ProjectsRoute,
	RuntimeConnectionBanner,
	RuntimeRouteNotFound,
	SessionsRoute,
} from "./routes/runtime/index.js";
import { SettingsDataProvider } from "./routes/settings/data.js";
import { SettingsRoute } from "./routes/settings/index.js";
import { SpecsRoute } from "./routes/specs/index.js";
import { WorkDataProvider } from "./routes/tracker/data.js";
import {
	TicketRoute,
	TrackerRoute,
	WorkConnectionBanner,
} from "./routes/tracker/index.js";
import styles from "./shell.module.css";

const projectionStream: LegacyControlPlaneStream = "runtime.live";
const projectionKey = [
	"control-plane",
	"projection",
	projectionStream,
] as const;

type ProjectionResponse = Awaited<
	ReturnType<BrowserControlPlaneClient["projection"]>
>;

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
				// The legacy compatibility island needs the whole authoritative
				// snapshot. Runtime routes never merge these payloads themselves.
				queryClient.setQueryData<ProjectionResponse>(projectionKey, snapshot);
			},
			onDelta: () => {
				// Compatibility pages receive a fresh snapshot instead of locally
				// reconciling a typed runtime delta into legacy-shaped objects.
				void queryClient.invalidateQueries({ queryKey: projectionKey });
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

function LegacyPage({
	projection,
}: {
	readonly projection: ProjectionResponse;
}) {
	return (
		<LegacyCompatibilityIsland
			payload={projection.payload}
			resourceRevision={projection.resource_revision}
		/>
	);
}

function RuntimeOverviewOrLegacy({
	projection,
}: {
	readonly projection: ProjectionResponse;
}) {
	const location = useLocation();
	const legacyOverlay = [
		"ticket",
		"compose",
		"chat",
		"communication",
		"ideas",
	].some((key) => new URLSearchParams(location.search).has(key));
	if (legacyOverlay) return <LegacyPage projection={projection} />;
	return <OverviewRoute />;
}

function RuntimeRoutes({
	projection,
}: {
	readonly projection: ProjectionResponse;
}) {
	return (
		<Routes>
			<Route
				element={<RuntimeOverviewOrLegacy projection={projection} />}
				path="/"
			/>
			<Route element={<OverviewRoute />} path="/dashboard" />
			<Route element={<SessionsRoute />} path="/agents" />
			<Route element={<SessionsRoute />} path="/sessions" />
			<Route element={<ProjectsRoute />} path="/projects" />
			<Route element={<ProjectDetailRoute />} path="/projects/:projectId" />
			<Route element={<ProjectDetailRoute />} path="/project/:projectId" />
			<Route element={<HistoryRoute />} path="/history" />
			<Route element={<HistoryRoute />} path="/logs" />
			<Route element={<DiagnosticsRoute />} path="/diagnostics" />
			<Route element={<TrackerRoute />} path="/tracker" />
			<Route element={<SpecsRoute />} path="/specs" />
			<Route element={<ReviewRoute />} path="/review" />
			<Route element={<SettingsRoute />} path="/settings" />
			<Route element={<TicketRoute />} path="/tickets/:id" />
			<Route element={<RuntimeRouteNotFound />} path="*" />
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
		<RuntimeDataProvider client={client} enabled={bootstrapped}>
			<WorkDataProvider client={client} enabled={bootstrapped}>
				<SettingsDataProvider client={client} enabled={bootstrapped}>
					<ConnectionBanner state={projection.connection} />
					<RuntimeConnectionBanner />
					<WorkConnectionBanner />
					<RuntimeRoutes projection={projection.data} />
				</SettingsDataProvider>
			</WorkDataProvider>
		</RuntimeDataProvider>
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
	const navigation = [
		["Overview", "/"],
		["Sessions", "/sessions"],
		["Projects", "/projects"],
		["History", "/history"],
		["Diagnostics", "/diagnostics"],
		["Tracker", "/tracker"],
		["Specs", "/specs"],
		["Review", "/review"],
		["Settings", "/settings"],
	] as const;

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
			<nav aria-label="Dashboard" className={styles.typedNavigation}>
				{navigation.map(([label, to]) => (
					<NavLink end={to === "/"} key={to} to={to}>
						{label}
					</NavLink>
				))}
			</nav>
			<main className={styles.main} id="dashboard-content" tabIndex={-1}>
				{bootstrap.isError ? (
					<StatePanel
						description="Browser authentication could not be initialized from this origin."
						kind="error"
						title="Authentication unavailable"
					/>
				) : meta.isError ? (
					<StatePanel
						description="The control plane metadata could not be loaded. Reload after the service is ready."
						kind="error"
						title="Metadata unavailable"
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
