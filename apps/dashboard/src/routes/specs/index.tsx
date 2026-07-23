import {
	InlineAlert,
	SearchField,
	Select,
	Skeleton,
	StatePanel,
	StatusBadge,
} from "@golem/ui";
import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";

import { useWorkProjection } from "../tracker/data.js";
import { CreateTicketForm } from "../tracker/forms.js";
import {
	formatTimestamp,
	ticketTone,
	type WorkTreeTicket,
} from "../tracker/types.js";
import styles from "./specs.module.css";

const specKinds = new Set(["spec", "decision", "question"]);
const kindOptions = [
	{ id: "", label: "Specs, decisions, and questions" },
	{ id: "spec", label: "Specs" },
	{ id: "decision", label: "Decisions" },
	{ id: "question", label: "Questions" },
] as const;

type TreeRow = Readonly<{ depth: number; ticket: WorkTreeTicket }>;

function orderedTree(items: readonly WorkTreeTicket[]): readonly TreeRow[] {
	const visible = new Set(items.map((ticket) => ticket.opaque_id));
	const children = new Map<string | undefined, WorkTreeTicket[]>();
	for (const ticket of items) {
		const parent =
			ticket.parent_opaque_id && visible.has(ticket.parent_opaque_id)
				? ticket.parent_opaque_id
				: undefined;
		children.set(parent, [...(children.get(parent) ?? []), ticket]);
	}
	const rows: TreeRow[] = [];
	const visited = new Set<string>();
	const visit = (ticket: WorkTreeTicket, depth: number) => {
		if (visited.has(ticket.opaque_id)) return;
		visited.add(ticket.opaque_id);
		rows.push({ ticket, depth: Math.min(depth, 6) });
		for (const child of children.get(ticket.opaque_id) ?? [])
			visit(child, depth + 1);
	};
	for (const root of children.get(undefined) ?? []) visit(root, 0);
	for (const item of items) visit(item, 0);
	return rows;
}

function matches(ticket: WorkTreeTicket, query: string, kind: string): boolean {
	if (!specKinds.has(ticket.kind)) return false;
	if (kind && ticket.kind !== kind) return false;
	if (!query.trim()) return true;
	const needle = query.trim().toLocaleLowerCase();
	return [
		ticket.opaque_id,
		ticket.kind,
		ticket.phase,
		ticket.parent_opaque_id ?? "",
	]
		.join(" ")
		.toLocaleLowerCase()
		.includes(needle);
}

export function SpecsRoute() {
	const projection = useWorkProjection("tracker.tree");
	const [searchParams, setSearchParams] = useSearchParams();
	const query = searchParams.get("q") ?? "";
	const kind = searchParams.get("kind") ?? "";
	const setFilter = (key: string, value: string) => {
		setSearchParams((current) => {
			const next = new URLSearchParams(current);
			if (value) next.set(key, value);
			else next.delete(key);
			return next;
		});
	};
	const rows = React.useMemo(
		() =>
			orderedTree(projection.data?.items ?? []).filter(({ ticket }) =>
				matches(ticket, query, kind),
			),
		[kind, projection.data?.items, query],
	);

	return (
		<section className={styles.route} data-testid="specs-ui">
			<header className={styles.header}>
				<div>
					<p className={styles.eyebrow}>Canonical relationships</p>
					<h1>Specs and decisions</h1>
					<p>
						A bounded parent tree for specs, decision records, and blocking
						questions. Links open the same revision-checked ticket drawer.
					</p>
				</div>
			</header>

			<div className={styles.toolbar}>
				<SearchField
					label="Find a spec record"
					onChange={(value) => setFilter("q", value)}
					placeholder="Opaque ID, parent, phase, or kind"
					value={query}
				/>
				<Select
					label="Record kind"
					onChange={(value) => setFilter("kind", value)}
					options={kindOptions}
					value={kind}
				/>
			</div>
			<p className={styles.revision} aria-live="polite">
				{projection.data
					? `Canonical tree revision ${projection.data.resource_revision} · ${rows.length} visible`
					: "Loading canonical tree"}
			</p>

			<details className={styles.composer}>
				<summary>Create a spec-family ticket</summary>
				<CreateTicketForm defaultKind="spec" scope="specs" />
			</details>

			{projection.isPending ? (
				<div
					className={styles.list}
					aria-label="Loading spec tree"
					role="status"
				>
					<Skeleton />
					<Skeleton />
				</div>
			) : null}
			{projection.isError ? (
				<StatePanel
					description="The canonical tracker tree could not be loaded. No legacy hierarchy has been substituted."
					kind="error"
					title="Spec tree unavailable"
				/>
			) : null}
			{!projection.isPending && !projection.isError && rows.length === 0 ? (
				<StatePanel
					description="No spec, decision, or question in this bounded page matches the current filters."
					kind="empty"
					title="No matching spec records"
				/>
			) : null}
			{rows.length ? (
				<ol className={styles.list} aria-label="Spec relationship tree">
					{rows.map(({ depth, ticket }) => (
						<li
							className={styles.row}
							data-depth={depth}
							key={ticket.opaque_id}
							style={{ paddingInlineStart: `${1 + depth * 1.25}rem` }}
						>
							<div>
								<span className={styles.branch} aria-hidden="true">
									{depth ? "↳" : "◆"}
								</span>
								<div>
									<Link to={`/tickets/${ticket.opaque_id}`}>
										{ticket.opaque_id}
									</Link>
									<p>
										{ticket.parent_opaque_id
											? `Child of ${ticket.parent_opaque_id}`
											: "Root record"}{" "}
										· updated {formatTimestamp(ticket.updated_at)}
									</p>
								</div>
							</div>
							<div className={styles.badges}>
								<StatusBadge label={ticket.kind} tone="info" />
								<StatusBadge
									label={ticket.phase}
									tone={ticketTone(ticket.phase)}
								/>
								<span>r{ticket.revision}</span>
							</div>
						</li>
					))}
				</ol>
			) : null}
			{projection.data?.next_cursor ? (
				<InlineAlert tone="info">
					Additional canonical pages exist, but page-cursor traversal is not
					exposed by the current public client.
				</InlineAlert>
			) : null}
		</section>
	);
}
