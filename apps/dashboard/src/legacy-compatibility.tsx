import * as React from "react";
import { useLocation, useNavigate } from "react-router-dom";

// These are current product styles, scoped by the legacy application's class
// names. They remain behind this adapter until each screen has a typed feature.
import "../../../dashboard/web/extra.css";
import "../../../dashboard/web/styles.css";

type LegacyOverlays = {
	readonly chat?: string | null;
	readonly communication?: boolean;
	readonly compose?: boolean;
	readonly composeKind?: string | null;
	readonly composeParent?: string | null;
	readonly composeProject?: string | null;
	readonly ideas?: boolean;
	readonly ns?: string | null;
	readonly ticket?: string | null;
};

type LegacyRoute = {
	readonly id?: string;
	readonly kind: string;
	readonly overlays: LegacyOverlays;
	readonly q?: string | null;
	readonly showArchived?: boolean;
	readonly tab?: string | null;
	readonly view?: string | null;
};

type LegacyComponent = React.ComponentType<{
	readonly onClose?: (name: string) => void;
	readonly onNavigate?: (route: Record<string, unknown>) => void;
	readonly onTicketPageClose?: () => void;
	readonly overlays?: LegacyOverlays;
	readonly route?: LegacyRoute;
}>;

type LegacyModule = {
	readonly LegacyDashboardOverlays: LegacyComponent;
	readonly LegacyDashboardPageBody: LegacyComponent;
};

type LegacyStore = {
	applyTypedProjection(snapshot: Record<string, unknown>): void;
};

type LegacyRouter = {
	buildHref(route: Record<string, unknown>): string;
	closeOverlay(name: string): void;
	go(
		route: Record<string, unknown>,
		options?: { readonly replace?: boolean },
	): void;
	openChat(sessionId: string): void;
	openComposer(projectId?: string, presets?: Record<string, unknown>): void;
	openIdeas(): void;
	openNativeSession(sessionId: string): void;
	openOverlay(
		name: string,
		value?: string,
		extra?: Record<string, unknown>,
	): void;
	openTicket(ticketId: string): void;
	parseLocation(): LegacyRoute;
};

declare global {
	interface Window {
		__GOLEM_TYPED_SHELL__?: boolean;
		Router?: LegacyRouter;
		Store?: LegacyStore;
	}
}

let legacyLoad: Promise<LegacyModule> | undefined;

function loadLegacyApplication(): Promise<LegacyModule> {
	if (!legacyLoad) {
		window.__GOLEM_TYPED_SHELL__ = true;
		// This entry initialises current display modules only. It does not mount
		// their App, Sidebar, Topbar, route listener, or overlay owner.
		legacyLoad =
			// @ts-expect-error legacy JSX is bundled as a transitional compatibility island.
			import("../../../dashboard/web/src/entry.jsx") as Promise<LegacyModule>;
	}
	return legacyLoad;
}

function normalizedSnapshot(payload: unknown): Record<string, unknown> {
	return typeof payload === "object" &&
		payload !== null &&
		!Array.isArray(payload)
		? (payload as Record<string, unknown>)
		: {};
}

function overlayPath(
	pathname: string,
	search: string,
	name: string,
	value?: string,
	extra?: Record<string, unknown>,
): string {
	const query = new URLSearchParams(search);
	query.set(name, value ?? "1");
	for (const [key, next] of Object.entries(extra ?? {})) {
		if (next === undefined || next === null || next === "") query.delete(key);
		else query.set(key, String(next));
	}
	const suffix = query.toString();
	return suffix ? `${pathname}?${suffix}` : pathname;
}

function withoutOverlay(
	pathname: string,
	search: string,
	name: string,
): string {
	const query = new URLSearchParams(search);
	query.delete(name);
	if (name === "compose") {
		query.delete("project");
		query.delete("kind");
		query.delete("parent");
	}
	const suffix = query.toString();
	return suffix ? `${pathname}?${suffix}` : pathname;
}

function useTypedLegacyBridge(ready: boolean) {
	const location = useLocation();
	const navigate = useNavigate();
	const current = React.useRef({ location, navigate });
	current.current = { location, navigate };
	const navigateRoute = React.useCallback(
		(route: Record<string, unknown>, replace = false) => {
			const href = window.Router?.buildHref(route) ?? "/";
			navigate(href, { replace });
		},
		[navigate],
	);
	const closeOverlay = React.useCallback((name: string) => {
		const snapshot = current.current;
		const state =
			typeof snapshot.location.state === "object" &&
			snapshot.location.state !== null
				? (snapshot.location.state as { readonly overlay?: unknown })
				: undefined;
		if (state?.overlay === name) snapshot.navigate(-1);
		else
			snapshot.navigate(
				withoutOverlay(
					snapshot.location.pathname,
					snapshot.location.search,
					name,
				),
				{ replace: true },
			);
	}, []);

	React.useEffect(() => {
		if (!ready || !window.Router) return;
		const router = window.Router;
		const previous = {
			closeOverlay: router.closeOverlay,
			go: router.go,
			openChat: router.openChat,
			openComposer: router.openComposer,
			openIdeas: router.openIdeas,
			openNativeSession: router.openNativeSession,
			openOverlay: router.openOverlay,
			openTicket: router.openTicket,
		};
		const open = (
			name: string,
			value?: string,
			extra?: Record<string, unknown>,
		) => {
			const snapshot = current.current;
			snapshot.navigate(
				overlayPath(
					snapshot.location.pathname,
					snapshot.location.search,
					name,
					value,
					extra,
				),
				{ state: { overlay: name } },
			);
		};
		router.go = (route, options) => navigateRoute(route, options?.replace);
		router.openOverlay = open;
		router.closeOverlay = closeOverlay;
		router.openTicket = (ticketId) => open("ticket", ticketId);
		router.openComposer = (projectId, presets) =>
			open("compose", "1", {
				...(projectId ? { project: projectId } : {}),
				...(presets ?? {}),
			});
		router.openChat = (sessionId) => open("chat", sessionId);
		router.openNativeSession = (sessionId) => open("ns", sessionId);
		router.openIdeas = () => open("ideas", "1");
		return () => {
			Object.assign(router, previous);
		};
	}, [closeOverlay, navigateRoute, ready]);

	return {
		closeOverlay,
		goBack: () => navigate(-1),
		navigateRoute,
	};
}

export function LegacyCompatibilityIsland({
	payload,
	resourceRevision,
}: {
	readonly payload: unknown;
	readonly resourceRevision: number;
}) {
	const [legacy, setLegacy] = React.useState<LegacyModule>();
	const typedProjection = React.useMemo(
		() => ({
			resourceRevision,
			snapshot: normalizedSnapshot(payload),
		}),
		[payload, resourceRevision],
	);
	const projectionRef = React.useRef(typedProjection);
	projectionRef.current = typedProjection;
	const { closeOverlay, goBack, navigateRoute } = useTypedLegacyBridge(
		legacy !== undefined,
	);
	const returnFocus = React.useRef<HTMLElement | undefined>(undefined);

	React.useEffect(() => {
		let alive = true;
		void loadLegacyApplication().then((module) => {
			if (!alive) return;
			// The entry has created Store by this point. Replaying the current
			// projection here closes the import-time race on the first typed frame.
			window.Store?.applyTypedProjection(projectionRef.current.snapshot);
			setLegacy(module);
		});
		return () => {
			alive = false;
		};
	}, []);
	React.useEffect(() => {
		if (legacy) window.Store?.applyTypedProjection(typedProjection.snapshot);
	}, [legacy, typedProjection]);

	const router = window.Router;
	const route = legacy && router ? router.parseLocation() : undefined;
	const close = React.useCallback(
		(name: string) => {
			closeOverlay(name);
			queueMicrotask(() => {
				returnFocus.current?.focus();
			});
		},
		[closeOverlay],
	);
	const rememberTrigger = React.useCallback(
		(event: React.MouseEvent<HTMLDivElement>) => {
			if (route?.overlays && Object.values(route.overlays).some(Boolean))
				return;
			const target = event.target as HTMLElement;
			const trigger = target.closest<HTMLElement>("a, button, [role='button']");
			if (trigger) returnFocus.current = trigger;
		},
		[route],
	);

	if (!legacy || !route)
		return <div aria-live="polite">Loading existing dashboard features…</div>;
	const PageBody = legacy.LegacyDashboardPageBody;
	const Overlays = legacy.LegacyDashboardOverlays;
	return (
		<div
			data-compatibility-island="legacy-current-pages"
			onClickCapture={rememberTrigger}
		>
			<PageBody
				onNavigate={navigateRoute}
				onTicketPageClose={goBack}
				route={route}
			/>
			<Overlays onClose={close} overlays={route.overlays} />
		</div>
	);
}
