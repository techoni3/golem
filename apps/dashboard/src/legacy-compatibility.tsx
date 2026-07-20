import * as React from "react";

// These are current product styles, scoped by the legacy application's class
// names. They remain behind this adapter until each screen has a typed feature.
import "../../../dashboard/web/extra.css";
import "../../../dashboard/web/styles.css";

type LegacyComponent = React.ComponentType;

type LegacyModule = {
	readonly LegacyDashboardApp: LegacyComponent;
};

type LegacyStore = {
	applyTypedProjection(snapshot: Record<string, unknown>): void;
};

declare global {
	interface Window {
		__GOLEM_TYPED_SHELL__?: boolean;
		Store?: LegacyStore;
	}
}

let legacyLoad: Promise<LegacyModule> | undefined;

function loadLegacyApplication(): Promise<LegacyModule> {
	if (!legacyLoad) {
		window.__GOLEM_TYPED_SHELL__ = true;
		// GOL-38 deliberately contains the existing current-page modules in one
		// island. They keep their own display-local behavior but receive data only
		// through this typed projection bridge; new code never imports legacy APIs.
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

export function LegacyCompatibilityIsland({
	payload,
	resourceRevision,
}: {
	readonly payload: unknown;
	readonly resourceRevision: number;
}) {
	const [LegacyDashboardApp, setLegacyDashboardApp] =
		React.useState<LegacyComponent>();
	const typedProjection = React.useMemo(
		() => ({
			resourceRevision,
			snapshot: normalizedSnapshot(payload),
		}),
		[payload, resourceRevision],
	);
	React.useEffect(() => {
		let alive = true;
		void loadLegacyApplication().then(({ LegacyDashboardApp: Application }) => {
			if (!alive) return;
			window.Store?.applyTypedProjection(typedProjection.snapshot);
			setLegacyDashboardApp(() => Application);
		});
		return () => {
			alive = false;
		};
	}, [typedProjection]);
	React.useEffect(() => {
		window.Store?.applyTypedProjection(typedProjection.snapshot);
	}, [typedProjection]);

	if (!LegacyDashboardApp)
		return <div aria-live="polite">Loading existing dashboard features…</div>;
	return (
		<div data-compatibility-island="legacy-current-pages">
			<LegacyDashboardApp />
		</div>
	);
}
