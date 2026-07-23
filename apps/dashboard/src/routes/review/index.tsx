import { Button, Skeleton, StatePanel, StatusBadge } from "@golem/ui";
import { Link } from "react-router-dom";

import { useWorkCommand, useWorkProjection } from "../tracker/data.js";
import {
	CommandFeedback,
	CreateGateForm,
	CreateIdeaForm,
} from "../tracker/forms.js";
import {
	formatTimestamp,
	idempotencyKey,
	operationTone,
} from "../tracker/types.js";
import styles from "./review.module.css";

export function ReviewRoute() {
	const controls = useWorkProjection("management.controls");
	const communication = useWorkProjection("communication.operations");
	const roleCommand = useWorkCommand();
	const ideaCommand = useWorkCommand();

	return (
		<section className={styles.route} data-testid="roles-gates-ideas-ui">
			<header className={styles.header}>
				<div>
					<p className={styles.eyebrow}>Bounded management</p>
					<h1>Review and operations</h1>
					<p>
						Roles, gates, ideas, control requests, and communication settlement
						come from redacted public projections and canonical commands.
					</p>
				</div>
			</header>

			<div className={styles.revisionBar} aria-live="polite">
				<span>
					Controls revision {controls.data?.resource_revision ?? "loading"}
				</span>
				<span>
					Communication revision{" "}
					{communication.data?.resource_revision ?? "loading"}
				</span>
			</div>

			<section className={styles.section}>
				<div className={styles.sectionHeader}>
					<div>
						<p className={styles.eyebrow}>Human pause</p>
						<h2>Create a gate</h2>
					</div>
				</div>
				<CreateGateForm />
				{controls.data?.gates.length ? (
					<ul className={styles.operationList}>
						{controls.data.gates.map((gate) => (
							<li key={gate.opaque_id}>
								<div>
									<strong>{gate.question}</strong>
									<code>{gate.opaque_id}</code>
									<span>
										{gate.gate_kind} · {gate.assignee_kind}
									</span>
								</div>
								<StatusBadge
									label={gate.status}
									tone={operationTone(gate.status)}
								/>
							</li>
						))}
					</ul>
				) : null}
			</section>

			<section className={styles.section}>
				<div className={styles.sectionHeader}>
					<div>
						<p className={styles.eyebrow}>Bounded authority</p>
						<h2>Roles</h2>
					</div>
					<span>{controls.data?.roles.length ?? 0} roles</span>
				</div>
				{controls.data?.roles.length ? (
					<ul className={styles.operationList}>
						{controls.data.roles.map((role) => (
							<li key={role.opaque_id}>
								<div>
									<strong>{role.name}</strong>
									<code>{role.opaque_id}</code>
									<span>{role.scope} scope</span>
								</div>
								<Button
									isDisabled={role.scope !== "project"}
									loading={roleCommand.isPending}
									onPress={() =>
										roleCommand.mutate({
											kind: "management.role.assign",
											idempotency_key: idempotencyKey("dashboard-role-assign"),
											role_opaque_id: role.opaque_id,
										})
									}
									variant="secondary"
								>
									{role.scope === "project"
										? "Assign project role"
										: "Target required"}
								</Button>
							</li>
						))}
					</ul>
				) : (
					<StatePanel
						description="No project role is available to assign."
						kind="empty"
						title="No roles"
					/>
				)}
				<CommandFeedback
					error={roleCommand.error}
					response={roleCommand.data}
				/>
			</section>

			<section className={styles.section}>
				<div className={styles.sectionHeader}>
					<div>
						<p className={styles.eyebrow}>Intake</p>
						<h2>Ideas</h2>
					</div>
					<span>{controls.data?.ideas.length ?? 0} ideas</span>
				</div>
				<CreateIdeaForm />
				{controls.data?.ideas.length ? (
					<ul className={styles.operationList}>
						{controls.data.ideas.map((idea) => (
							<li key={idea.opaque_id}>
								<div>
									<strong>{idea.body}</strong>
									<code>{idea.opaque_id}</code>
									{idea.promoted_ticket_opaque_id ? (
										<span>
											Promoted to{" "}
											<Link to={`/tickets/${idea.promoted_ticket_opaque_id}`}>
												{idea.promoted_ticket_opaque_id}
											</Link>
										</span>
									) : null}
								</div>
								<div className={styles.actions}>
									<StatusBadge
										label={idea.status}
										tone={operationTone(idea.status)}
									/>
									{idea.status === "pending" ? (
										<>
											<Button
												loading={ideaCommand.isPending}
												onPress={() =>
													ideaCommand.mutate({
														kind: "management.idea.promote",
														idempotency_key: idempotencyKey(
															"dashboard-idea-promote",
														),
														idea_opaque_id: idea.opaque_id,
													})
												}
												variant="primary"
											>
												Promote
											</Button>
											<Button
												loading={ideaCommand.isPending}
												onPress={() =>
													ideaCommand.mutate({
														kind: "management.idea.pop",
														idempotency_key:
															idempotencyKey("dashboard-idea-pop"),
														idea_opaque_id: idea.opaque_id,
													})
												}
												variant="secondary"
											>
												Pop
											</Button>
										</>
									) : null}
								</div>
							</li>
						))}
					</ul>
				) : null}
				<CommandFeedback
					error={ideaCommand.error}
					response={ideaCommand.data}
				/>
			</section>

			<section className={styles.section}>
				<div className={styles.sectionHeader}>
					<div>
						<p className={styles.eyebrow}>Safe facts only</p>
						<h2>Management controls</h2>
					</div>
					<span>{controls.data?.items.length ?? 0} operations</span>
				</div>
				{controls.isPending ? <Skeleton /> : null}
				{controls.isError ? (
					<StatePanel
						description="The redacted management projection could not be loaded."
						kind="error"
						title="Controls unavailable"
					/>
				) : null}
				{!controls.isPending &&
				!controls.isError &&
				controls.data?.items.length === 0 ? (
					<StatePanel
						description="No bounded control operations are currently visible."
						kind="empty"
						title="No control operations"
					/>
				) : null}
				{controls.data?.items.length ? (
					<ul className={styles.operationList}>
						{controls.data.items.map((operation) => (
							<li key={operation.opaque_id}>
								<div>
									<strong>{operation.operation_kind}</strong>
									<code>{operation.opaque_id}</code>
									<span>Updated {formatTimestamp(operation.updated_at)}</span>
								</div>
								<StatusBadge
									label={operation.status}
									tone={operationTone(operation.status)}
								/>
							</li>
						))}
					</ul>
				) : null}
			</section>

			<section className={styles.section}>
				<div className={styles.sectionHeader}>
					<div>
						<p className={styles.eyebrow}>Delivery is not enqueueing</p>
						<h2>Communication settlement</h2>
					</div>
					<span>{communication.data?.items.length ?? 0} operations</span>
				</div>
				{communication.isPending ? <Skeleton /> : null}
				{communication.isError ? (
					<StatePanel
						description="The communication projection could not be loaded."
						kind="error"
						title="Communication unavailable"
					/>
				) : null}
				{!communication.isPending &&
				!communication.isError &&
				communication.data?.items.length === 0 ? (
					<StatePanel
						description="No bounded communication or dispatch operations are visible."
						kind="empty"
						title="No communication operations"
					/>
				) : null}
				{communication.data?.items.length ? (
					<ul className={styles.operationList}>
						{communication.data.items.map((operation) => (
							<li key={operation.opaque_id}>
								<div>
									<strong>{operation.operation_kind}</strong>
									<code>{operation.opaque_id}</code>
									{operation.operation_kind === "dispatch" ? (
										<>
											<span>
												Ticket{" "}
												<Link to={`/tickets/${operation.subject_opaque_id}`}>
													{operation.subject_opaque_id}
												</Link>
											</span>
											<span>
												Disposition {operation.disposition}
												{operation.remediation
													? ` · ${operation.remediation}`
													: ""}
											</span>
										</>
									) : (
										<span>Created {formatTimestamp(operation.created_at)}</span>
									)}
								</div>
								<StatusBadge
									label={
										operation.operation_kind === "dispatch"
											? (operation.settlement ?? operation.disposition)
											: operation.status
									}
									tone={operationTone(
										operation.operation_kind === "dispatch"
											? (operation.settlement ?? operation.disposition)
											: operation.status,
									)}
								/>
							</li>
						))}
					</ul>
				) : null}
			</section>
		</section>
	);
}
