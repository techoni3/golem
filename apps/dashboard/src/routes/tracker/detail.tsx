import {
	Button,
	Drawer,
	InlineAlert,
	Select,
	Skeleton,
	StatePanel,
	StatusBadge,
	TextField,
} from "@golem/ui";
import type * as React from "react";
import { Link } from "react-router-dom";

import { useWorkCommand, useWorkDetail, useWorkProjection } from "./data.js";
import { CommandFeedback, useRetainedDraft } from "./forms.js";
import styles from "./tracker.module.css";
import {
	formatTimestamp,
	idempotencyKey,
	phaseOptions,
	ticketTone,
} from "./types.js";

type DetailDraft = {
	priority: "unchanged" | "P0" | "P1" | "P2" | "P3";
	title: string;
	transition: (typeof phaseOptions)[number]["id"];
};

const updatePriorityOptions = [
	{ id: "unchanged", label: "Keep current priority" },
	{ id: "P0", label: "Set P0 · Critical" },
	{ id: "P1", label: "Set P1 · High" },
	{ id: "P2", label: "Set P2 · Normal" },
	{ id: "P3", label: "Set P3 · Low" },
] as const;

export function TicketDetailDrawer({
	opaqueId,
	onClose,
}: {
	readonly opaqueId: string | undefined;
	readonly onClose: () => void;
}) {
	const detail = useWorkDetail(opaqueId);
	const tree = useWorkProjection("tracker.tree");
	const updateCommand = useWorkCommand();
	const transitionCommand = useWorkCommand();
	const dispatchCommand = useWorkCommand();
	const [draft, setDraft, clearDraft] = useRetainedDraft<DetailDraft>(
		`golem:work:detail:${opaqueId ?? "none"}`,
		{ priority: "unchanged", title: "", transition: "queued" },
	);
	const item = detail.data?.item;
	const relationship = tree.data?.items.find(
		(ticket) => ticket.opaque_id === opaqueId,
	);
	const children =
		tree.data?.items.filter((ticket) => ticket.parent_opaque_id === opaqueId) ??
		[];

	const submitUpdate = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!item || updateCommand.isPending) return;
		const title = draft.title.trim();
		if (!title && draft.priority === "unchanged") return;
		updateCommand.mutate(
			{
				kind: "ticket.update",
				idempotency_key: idempotencyKey("dashboard-ticket-update"),
				opaque_id: item.opaque_id,
				expected_revision: item.revision,
				...(title ? { title } : {}),
				...(draft.priority === "unchanged" ? {} : { priority: draft.priority }),
			},
			{
				onSuccess(response) {
					if (response.status === "completed") clearDraft();
				},
			},
		);
	};

	const submitTransition = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!item || transitionCommand.isPending) return;
		transitionCommand.mutate({
			kind: "ticket.transition",
			idempotency_key: idempotencyKey("dashboard-ticket-transition"),
			opaque_id: item.opaque_id,
			expected_revision: item.revision,
			phase: draft.transition,
		});
	};

	const dispatch = () => {
		if (!item || dispatchCommand.isPending) return;
		dispatchCommand.mutate({
			kind: "dispatch",
			idempotency_key: idempotencyKey("dashboard-ticket-dispatch"),
			opaque_id: item.opaque_id,
			expected_revision: item.revision,
		});
	};

	return (
		<Drawer
			isOpen={opaqueId !== undefined}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={opaqueId ? `Ticket ${opaqueId}` : "Ticket"}
		>
			<div className={styles.drawerBody}>
				{detail.isPending ? (
					<>
						<Skeleton width="100%" />
						<Skeleton width="70%" />
					</>
				) : null}
				{detail.isError ? (
					<StatePanel
						description="The canonical ticket detail could not be loaded. No board data has been substituted."
						kind="error"
						title="Ticket unavailable"
					/>
				) : null}
				{item ? (
					<>
						<section className={styles.detailSummary}>
							<div className={styles.badgeRow}>
								<StatusBadge label={item.phase} tone={ticketTone(item.phase)} />
								<StatusBadge label={item.kind} tone="info" />
								<StatusBadge
									label={item.priority ?? "No priority"}
									tone="neutral"
								/>
							</div>
							<dl className={styles.facts}>
								<div>
									<dt>Opaque ID</dt>
									<dd>{item.opaque_id}</dd>
								</div>
								<div>
									<dt>Revision</dt>
									<dd>{item.revision}</dd>
								</div>
								<div>
									<dt>Legacy state</dt>
									<dd>{item.state}</dd>
								</div>
								<div>
									<dt>Updated</dt>
									<dd>{formatTimestamp(item.updated_at)}</dd>
								</div>
							</dl>
							{relationship?.parent_opaque_id ? (
								<p className={styles.relationship}>
									Parent:{" "}
									<Link to={`/tickets/${relationship.parent_opaque_id}`}>
										{relationship.parent_opaque_id}
									</Link>
								</p>
							) : null}
							{children.length ? (
								<div className={styles.relationship}>
									<span>Children</span>
									<ul>
										{children.map((child) => (
											<li key={child.opaque_id}>
												<Link to={`/tickets/${child.opaque_id}`}>
													{child.opaque_id}
												</Link>
											</li>
										))}
									</ul>
								</div>
							) : null}
						</section>

						<InlineAlert tone="info">
							The bounded detail contract does not expose body text, comments,
							or labels. This drawer never fills those fields from legacy
							payloads.
						</InlineAlert>

						<form className={styles.form} onSubmit={submitUpdate}>
							<h3>Update fields</h3>
							<TextField
								description="Leave blank to keep the current title. The current title is intentionally not exposed by this browser contract."
								label="Replacement title"
								onChange={(title) =>
									setDraft((current) => ({ ...current, title }))
								}
								value={draft.title}
							/>
							<Select
								label="Priority"
								onChange={(priority) =>
									setDraft((current) => ({
										...current,
										priority: priority as DetailDraft["priority"],
									}))
								}
								options={updatePriorityOptions}
								value={draft.priority}
							/>
							<Button
								isDisabled={
									!draft.title.trim() && draft.priority === "unchanged"
								}
								loading={updateCommand.isPending}
								type="submit"
								variant="primary"
							>
								Apply update
							</Button>
							<CommandFeedback
								error={updateCommand.error}
								response={updateCommand.data}
							/>
						</form>

						<form className={styles.form} onSubmit={submitTransition}>
							<h3>Request phase transition</h3>
							<Select
								label="Target phase"
								onChange={(transition) =>
									setDraft((current) => ({
										...current,
										transition: transition as DetailDraft["transition"],
									}))
								}
								options={phaseOptions}
								value={draft.transition}
							/>
							<p className={styles.helper}>
								The browser does not infer legal transitions. The tracker
								validates this request against the canonical phase machine.
							</p>
							<Button
								loading={transitionCommand.isPending}
								type="submit"
								variant="secondary"
							>
								Request transition
							</Button>
							<CommandFeedback
								error={transitionCommand.error}
								response={transitionCommand.data}
							/>
						</form>

						<section className={styles.form}>
							<h3>Dispatch</h3>
							<p className={styles.helper}>
								Dispatch returns an operation and settlement path; this UI never
								treats enqueueing as delivery.
							</p>
							<Button
								loading={dispatchCommand.isPending}
								onPress={dispatch}
								variant="secondary"
							>
								Dispatch ticket
							</Button>
							<CommandFeedback
								error={dispatchCommand.error}
								response={dispatchCommand.data}
							/>
							{dispatchCommand.data?.result.kind === "dispatch" ? (
								<dl className={styles.facts}>
									<div>
										<dt>Disposition</dt>
										<dd>{dispatchCommand.data.result.disposition}</dd>
									</div>
									<div>
										<dt>Operation</dt>
										<dd>{dispatchCommand.data.result.operation_id}</dd>
									</div>
									{dispatchCommand.data.result.remediation ? (
										<div>
											<dt>Remediation</dt>
											<dd>{dispatchCommand.data.result.remediation}</dd>
										</div>
									) : null}
								</dl>
							) : null}
						</section>
					</>
				) : null}
			</div>
		</Drawer>
	);
}
