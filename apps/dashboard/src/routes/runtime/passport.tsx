import { PassportCard, StatusBadge } from "@golem/ui";
import * as React from "react";

import {
	activityAt,
	endpoints,
	lifecycle,
	model,
	observedAt,
	projectName,
	role,
	sessionName,
	text,
	type RuntimeEndpoint,
	type RuntimeItem,
} from "./types.js";
import styles from "./runtime.module.css";

type BadgeTone = "success" | "warning" | "danger" | "info" | "neutral";

function lifecycleTone(value: string): BadgeTone {
	if (value === "active" || value === "running" || value === "idle")
		return "success";
	if (value === "ended" || value === "superseded") return "neutral";
	if (value === "errored") return "danger";
	return "warning";
}

function endpointTone(endpoint: RuntimeEndpoint | undefined): BadgeTone {
	if (!endpoint) return "neutral";
	if (endpoint.state === "active" && endpoint.control_state === "enabled")
		return "success";
	if (endpoint.state === "released" || endpoint.state === "superseded")
		return "neutral";
	return "warning";
}

function capabilityTone(endpoint: RuntimeEndpoint | undefined): BadgeTone {
	if (!endpoint) return "neutral";
	const capabilities = endpoint.capabilities;
	if (capabilities.some((entry) => entry.qualification === "unsupported"))
		return "danger";
	if (capabilities.some((entry) => entry.qualification === "supported"))
		return "success";
	return "warning";
}

function age(value: string | undefined): string {
	if (!value) return "not recorded";
	const parsed = Date.parse(value);
	if (Number.isNaN(parsed)) return value;
	const seconds = Math.max(0, Math.round((Date.now() - parsed) / 1_000));
	if (seconds < 60) return `${seconds}s ago`;
	if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
	return `${Math.floor(seconds / 86_400)}d ago`;
}

function deliveryLabel(endpoint: RuntimeEndpoint | undefined): string {
	if (!endpoint) return "No delivery route";
	if (endpoint.delivery_failed) return "Delivery failed";
	if (endpoint.delivery_observed) return "Delivery observed";
	if (endpoint.readiness === "ready") return "Delivery ready";
	return `Delivery ${endpoint.readiness}`;
}

function consumerLabel(endpoint: RuntimeEndpoint | undefined): string {
	if (!endpoint) return "Consumer absent";
	if (endpoint.consumer_ready && endpoint.consumption_observed)
		return "Consumer confirmed";
	if (endpoint.consumer_ready) return "Consumer ready";
	return "Consumer not ready";
}

export function RuntimePassportCard({
	item,
	onOpen,
}: {
	readonly item: RuntimeItem;
	readonly onOpen: () => void;
}) {
	const endpoint =
		endpoints(item).find((candidate) => candidate.route_kind === "delivery") ??
		endpoints(item)[0];
	const state = lifecycle(item);
	const actorAt = activityAt(item);
	const seenAt = observedAt(item);
	const generation = text(item.generation_id);
	const generationLabel = `Open ${sessionName(item)} session details`;
	return (
		<PassportCard
			onOpen={onOpen}
			openLabel={generationLabel}
			controls={
				<div className={styles.passportFacts} aria-label="Delivery facts">
					<StatusBadge
						{...(endpoint
							? { detail: `${endpoint.delivery_mode} · ${endpoint.readiness}` }
							: {})}
						label={deliveryLabel(endpoint)}
						tone={endpoint?.delivery_failed ? "danger" : endpointTone(endpoint)}
					/>
					<StatusBadge
						{...(endpoint ? { detail: `fence ${endpoint.owner_fence}` } : {})}
						label={consumerLabel(endpoint)}
						tone={endpoint?.consumer_ready ? "success" : "warning"}
					/>
					<StatusBadge
						{...(endpoint
							? { detail: `${endpoint.capabilities.length} fact(s)` }
							: {})}
						label={endpoint ? "Capability facts" : "No capability facts"}
						tone={capabilityTone(endpoint)}
					/>
				</div>
			}
		>
			<div className={styles.passportMain}>
				<p className={styles.eyebrow}>{projectName(item)}</p>
				<h3>{sessionName(item)}</h3>
				<p className={styles.model}>{model(item)}</p>
				<div
					className={styles.badgeRow}
					aria-label="Session lifecycle and role"
				>
					<StatusBadge
						label={`Lifecycle: ${state}`}
						tone={lifecycleTone(state)}
					/>
					<StatusBadge label={`Role: ${role(item)}`} tone="info" />
				</div>
				<dl className={styles.timeFacts}>
					<div>
						<dt>Actor activity</dt>
						<dd title={actorAt}>{age(actorAt)}</dd>
					</div>
					<div>
						<dt>Observed</dt>
						<dd title={seenAt}>{age(seenAt)}</dd>
					</div>
				</dl>
				<p className={styles.cardId}>Generation {generation}</p>
			</div>
		</PassportCard>
	);
}

export function endpointSummary(item: RuntimeItem): string {
	const endpoint =
		endpoints(item).find((candidate) => candidate.route_kind === "delivery") ??
		endpoints(item)[0];
	if (!endpoint)
		return "No endpoint has qualified this generation for delivery.";
	const capability = endpoint.capabilities.find(
		(candidate) => candidate.qualification === "supported",
	);
	return [
		`${endpoint.state} endpoint`,
		`fence ${endpoint.owner_fence}`,
		endpoint.consumer_ready ? "consumer ready" : "consumer not ready",
		capability ? "capability supported" : "capability not qualified",
	].join(" · ");
}
