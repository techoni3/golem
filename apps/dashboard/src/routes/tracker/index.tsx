import {
	Button,
	InlineAlert,
	SearchField,
	Select,
	Skeleton,
	StatePanel,
	StatusBadge,
} from "@golem/ui";
import * as React from "react";
import {
	Link,
	useNavigate,
	useParams,
	useSearchParams,
} from "react-router-dom";

import {
	useRefreshWork,
	useWorkConnections,
	useWorkProjection,
} from "./data.js";
import { TicketDetailDrawer } from "./detail.js";
import { CreateTicketForm } from "./forms.js";
import styles from "./tracker.module.css";
import {
	formatTimestamp,
	ticketKindOptions,
	ticketTone,
	type WorkTicket,
} from "./types.js";

const allKindOptions = [
	{ id: "", label: "All kinds" },
	...ticketKindOptions,
] as const;

const connectionLabels = {
	connected: "Live",
	connecting: "Connecting",
	reconnecting: "Resyncing",
	error: "Connection error",
} as const;

export function WorkConnectionBanner() {
	const connections = useWorkConnections();
	const states = Object.values(connections);
	const aggregate = states.includes("error")
		? "error"
		: states.includes("reconnecting")
			? "reconnecting"
			: states.every((state) => state === "connected")
				? "connected"
				: "connecting";
	if (aggregate === "connected")
		return (
			<span
				className={styles.connectionOk}
				data-state={aggregate}
				data-testid="work-connection"
				role="status"
			>
				Canonical work streams live
			</span>
		);
	return (
		<div data-state={aggregate} data-testid="work-connection">
			<InlineAlert tone={aggregate === "error" ? "danger" : "warning"}>
				{aggregate === "error"
					? "A work stream could not reconnect. Visible resources remain complete snapshots and can be refreshed manually."
					: aggregate === "reconnecting"
						? "Refreshing complete canonical resources after a stream interruption."
						: "Connecting to canonical work streams."}
			</InlineAlert>
		</div>
	);
}

function matches(
	ticket: WorkTicket,
	query: string,
	kind: string,
	phase: string,
): boolean {
	if (kind && ticket.kind !== kind) return false;
	if (phase && ticket.phase !== phase) return false;
	if (!query.trim()) return true;
	const needle = query.trim().toLocaleLowerCase();
	return [
		ticket.opaque_id,
		ticket.kind,
		ticket.phase,
		ticket.state,
		ticket.priority ?? "",
	]
		.join(" ")
		.toLocaleLowerCase()
		.includes(needle);
}

function TicketCard({
	parentId,
	ticket,
}: {
	readonly parentId: string | undefined;
	readonly ticket: WorkTicket;
}) {
	return (
		<li className={styles.ticketCard} data-ticket-id={ticket.opaque_id}>
			<div className={styles.cardTopline}>
				<div className={styles.badgeRow}>
					<StatusBadge label={ticket.phase} tone={ticketTone(ticket.phase)} />
					<StatusBadge label={ticket.kind} tone="info" />
				</div>
				<span className={styles.revision}>r{ticket.revision}</span>
			</div>
			<h2>
				<Link to={`/tickets/${ticket.opaque_id}`}>{ticket.opaque_id}</Link>
			</h2>
			<p>
				{ticket.priority ?? "No priority"} · legacy state {ticket.state}
			</p>
			<dl className={styles.cardFacts}>
				<div>
					<dt>Updated</dt>
					<dd>{formatTimestamp(ticket.updated_at)}</dd>
				</div>
				{parentId ? (
					<div>
						<dt>Parent</dt>
						<dd>{parentId}</dd>
					</div>
				) : null}
			</dl>
			<Link className={styles.openLink} to={`/tickets/${ticket.opaque_id}`}>
				Open canonical detail
			</Link>
		</li>
	);
}

function TrackerRouteContent({
	selectedId,
}: {
	readonly selectedId: string | undefined;
}) {
	const navigate = useNavigate();
	const [searchParams, setSearchParams] = useSearchParams();
	const board = useWorkProjection("tracker.board");
	const tree = useWorkProjection("tracker.tree");
	const connections = useWorkConnections();
	const refresh = useRefreshWork();
	const query = searchParams.get("q") ?? "";
	const kind = searchParams.get("kind") ?? "";
	const phase = searchParams.get("phase") ?? "";
	const setFilter = (key: string, value: string) => {
		setSearchParams((current) => {
			const next = new URLSearchParams(current);
			if (value) next.set(key, value);
			else next.delete(key);
			return next;
		});
	};
	const parentById = React.useMemo(
		() =>
			new Map(
				(tree.data?.items ?? []).map((ticket) => [
					ticket.opaque_id,
					ticket.parent_opaque_id,
				]),
			),
		[tree.data?.items],
	);
	const phases = React.useMemo(
		() =>
			[...new Set((board.data?.items ?? []).map((ticket) => ticket.phase))]
				.sort()
				.map((value) => ({ id: value, label: value })),
		[board.data?.items],
	);
	const visible = React.useMemo(
		() =>
			(board.data?.items ?? []).filter((ticket) =>
				matches(ticket, query, kind, phase),
			),
		[board.data?.items, kind, phase, query],
	);
	const connectionState = Object.values(connections).includes("error")
		? "error"
		: Object.values(connections).includes("reconnecting")
			? "reconnecting"
			: Object.values(connections).every((state) => state === "connected")
				? "connected"
				: "connecting";

	return (
		<section className={styles.route} data-testid="tracker-dispatch-ui">
			<header className={styles.header}>
				<div>
					<p className={styles.eyebrow}>Canonical tracker</p>
					<h1>Work board</h1>
					<p>
						Typed ticket facts and revision-checked actions from the bounded
						browser control plane.
					</p>
				</div>
				<Button onPress={() => void refresh()} variant="secondary">
					Refresh snapshots
				</Button>
			</header>

			<div className={styles.toolbar}>
				<SearchField
					description="Searches only fields exposed by the browser-work contract."
					label="Find a ticket"
					onChange={(value) => setFilter("q", value)}
					placeholder="Opaque ID, kind, phase, or priority"
					value={query}
				/>
				<Select
					label="Kind"
					onChange={(value) => setFilter("kind", value)}
					options={allKindOptions}
					value={kind}
				/>
				<Select
					label="Phase"
					onChange={(value) => setFilter("phase", value)}
					options={[{ id: "", label: "All phases" }, ...phases]}
					value={phase}
				/>
			</div>

			<div className={styles.revisionBar} aria-live="polite">
				<span>
					{board.data
						? `Canonical board revision ${board.data.resource_revision}`
						: "Loading canonical board"}
				</span>
				<span>{visible.length} visible</span>
				<span>{connectionLabels[connectionState]}</span>
			</div>

			<details className={styles.composer}>
				<summary>Create a typed ticket</summary>
				<CreateTicketForm />
			</details>

			{board.isPending ? (
				<div
					className={styles.ticketGrid}
					aria-label="Loading tickets"
					role="status"
				>
					<Skeleton />
					<Skeleton />
					<Skeleton />
				</div>
			) : null}
			{board.isError ? (
				<StatePanel
					description="The canonical board could not be loaded. Legacy tracker data has not been substituted."
					kind="error"
					title="Tracker unavailable"
				/>
			) : null}
			{!board.isPending && !board.isError && visible.length === 0 ? (
				<StatePanel
					description="No ticket in this bounded page matches the current filters."
					kind="empty"
					title="No matching tickets"
				/>
			) : null}
			{visible.length ? (
				<ul className={styles.ticketGrid} aria-label="Canonical work tickets">
					{visible.map((ticket) => (
						<TicketCard
							key={ticket.opaque_id}
							parentId={parentById.get(ticket.opaque_id)}
							ticket={ticket}
						/>
					))}
				</ul>
			) : null}
			{board.data?.next_cursor ? (
				<InlineAlert tone="info">
					This view shows the current bounded page. The public client does not
					yet expose page-cursor traversal, so no hidden legacy request is made.
				</InlineAlert>
			) : null}

			<TicketDetailDrawer
				opaqueId={selectedId}
				onClose={() => void navigate("/tracker")}
			/>
		</section>
	);
}

export function TrackerRoute() {
	return <TrackerRouteContent selectedId={undefined} />;
}

export function TicketRoute() {
	const { id } = useParams<{ id: string }>();
	return <TrackerRouteContent selectedId={id} />;
}
