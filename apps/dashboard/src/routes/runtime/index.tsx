import {
	InlineAlert,
	SearchField,
	Select,
	Skeleton,
	StatePanel,
	StatusBadge,
} from "@golem/ui";
import * as React from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { useRuntimeConnection, useRuntimePage } from "./data.js";
import { RuntimeSessionDrawer } from "./drawer.js";
import { endpointSummary, RuntimePassportCard } from "./passport.js";
import {
	activityAt,
	endpoints,
	isTerminal,
	lifecycle,
	model,
	number,
	observedAt,
	projectName,
	role,
	sessionName,
	text,
	type RuntimeItem,
} from "./types.js";
import styles from "./runtime.module.css";

const lifecycleOptions = [
	{ id: "", label: "All live states" },
	{ id: "active", label: "Active" },
	{ id: "idle", label: "Idle" },
	{ id: "waiting", label: "Waiting" },
] as const;

function connectionCopy(state: ReturnType<typeof useRuntimeConnection>) {
	if (state === "connected") return undefined;
	if (state === "resyncing")
		return "Refreshing a complete canonical snapshot after a stream gap.";
	if (state === "disconnected")
		return "Connection paused. The visible snapshot remains intact while the dashboard reconnects.";
	if (state === "error")
		return "The control plane could not refresh yet. Retry is automatic and no local state has been guessed.";
	return "Connecting to the canonical runtime projection.";
}

export function RuntimeConnectionBanner() {
	const state = useRuntimeConnection();
	const copy = connectionCopy(state);
	return copy ? (
		<div data-state={state} data-testid="runtime-connection">
			<InlineAlert tone="warning">{copy}</InlineAlert>
		</div>
	) : (
		<span
			className={styles.connectionOk}
			data-state={state}
			data-testid="runtime-connection"
			role="status"
		>
			Canonical streams live
		</span>
	);
}

function useRouteFilters() {
	const [searchParams, setSearchParams] = useSearchParams();
	const update = React.useCallback(
		(key: string, value: string | undefined) => {
			setSearchParams((current) => {
				const next = new URLSearchParams(current);
				if (value) next.set(key, value);
				else next.delete(key);
				return next;
			});
		},
		[setSearchParams],
	);
	return {
		query: searchParams.get("q") ?? "",
		selectedSession: searchParams.get("session") ?? undefined,
		state: searchParams.get("state") ?? "",
		setQuery: (value: string) => update("q", value),
		setSelectedSession: (value: string | undefined) => update("session", value),
		setState: (value: string) => update("state", value),
	};
}

function matches(item: RuntimeItem, query: string): boolean {
	if (!query.trim()) return true;
	const needle = query.trim().toLocaleLowerCase();
	return [
		projectName(item),
		sessionName(item),
		text(item.session_id),
		text(item.generation_id),
		model(item),
		role(item),
		lifecycle(item),
	]
		.join(" ")
		.toLocaleLowerCase()
		.includes(needle);
}

function RouteHeader({
	actions,
	description,
	eyebrow = "Canonical runtime",
	title,
}: {
	readonly actions?: React.ReactNode;
	readonly description: string;
	readonly eyebrow?: string;
	readonly title: string;
}) {
	return (
		<header className={styles.header}>
			<div>
				<p className={styles.eyebrow}>{eyebrow}</p>
				<h1>{title}</h1>
				<p>{description}</p>
			</div>
			{actions ? <div className={styles.headerActions}>{actions}</div> : null}
		</header>
	);
}

function LoadingRoster() {
	return (
		<div className={styles.cardGrid} aria-label="Loading runtime sessions">
			<Skeleton width="min(100%, 32.5rem)" />
			<Skeleton width="min(100%, 32.5rem)" />
		</div>
	);
}

function RuntimeRoster({
	description,
	projectId,
	title,
}: {
	readonly description: string;
	readonly projectId?: string;
	readonly title: string;
}) {
	const filters = useRouteFilters();
	const page = useRuntimePage("live", {
		...(projectId ? { project_id: projectId } : {}),
		...(filters.state ? { state: filters.state } : {}),
	});
	const items = React.useMemo(
		() =>
			(page.data?.items ?? []).filter((item) => matches(item, filters.query)),
		[filters.query, page.data?.items],
	);
	const selected =
		items.find((item) => item.generation_id === filters.selectedSession) ??
		(page.data?.items ?? []).find(
			(item) => item.generation_id === filters.selectedSession,
		);
	return (
		<section className={styles.route} data-testid="runtime-roster">
			<RouteHeader
				description={description}
				title={title}
				actions={
					<div className={styles.filters}>
						<SearchField
							label="Find a session"
							onChange={filters.setQuery}
							placeholder="Session, model, role, or generation"
							value={filters.query}
						/>
						<Select
							label="Lifecycle state"
							onChange={filters.setState}
							options={lifecycleOptions}
							value={filters.state}
						/>
					</div>
				}
			/>
			<p className={styles.revision} aria-live="polite">
				{page.data
					? `Canonical revision ${page.data.resource_revision}`
					: "Loading canonical revision"}
			</p>
			{page.isPending ? <LoadingRoster /> : null}
			{page.isError ? (
				<StatePanel
					description="The live projection could not be loaded. The dashboard will retry without substituting legacy session data."
					kind="error"
					title="Live sessions unavailable"
				/>
			) : null}
			{!page.isPending && !page.isError && items.length === 0 ? (
				<StatePanel
					description={
						projectId
							? "This project has no eligible live generations for the current filter."
							: "No eligible live session generations are currently registered."
					}
					kind="empty"
					title="No live sessions"
				/>
			) : null}
			{items.length ? (
				<div
					className={styles.cardGrid}
					aria-label="Live session passport cards"
				>
					{items.map((item) => (
						<RuntimePassportCard
							item={item}
							key={text(item.generation_id)}
							onOpen={() =>
								filters.setSelectedSession(text(item.generation_id))
							}
						/>
					))}
				</div>
			) : null}
			<RuntimeSessionDrawer
				item={selected}
				onOpenChange={(open) => !open && filters.setSelectedSession(undefined)}
			/>
		</section>
	);
}

export function OverviewRoute() {
	return (
		<RuntimeRoster
			description="One canonical roster of eligible live session generations. Terminal generations belong in History."
			title="Runtime overview"
		/>
	);
}

export function SessionsRoute() {
	return (
		<RuntimeRoster
			description="Inspect live agents without combining compatibility registries or inferring liveness in the browser."
			title="Sessions"
		/>
	);
}

type ProjectSummary = Readonly<{
	id: string;
	name: string;
	items: readonly RuntimeItem[];
}>;

function projectSummaries(
	items: readonly RuntimeItem[],
): readonly ProjectSummary[] {
	const groups = new Map<string, RuntimeItem[]>();
	for (const item of items) {
		const id = text(item.project_id);
		groups.set(id, [...(groups.get(id) ?? []), item]);
	}
	return [...groups.entries()].map(([id, grouped]) => ({
		id,
		name: projectName(grouped[0] ?? {}),
		items: grouped,
	}));
}

export function ProjectsRoute() {
	const page = useRuntimePage("live");
	const summaries = projectSummaries(page.data?.items ?? []);
	return (
		<section className={styles.route} data-testid="runtime-projects">
			<RouteHeader
				description="Projects are grouped only from canonical live generations. A nested path or worktree never creates a second card by itself."
				title="Projects"
			/>
			{page.isPending ? <LoadingRoster /> : null}
			{page.isError ? (
				<StatePanel
					description="The typed project projection is unavailable."
					kind="error"
					title="Projects unavailable"
				/>
			) : null}
			{!page.isPending && !page.isError && summaries.length === 0 ? (
				<StatePanel
					description="No project has an eligible live generation."
					kind="empty"
					title="No live projects"
				/>
			) : null}
			<div className={styles.projectGrid}>
				{summaries.map((project) => (
					<Link
						className={styles.projectCard}
						key={project.id}
						to={`/projects/${encodeURIComponent(project.id)}`}
					>
						<p className={styles.eyebrow}>Canonical project</p>
						<h2>{project.name}</h2>
						<p>{project.id}</p>
						<StatusBadge
							label={`${project.items.length} live generation${project.items.length === 1 ? "" : "s"}`}
							tone="success"
						/>
					</Link>
				))}
			</div>
		</section>
	);
}

export function ProjectDetailRoute() {
	const { projectId } = useParams();
	if (!projectId)
		return (
			<StatePanel
				description="The requested project identifier is missing."
				kind="error"
				title="Project unavailable"
			/>
		);
	return (
		<RuntimeRoster
			description="Eligible live generations for this canonical project identity. Resumed generations remain one card each; terminal generations are in History."
			projectId={projectId}
			title={`Project ${projectId}`}
		/>
	);
}

function terminalTone(
	item: RuntimeItem,
): "success" | "warning" | "danger" | "neutral" {
	if (lifecycle(item) === "errored") return "danger";
	if (lifecycle(item) === "superseded") return "warning";
	return "neutral";
}

export function HistoryRoute() {
	const filters = useRouteFilters();
	const page = useRuntimePage(
		"history",
		filters.state ? { state: filters.state } : undefined,
	);
	// The runtime endpoint remains the authority for lifecycle state. Keep the
	// terminal rail presentation explicit so a broad paged history response can
	// never visually resurrect an eligible live generation into History.
	const items = (page.data?.items ?? []).filter(
		(item) => isTerminal(item) && matches(item, filters.query),
	);
	return (
		<section className={styles.route} data-testid="runtime-history">
			<RouteHeader
				description="Ended, errored, and superseded generations remain auditable here and never reappear in the live card rail."
				title="History"
				actions={
					<SearchField
						label="Search history"
						onChange={filters.setQuery}
						placeholder="Session, model, or generation"
						value={filters.query}
					/>
				}
			/>
			{page.isPending ? <LoadingRoster /> : null}
			{page.isError ? (
				<StatePanel
					description="The terminal-generation projection could not be loaded."
					kind="error"
					title="History unavailable"
				/>
			) : null}
			{!page.isPending && !page.isError && items.length === 0 ? (
				<StatePanel
					description="No terminal generations match this filter."
					kind="empty"
					title="No history"
				/>
			) : null}
			<ol className={styles.historyList} aria-label="Terminal session history">
				{items.map((item) => (
					<li key={text(item.generation_id)}>
						<div>
							<strong>{sessionName(item)}</strong>
							<span>
								{projectName(item)} · {model(item)}
							</span>
							<span>{text(item.generation_id)}</span>
						</div>
						<StatusBadge label={lifecycle(item)} tone={terminalTone(item)} />
					</li>
				))}
			</ol>
		</section>
	);
}

function diagnosticRemedy(code: string): string {
	if (/alias|ambiguous/iu.test(code))
		return "Review the canonical alias evidence; do not infer an identity from the legacy record.";
	if (/fence|endpoint|capabilit/iu.test(code))
		return "Inspect endpoint ownership, readiness, and capability evidence before retrying delivery.";
	if (/inbox|outbox|database|sqlite|service/iu.test(code))
		return "Use the bounded service health and durable queue checks, then retry after the owner recovers.";
	if (/ignored|stale/iu.test(code))
		return "Compare provenance and sequence facts; stale or duplicate observations are intentionally not materialized.";
	return "Inspect the redacted evidence and use the control-plane health checks before making a corrective action.";
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return "Unavailable";
	}
}

export function DiagnosticsRoute() {
	const filters = useRouteFilters();
	const page = useRuntimePage("diagnostics");
	const items = (page.data?.items ?? []).filter((item) =>
		[text(item.code), safeJson(item.details)]
			.join(" ")
			.toLocaleLowerCase()
			.includes(filters.query.toLocaleLowerCase()),
	);
	return (
		<section className={styles.route} data-testid="runtime-diagnostics">
			<RouteHeader
				description="Safe, bounded diagnostic evidence from the control plane. Secrets, prompt bodies, paths, and credentials are redacted before this screen receives data."
				title="Diagnostics"
				actions={
					<SearchField
						label="Filter diagnostics"
						onChange={filters.setQuery}
						placeholder="Code or safe evidence"
						value={filters.query}
					/>
				}
			/>
			{page.isPending ? <LoadingRoster /> : null}
			{page.isError ? (
				<StatePanel
					description="The diagnostic projection could not be loaded."
					kind="error"
					title="Diagnostics unavailable"
				/>
			) : null}
			{!page.isPending && !page.isError && items.length === 0 ? (
				<StatePanel
					description="No safe diagnostic records match this filter."
					kind="empty"
					title="No diagnostics"
				/>
			) : null}
			<div className={styles.diagnosticList}>
				{items.map((item) => {
					const code = text(item.code);
					return (
						<details key={text(item.id)}>
							<summary>
								<StatusBadge label={code} tone="warning" />
								<span>{text(item.created_at)}</span>
							</summary>
							<p>
								<strong>Suggested remedy:</strong> {diagnosticRemedy(code)}
							</p>
							<pre className={styles.safeJson}>{safeJson(item.details)}</pre>
						</details>
					);
				})}
			</div>
			{page.data ? (
				<aside
					className={styles.healthFacts}
					aria-label="Runtime service health facts"
				>
					<StatusBadge
						label={`Accepted events: ${number(page.data.explain.accepted)}`}
						tone="success"
					/>
					<StatusBadge
						label={`Rejected events: ${number(page.data.explain.rejected)}`}
						tone="warning"
					/>
					<StatusBadge
						label={`Drift: ${text(page.data.drift.status)}`}
						tone="neutral"
					/>
				</aside>
			) : null}
		</section>
	);
}

export function RuntimeRouteNotFound() {
	return (
		<StatePanel
			description="The canonical runtime route does not exist."
			kind="error"
			title="Route unavailable"
		/>
	);
}

export function isLiveOnly(item: RuntimeItem): boolean {
	return !isTerminal(item);
}

export function RuntimeFactSummary({ item }: { readonly item: RuntimeItem }) {
	return (
		<span>
			{endpointSummary(item)} · activity {activityAt(item) ?? "not recorded"} ·
			observed {observedAt(item) ?? "not recorded"}
		</span>
	);
}
