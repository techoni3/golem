import { InlineAlert, Skeleton, StatePanel, StatusBadge } from "@golem/ui";
import { Link } from "react-router-dom";

import { useWorkProjection } from "../tracker/data.js";
import { CreateGateForm } from "../tracker/forms.js";
import { formatTimestamp, operationTone } from "../tracker/types.js";
import styles from "./review.module.css";

export function ReviewRoute() {
	const controls = useWorkProjection("management.controls");
	const communication = useWorkProjection("communication.operations");

	return (
		<section className={styles.route} data-testid="roles-gates-ideas-ui">
			<header className={styles.header}>
				<div>
					<p className={styles.eyebrow}>Bounded management</p>
					<h1>Review and operations</h1>
					<p>
						Gates, control requests, and communication settlement are rendered
						from redacted public projections. Unsupported management domains
						stay visibly unavailable.
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

			<section
				className={styles.capabilityGrid}
				aria-label="Management capabilities"
			>
				<article>
					<h2>Roles</h2>
					<StatusBadge label="Read-only unavailable" tone="warning" />
					<p>
						The current browser allowlist exposes no role roster or role-change
						command. This screen does not fall back to session internals.
					</p>
				</article>
				<article>
					<h2>Ideas</h2>
					<StatusBadge label="Read-only unavailable" tone="warning" />
					<p>
						Idea list, promote, and pop operations are not in the public browser
						contract, so no inert or misleading controls are rendered.
					</p>
				</article>
				<article>
					<h2>Assets</h2>
					<StatusBadge label="ID-scoped reads only" tone="info" />
					<p>
						An asset can be read only from a known ticket and asset ID. The
						contract exposes no asset index, so this page cannot enumerate one.
					</p>
				</article>
			</section>

			<InlineAlert tone="info">
				Capability gaps are explicit product state. Adding roles or ideas here
				requires extending the public browser contract, not querying legacy
				routes.
			</InlineAlert>
		</section>
	);
}
