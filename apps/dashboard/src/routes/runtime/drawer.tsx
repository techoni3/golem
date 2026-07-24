import { Drawer, StatusBadge } from "@golem/ui";
import styles from "./runtime.module.css";
import {
	activityAt,
	endpoints,
	lifecycle,
	metadata,
	model,
	observedAt,
	projectName,
	type RuntimeItem,
	role,
	sessionName,
	text,
} from "./types.js";

function compactJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return "Unavailable";
	}
}

function DetailList({ item }: { readonly item: RuntimeItem }) {
	const endpoint =
		endpoints(item).find((candidate) => candidate.route_kind === "delivery") ??
		endpoints(item)[0];
	const provenance = item.provenance;
	return (
		<div className={styles.drawerBody}>
			<section aria-labelledby="session-facts-heading">
				<h3 id="session-facts-heading">Canonical session facts</h3>
				<dl className={styles.detailList}>
					<div>
						<dt>Project</dt>
						<dd>{projectName(item)}</dd>
					</div>
					<div>
						<dt>Session</dt>
						<dd>{sessionName(item)}</dd>
					</div>
					<div>
						<dt>Generation</dt>
						<dd>{text(item.generation_id)}</dd>
					</div>
					<div>
						<dt>Model</dt>
						<dd>{model(item)}</dd>
					</div>
					<div>
						<dt>Role</dt>
						<dd>{role(item)}</dd>
					</div>
					<div>
						<dt>Lifecycle</dt>
						<dd>{lifecycle(item)}</dd>
					</div>
					<div>
						<dt>Actor activity</dt>
						<dd>{activityAt(item) ?? "Not recorded"}</dd>
					</div>
					<div>
						<dt>Observation</dt>
						<dd>{observedAt(item) ?? "Not recorded"}</dd>
					</div>
				</dl>
			</section>
			<section aria-labelledby="endpoint-facts-heading">
				<h3 id="endpoint-facts-heading">Endpoint and delivery facts</h3>
				{endpoint ? (
					<div className={styles.endpointGrid}>
						<StatusBadge label={`Endpoint: ${endpoint.state}`} tone="info" />
						<StatusBadge
							label={`Fence: ${endpoint.owner_fence}`}
							tone="neutral"
						/>
						<StatusBadge
							label={`Readiness: ${endpoint.readiness}`}
							tone={endpoint.readiness === "ready" ? "success" : "warning"}
						/>
						<StatusBadge
							label={
								endpoint.consumer_ready
									? "Consumer ready"
									: "Consumer not ready"
							}
							tone={endpoint.consumer_ready ? "success" : "warning"}
						/>
						<StatusBadge
							label={`Delivery mode: ${endpoint.delivery_mode}`}
							tone="neutral"
						/>
						<StatusBadge
							label={
								endpoint.delivery_failed
									? "Delivery failed"
									: endpoint.delivery_observed
										? "Delivery observed"
										: "Delivery unobserved"
							}
							tone={
								endpoint.delivery_failed
									? "danger"
									: endpoint.delivery_observed
										? "success"
										: "warning"
							}
						/>
					</div>
				) : (
					<p>No canonical endpoint is recorded for this generation.</p>
				)}
				{endpoint?.capabilities.length ? (
					<ul className={styles.capabilityList}>
						{endpoint.capabilities.map((capability) => (
							<li
								key={[
									text(capability.capability),
									text(capability.qualification),
									text(capability.readiness),
								].join(":")}
							>
								<strong>{text(capability.capability)}</strong>
								<span>
									{text(capability.qualification)} ·{" "}
									{text(capability.readiness)}
								</span>
							</li>
						))}
					</ul>
				) : null}
			</section>
			<section aria-labelledby="provenance-heading">
				<h3 id="provenance-heading">Provenance timeline</h3>
				<p>
					The control plane redacts and bounds this evidence before it reaches
					the browser.
				</p>
				<pre className={styles.safeJson}>{compactJson(provenance)}</pre>
			</section>
			<section aria-labelledby="metadata-heading">
				<h3 id="metadata-heading">Safe metadata</h3>
				<pre className={styles.safeJson}>{compactJson(metadata(item))}</pre>
			</section>
		</div>
	);
}

export function RuntimeSessionDrawer({
	item,
	onOpenChange,
}: {
	readonly item: RuntimeItem | undefined;
	readonly onOpenChange: (open: boolean) => void;
}) {
	return (
		<Drawer
			isOpen={item !== undefined}
			onOpenChange={onOpenChange}
			title={item ? `${sessionName(item)} details` : "Session details"}
		>
			{item ? <DetailList item={item} /> : null}
		</Drawer>
	);
}
