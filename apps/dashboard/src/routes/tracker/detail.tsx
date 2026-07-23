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
import * as React from "react";
import { Link } from "react-router-dom";

import { useWorkAsset, useWorkCommand, useWorkDetail } from "./data.js";
import {
	CommandFeedback,
	CreateCommentForm,
	CreateLinkForm,
	CreateStreamForm,
	CreateTicketForm,
	useRetainedDraft,
} from "./forms.js";
import styles from "./tracker.module.css";
import { formatTimestamp, idempotencyKey, ticketTone } from "./types.js";

type DetailDraft = {
	body: string;
	labels: string;
	parentId: string;
	priority: "unchanged" | "P0" | "P1" | "P2" | "P3";
	reason: string;
	streamId: string;
	title: string;
	transition: string;
	wave: string;
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
	const updateCommand = useWorkCommand();
	const transitionCommand = useWorkCommand();
	const dispatchCommand = useWorkCommand();
	const [selectedAssetId, setSelectedAssetId] = React.useState<
		string | undefined
	>();
	const asset = useWorkAsset(opaqueId, selectedAssetId);
	const [draft, setDraft, clearDraft] = useRetainedDraft<DetailDraft>(
		`golem:work:detail:${opaqueId ?? "none"}`,
		{
			body: "",
			labels: "",
			parentId: "",
			priority: "unchanged",
			reason: "",
			streamId: "",
			title: "",
			transition: "",
			wave: "",
		},
	);
	const workDetail = detail.data;
	const item = workDetail?.item;
	const children = workDetail?.children ?? [];
	const legalPhaseOptions = (item?.legal_phases ?? []).map((phase) => ({
		id: phase,
		label: `${phase.charAt(0).toUpperCase()}${phase.slice(1)}`,
	}));
	const transition =
		item?.legal_phases.includes(draft.transition) === true
			? draft.transition
			: item?.legal_phases[0];

	const submitUpdate = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!item || updateCommand.isPending) return;
		const title = draft.title.trim();
		const labels = draft.labels
			.split(",")
			.map((label) => label.trim())
			.filter(Boolean);
		const wave = Number.parseInt(draft.wave, 10);
		if (
			!title &&
			!draft.body &&
			!labels.length &&
			!draft.parentId.trim() &&
			!draft.streamId.trim() &&
			!Number.isSafeInteger(wave) &&
			draft.priority === "unchanged"
		)
			return;
		updateCommand.mutate(
			{
				kind: "ticket.update",
				idempotency_key: idempotencyKey("dashboard-ticket-update"),
				opaque_id: item.opaque_id,
				expected_revision: item.revision,
				...(title ? { title } : {}),
				...(draft.body ? { body: draft.body } : {}),
				...(draft.priority === "unchanged" ? {} : { priority: draft.priority }),
				...(labels.length ? { labels } : {}),
				...(draft.parentId.trim()
					? { parent_opaque_id: draft.parentId.trim() }
					: {}),
				...(draft.streamId.trim()
					? { stream_opaque_id: draft.streamId.trim() }
					: {}),
				...(Number.isSafeInteger(wave) && wave > 0 ? { wave } : {}),
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
		if (!item || !transition || transitionCommand.isPending) return;
		transitionCommand.mutate({
			kind: "ticket.transition",
			idempotency_key: idempotencyKey("dashboard-ticket-transition"),
			opaque_id: item.opaque_id,
			expected_revision: item.revision,
			phase: transition,
			...(draft.reason.trim() ? { reason: draft.reason.trim() } : {}),
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
				{item && workDetail ? (
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
							<h2>{item.title}</h2>
							{workDetail.body ? (
								<p className={styles.bodyText}>{workDetail.body}</p>
							) : (
								<p className={styles.helper}>No body.</p>
							)}
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
								<div>
									<dt>Labels</dt>
									<dd>{item.labels.join(", ") || "None"}</dd>
								</div>
								<div>
									<dt>Stream</dt>
									<dd>{item.stream_opaque_id ?? "None"}</dd>
								</div>
								<div>
									<dt>Wave</dt>
									<dd>{item.wave ?? "None"}</dd>
								</div>
								<div>
									<dt>Assignee</dt>
									<dd>{item.has_assignee ? "Assigned" : "Unassigned"}</dd>
								</div>
							</dl>
							{item.parent_opaque_id ? (
								<p className={styles.relationship}>
									Parent:{" "}
									<Link to={`/tickets/${item.parent_opaque_id}`}>
										{item.parent_opaque_id}
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

						<form className={styles.form} onSubmit={submitUpdate}>
							<h3>Update fields</h3>
							<TextField
								description={`Current: ${item.title}. Leave blank to keep it.`}
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
							<TextField
								description={`Current: ${item.labels.join(", ") || "none"}.`}
								label="Replacement labels"
								onChange={(labels) =>
									setDraft((current) => ({ ...current, labels }))
								}
								placeholder="Comma-separated; blank keeps current"
								value={draft.labels}
							/>
							<TextField
								description={`Current: ${item.parent_opaque_id ?? "none"}.`}
								label="Replacement parent ID"
								onChange={(parentId) =>
									setDraft((current) => ({ ...current, parentId }))
								}
								value={draft.parentId}
							/>
							<TextField
								description={`Current: ${item.stream_opaque_id ?? "none"}.`}
								label="Replacement stream ID"
								onChange={(streamId) =>
									setDraft((current) => ({ ...current, streamId }))
								}
								value={draft.streamId}
							/>
							<TextField
								description={`Current: ${item.wave ?? "none"}.`}
								label="Replacement wave"
								onChange={(wave) =>
									setDraft((current) => ({ ...current, wave }))
								}
								value={draft.wave}
							/>
							<label>
								<span className={styles.fieldLabel}>Replacement body</span>
								<textarea
									className={styles.textarea}
									onChange={(event) =>
										setDraft((current) => ({
											...current,
											body: event.currentTarget.value,
										}))
									}
									placeholder="Blank keeps the current body"
									value={draft.body}
								/>
							</label>
							<Button
								isDisabled={
									!draft.title.trim() &&
									!draft.body &&
									!draft.labels.trim() &&
									!draft.parentId.trim() &&
									!draft.streamId.trim() &&
									!draft.wave.trim() &&
									draft.priority === "unchanged"
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
							{legalPhaseOptions.length ? (
								<Select
									label="Target phase"
									onChange={(nextPhase) =>
										setDraft((current) => ({
											...current,
											transition: nextPhase,
										}))
									}
									options={legalPhaseOptions}
									value={transition ?? ""}
								/>
							) : (
								<InlineAlert tone="info">
									The server reports no currently legal transition.
								</InlineAlert>
							)}
							<TextField
								description="Required for blocked or parked transitions."
								label="Reason"
								onChange={(reason) =>
									setDraft((current) => ({ ...current, reason }))
								}
								value={draft.reason}
							/>
							<p className={styles.helper}>
								These candidates come from the canonical phase machine and
								durable evidence. The server validates again when submitted.
							</p>
							<Button
								isDisabled={!transition}
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
							<h3>Comments and replies</h3>
							{workDetail.comments.length ? (
								<ul className={styles.commentList}>
									{workDetail.comments.map((comment) => (
										<li key={comment.opaque_id}>
											<div className={styles.badgeRow}>
												<StatusBadge
													label={comment.author_kind}
													tone="neutral"
												/>
												<StatusBadge label={comment.tag} tone="info" />
												{comment.parent_opaque_id ? (
													<span className={styles.helper}>
														Reply to {comment.parent_opaque_id}
													</span>
												) : null}
											</div>
											<p className={styles.bodyText}>{comment.body}</p>
										</li>
									))}
								</ul>
							) : (
								<p className={styles.helper}>No comments yet.</p>
							)}
						</section>
						<CreateCommentForm
							comments={workDetail.comments}
							opaqueId={item.opaque_id}
						/>

						<section className={styles.form}>
							<h3>Links</h3>
							{workDetail.links.length ? (
								<ul className={styles.commentList}>
									{workDetail.links.map((link) => (
										<li key={link.opaque_id}>
											{link.relation}{" "}
											<Link to={`/tickets/${link.target_opaque_id}`}>
												{link.target_opaque_id}
											</Link>
										</li>
									))}
								</ul>
							) : (
								<p className={styles.helper}>No links yet.</p>
							)}
						</section>
						<CreateLinkForm opaqueId={item.opaque_id} />

						<details className={styles.composer}>
							<summary>Create a child ticket</summary>
							<CreateTicketForm
								defaultParent={item.opaque_id}
								scope={`child:${item.opaque_id}`}
							/>
						</details>

						<section className={styles.form}>
							<h3>Streams</h3>
							{workDetail.streams.length ? (
								<ul className={styles.commentList}>
									{workDetail.streams.map((stream) => (
										<li key={stream.opaque_id}>
											<strong>{stream.name}</strong>
											<p className={styles.helper}>
												{stream.opaque_id} · {stream.mode}
											</p>
										</li>
									))}
								</ul>
							) : (
								<p className={styles.helper}>No streams yet.</p>
							)}
						</section>
						<CreateStreamForm />

						<section className={styles.form}>
							<h3>Safe assets</h3>
							{workDetail.assets.length ? (
								<ul className={styles.assetList}>
									{workDetail.assets.map((entry) => (
										<li key={entry.opaque_id}>
											<div className={styles.badgeRow}>
												<code>{entry.opaque_id}</code>
												<span className={styles.helper}>
													{entry.mime_type} · {entry.byte_size} bytes
												</span>
												<Button
													onPress={() => setSelectedAssetId(entry.opaque_id)}
													variant="secondary"
												>
													Read asset
												</Button>
											</div>
										</li>
									))}
								</ul>
							) : (
								<p className={styles.helper}>No ticket-bound assets.</p>
							)}
							{asset.isError ? (
								<InlineAlert tone="danger">
									The scoped asset read was refused.
								</InlineAlert>
							) : null}
							{asset.data ? (
								<img
									alt={`Ticket asset ${asset.data.asset.opaque_id}`}
									src={`data:${asset.data.asset.mime_type};base64,${asset.data.content_base64}`}
								/>
							) : null}
						</section>

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
