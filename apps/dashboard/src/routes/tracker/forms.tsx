import { Button, InlineAlert, Select, TextField } from "@golem/ui";
import * as React from "react";
import { useNavigate } from "react-router-dom";

import { useWorkCommand } from "./data.js";
import styles from "./tracker.module.css";
import {
	idempotencyKey,
	priorityOptions,
	ticketKindOptions,
	type WorkCommandResponse,
	type WorkDetail,
} from "./types.js";

type CreateDraft = {
	body: string;
	kind: (typeof ticketKindOptions)[number]["id"];
	labels: string;
	parentId: string;
	priority: "" | "P0" | "P1" | "P2" | "P3";
	streamId: string;
	title: string;
	wave: string;
};

type GateDraft = {
	assignee: string;
	gateKind: "approval" | "input";
	question: string;
};

function loadDraft<Value>(key: string, fallback: Value): Value {
	try {
		const saved = globalThis.sessionStorage.getItem(key);
		return saved ? (JSON.parse(saved) as Value) : fallback;
	} catch {
		return fallback;
	}
}

export function useRetainedDraft<Value>(
	key: string,
	fallback: Value,
): readonly [Value, React.Dispatch<React.SetStateAction<Value>>, () => void] {
	const fallbackRef = React.useRef(fallback);
	const [value, setValue] = React.useState<Value>(() =>
		loadDraft(key, fallbackRef.current),
	);

	React.useEffect(() => {
		setValue(loadDraft(key, fallbackRef.current));
	}, [key]);
	React.useEffect(() => {
		try {
			globalThis.sessionStorage.setItem(key, JSON.stringify(value));
		} catch {
			// Storage can be unavailable in hardened browser contexts. The live
			// React draft remains intact for the current route.
		}
	}, [key, value]);

	return [
		value,
		setValue,
		() => {
			try {
				globalThis.sessionStorage.removeItem(key);
			} catch {
				// Clearing storage is best effort; clearing React state is not.
			}
			setValue(fallbackRef.current);
		},
	] as const;
}

function responseCopy(response: WorkCommandResponse): string {
	if (response.status === "completed") return "Command completed.";
	if (response.status === "conflict")
		return "The canonical revision changed. Your draft is retained; review the refreshed ticket before submitting again.";
	if (response.status === "idempotency_mismatch")
		return "The server rejected an idempotency-key mismatch. Nothing was retried.";
	return "The command was rejected. Your draft is retained.";
}

export function CommandFeedback({
	error,
	response,
}: {
	readonly error: Error | null;
	readonly response: WorkCommandResponse | undefined;
}) {
	if (error)
		return (
			<InlineAlert tone="danger">
				The control plane rejected the request ({error.message}). Nothing was
				retried and the draft is retained.
			</InlineAlert>
		);
	if (!response) return null;
	return (
		<InlineAlert tone={response.status === "completed" ? "success" : "warning"}>
			{responseCopy(response)}
		</InlineAlert>
	);
}

export function CreateTicketForm({
	defaultKind = "work-item",
	defaultParent = "",
	scope = "tracker",
}: {
	readonly defaultKind?: CreateDraft["kind"];
	readonly defaultParent?: string;
	readonly scope?: string;
}) {
	const navigate = useNavigate();
	const command = useWorkCommand();
	const [draft, setDraft, clearDraft] = useRetainedDraft<CreateDraft>(
		`golem:work:create:${scope}`,
		{
			body: "",
			kind: defaultKind,
			labels: "",
			parentId: defaultParent,
			priority: "",
			streamId: "",
			title: "",
			wave: "",
		},
	);

	const submit = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const title = draft.title.trim();
		if (!title || command.isPending) return;
		const labels = draft.labels
			.split(",")
			.map((label) => label.trim())
			.filter(Boolean);
		const wave = Number.parseInt(draft.wave, 10);
		command.mutate(
			{
				kind: "ticket.create",
				idempotency_key: idempotencyKey(`dashboard-${scope}-create`),
				ticket_kind: draft.kind,
				title,
				...(draft.body ? { body: draft.body } : {}),
				...(draft.priority ? { priority: draft.priority } : {}),
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
					if (
						response.status === "completed" &&
						response.result.kind === "ticket"
					) {
						clearDraft();
						void navigate(`/tickets/${response.result.ticket.opaque_id}`);
					}
				},
			},
		);
	};

	return (
		<form className={styles.form} onSubmit={submit}>
			<div className={styles.formGrid}>
				<TextField
					label={defaultKind === "spec" ? "Spec title" : "Ticket title"}
					onChange={(title) => setDraft((current) => ({ ...current, title }))}
					placeholder="A concrete, outcome-led title"
					value={draft.title}
				/>
				<Select
					label="Kind"
					onChange={(kind) =>
						setDraft((current) => ({
							...current,
							kind: kind as CreateDraft["kind"],
						}))
					}
					options={ticketKindOptions}
					value={draft.kind}
				/>
				<Select
					label="Priority"
					onChange={(priority) =>
						setDraft((current) => ({
							...current,
							priority: priority as CreateDraft["priority"],
						}))
					}
					options={priorityOptions}
					value={draft.priority}
				/>
				<TextField
					description="Optional, comma-separated. The server validates the final set."
					label="Labels"
					onChange={(labels) => setDraft((current) => ({ ...current, labels }))}
					placeholder="dashboard, operator"
					value={draft.labels}
				/>
				<TextField
					label="Parent ticket ID"
					onChange={(parentId) =>
						setDraft((current) => ({ ...current, parentId }))
					}
					placeholder="Optional"
					value={draft.parentId}
				/>
				<TextField
					label="Stream ID"
					onChange={(streamId) =>
						setDraft((current) => ({ ...current, streamId }))
					}
					placeholder="Optional"
					value={draft.streamId}
				/>
				<TextField
					label="Wave"
					onChange={(wave) => setDraft((current) => ({ ...current, wave }))}
					placeholder="Optional positive number"
					value={draft.wave}
				/>
				<label className={styles.wideField}>
					<span className={styles.fieldLabel}>Body</span>
					<textarea
						className={styles.textarea}
						onChange={(event) =>
							setDraft((current) => ({
								...current,
								body: event.currentTarget.value,
							}))
						}
						placeholder="Context, outcome, and acceptance criteria"
						value={draft.body}
					/>
				</label>
			</div>
			<div className={styles.formActions}>
				<Button
					isDisabled={!draft.title.trim()}
					loading={command.isPending}
					type="submit"
					variant="primary"
				>
					Create ticket
				</Button>
				<span>One command · no automatic retry</span>
			</div>
			<CommandFeedback error={command.error} response={command.data} />
		</form>
	);
}

export function CreateCommentForm({
	comments,
	opaqueId,
}: {
	readonly comments: WorkDetail["comments"];
	readonly opaqueId: string;
}) {
	const command = useWorkCommand();
	const [draft, setDraft, clearDraft] = useRetainedDraft(
		`golem:work:comment:${opaqueId}`,
		{ body: "", parentId: "" },
	);
	const submit = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!draft.body.trim() || command.isPending) return;
		command.mutate(
			{
				kind: "comment.create",
				idempotency_key: idempotencyKey("dashboard-comment-create"),
				opaque_id: opaqueId,
				body: draft.body.trim(),
				...(draft.parentId ? { parent_comment_opaque_id: draft.parentId } : {}),
			},
			{
				onSuccess(response) {
					if (response.status === "completed") clearDraft();
				},
			},
		);
	};
	return (
		<form className={styles.form} onSubmit={submit}>
			<h3>Add comment or reply</h3>
			<Select
				label="Thread"
				onChange={(parentId) =>
					setDraft((current) => ({ ...current, parentId }))
				}
				options={[
					{ id: "", label: "New top-level comment" },
					...comments.map((comment) => ({
						id: comment.opaque_id,
						label: `Reply to ${comment.opaque_id}`,
					})),
				]}
				value={draft.parentId}
			/>
			<label>
				<span className={styles.fieldLabel}>Comment</span>
				<textarea
					className={styles.textarea}
					onChange={(event) =>
						setDraft((current) => ({
							...current,
							body: event.currentTarget.value,
						}))
					}
					value={draft.body}
				/>
			</label>
			<Button
				isDisabled={!draft.body.trim()}
				loading={command.isPending}
				type="submit"
				variant="primary"
			>
				{draft.parentId ? "Add reply" : "Add comment"}
			</Button>
			<CommandFeedback error={command.error} response={command.data} />
		</form>
	);
}

export function CreateLinkForm({ opaqueId }: { readonly opaqueId: string }) {
	const command = useWorkCommand();
	const [draft, setDraft, clearDraft] = useRetainedDraft(
		`golem:work:link:${opaqueId}`,
		{ relation: "relates" as "blocks" | "relates" | "duplicates", target: "" },
	);
	const submit = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!draft.target.trim() || command.isPending) return;
		command.mutate(
			{
				kind: "link.create",
				idempotency_key: idempotencyKey("dashboard-link-create"),
				opaque_id: opaqueId,
				target_opaque_id: draft.target.trim(),
				relation: draft.relation,
			},
			{
				onSuccess(response) {
					if (response.status === "completed") clearDraft();
				},
			},
		);
	};
	return (
		<form className={styles.form} onSubmit={submit}>
			<h3>Link ticket</h3>
			<div className={styles.formGrid}>
				<TextField
					label="Target ticket ID"
					onChange={(target) => setDraft((current) => ({ ...current, target }))}
					value={draft.target}
				/>
				<Select
					label="Relationship"
					onChange={(relation) =>
						setDraft((current) => ({
							...current,
							relation: relation as typeof draft.relation,
						}))
					}
					options={[
						{ id: "relates", label: "Relates to" },
						{ id: "blocks", label: "Blocks" },
						{ id: "duplicates", label: "Duplicates" },
					]}
					value={draft.relation}
				/>
			</div>
			<Button
				isDisabled={!draft.target.trim()}
				loading={command.isPending}
				type="submit"
				variant="secondary"
			>
				Add link
			</Button>
			<CommandFeedback error={command.error} response={command.data} />
		</form>
	);
}

export function CreateStreamForm() {
	const command = useWorkCommand();
	const [draft, setDraft, clearDraft] = useRetainedDraft(
		"golem:work:stream:create",
		{
			description: "",
			mode: "parallel" as "parallel" | "sequential",
			name: "",
		},
	);
	const submit = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!draft.name.trim() || command.isPending) return;
		command.mutate(
			{
				kind: "stream.create",
				idempotency_key: idempotencyKey("dashboard-stream-create"),
				name: draft.name.trim(),
				mode: draft.mode,
				...(draft.description.trim()
					? { description: draft.description.trim() }
					: {}),
			},
			{
				onSuccess(response) {
					if (response.status === "completed") clearDraft();
				},
			},
		);
	};
	return (
		<form className={styles.form} onSubmit={submit}>
			<h3>Create stream</h3>
			<div className={styles.formGrid}>
				<TextField
					label="Name"
					onChange={(name) => setDraft((current) => ({ ...current, name }))}
					value={draft.name}
				/>
				<Select
					label="Mode"
					onChange={(mode) =>
						setDraft((current) => ({
							...current,
							mode: mode as typeof draft.mode,
						}))
					}
					options={[
						{ id: "parallel", label: "Parallel" },
						{ id: "sequential", label: "Sequential" },
					]}
					value={draft.mode}
				/>
				<div className={styles.wideField}>
					<TextField
						label="Description"
						onChange={(description) =>
							setDraft((current) => ({ ...current, description }))
						}
						value={draft.description}
					/>
				</div>
			</div>
			<Button
				isDisabled={!draft.name.trim()}
				loading={command.isPending}
				type="submit"
				variant="secondary"
			>
				Create stream
			</Button>
			<CommandFeedback error={command.error} response={command.data} />
		</form>
	);
}

export function CreateIdeaForm() {
	const command = useWorkCommand();
	const [body, setBody, clearDraft] = useRetainedDraft(
		"golem:work:idea:create",
		"",
	);
	const submit = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!body.trim() || command.isPending) return;
		command.mutate(
			{
				kind: "management.idea.create",
				idempotency_key: idempotencyKey("dashboard-idea-create"),
				body: body.trim(),
			},
			{
				onSuccess(response) {
					if (response.status === "completed") clearDraft();
				},
			},
		);
	};
	return (
		<form className={styles.form} onSubmit={submit}>
			<h3>Capture an idea</h3>
			<label>
				<span className={styles.fieldLabel}>Idea</span>
				<textarea
					className={styles.textarea}
					onChange={(event) => setBody(event.currentTarget.value)}
					value={body}
				/>
			</label>
			<Button
				isDisabled={!body.trim()}
				loading={command.isPending}
				type="submit"
				variant="primary"
			>
				Add idea
			</Button>
			<CommandFeedback error={command.error} response={command.data} />
		</form>
	);
}

export function CreateGateForm() {
	const command = useWorkCommand();
	const [draft, setDraft, clearDraft] = useRetainedDraft<GateDraft>(
		"golem:work:gate:create",
		{
			assignee: "human",
			gateKind: "approval",
			question: "",
		},
	);

	const submit = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!draft.question.trim() || !draft.assignee.trim() || command.isPending)
			return;
		command.mutate(
			{
				kind: "management.gate.create",
				idempotency_key: idempotencyKey("dashboard-gate-create"),
				gate_kind: draft.gateKind,
				question: draft.question.trim(),
				assignee: draft.assignee.trim(),
			},
			{
				onSuccess(response) {
					if (response.status === "completed") clearDraft();
				},
			},
		);
	};

	return (
		<form className={styles.form} onSubmit={submit}>
			<div className={styles.formGrid}>
				<Select
					label="Gate kind"
					onChange={(gateKind) =>
						setDraft((current) => ({
							...current,
							gateKind: gateKind as GateDraft["gateKind"],
						}))
					}
					options={[
						{ id: "approval", label: "Approval" },
						{ id: "input", label: "Input" },
					]}
					value={draft.gateKind}
				/>
				<TextField
					label="Assignee"
					onChange={(assignee) =>
						setDraft((current) => ({ ...current, assignee }))
					}
					value={draft.assignee}
				/>
				<div className={styles.wideField}>
					<TextField
						description="The question is sent through the bounded management command."
						label="Question"
						onChange={(question) =>
							setDraft((current) => ({ ...current, question }))
						}
						placeholder="What decision or input is required?"
						value={draft.question}
					/>
				</div>
			</div>
			<div className={styles.formActions}>
				<Button
					isDisabled={!draft.question.trim() || !draft.assignee.trim()}
					loading={command.isPending}
					type="submit"
					variant="primary"
				>
					Create gate
				</Button>
				<span>Question draft survives a conflict or transport failure</span>
			</div>
			<CommandFeedback error={command.error} response={command.data} />
		</form>
	);
}
