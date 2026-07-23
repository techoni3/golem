import type {
	BrowserControlPlaneClient,
	BrowserWorkProjectionResponse,
	BrowserWorkStream,
} from "@golem/api-client";

export type WorkProjection = BrowserWorkProjectionResponse;
export type WorkProjectionFor<Stream extends BrowserWorkStream> = Extract<
	WorkProjection,
	{ readonly stream: Stream }
>;
export type WorkTicket = WorkProjectionFor<"tracker.board">["items"][number];
export type WorkTreeTicket = WorkProjectionFor<"tracker.tree">["items"][number];
export type WorkManagementOperation =
	WorkProjectionFor<"management.controls">["items"][number];
export type WorkCommunicationOperation =
	WorkProjectionFor<"communication.operations">["items"][number];
export type WorkCommand = Parameters<
	BrowserControlPlaneClient["browserWorkCommand"]
>[0];
export type WorkCommandResponse = Awaited<
	ReturnType<BrowserControlPlaneClient["browserWorkCommand"]>
>;
export type WorkDetail = Awaited<
	ReturnType<BrowserControlPlaneClient["browserWorkDetail"]>
>;

export type WorkConnectionState =
	| "connecting"
	| "connected"
	| "reconnecting"
	| "error";

export const ticketKindOptions = [
	{ id: "work-item", label: "Work item" },
	{ id: "spec", label: "Spec" },
	{ id: "question", label: "Question" },
	{ id: "decision", label: "Decision" },
	{ id: "fix", label: "Fix" },
] as const;

export const priorityOptions = [
	{ id: "", label: "No priority" },
	{ id: "P0", label: "P0 · Critical" },
	{ id: "P1", label: "P1 · High" },
	{ id: "P2", label: "P2 · Normal" },
	{ id: "P3", label: "P3 · Low" },
] as const;

export const phaseOptions = [
	{ id: "queued", label: "Queued" },
	{ id: "building", label: "Building" },
	{ id: "blocked", label: "Blocked" },
	{ id: "built", label: "Built" },
	{ id: "verifying", label: "Verifying" },
	{ id: "verified", label: "Verified" },
	{ id: "rejected", label: "Rejected" },
	{ id: "done", label: "Done" },
] as const;

export function ticketTone(
	phase: string,
): "success" | "warning" | "danger" | "info" | "neutral" {
	if (phase === "done" || phase === "verified") return "success";
	if (phase === "blocked" || phase === "rejected") return "danger";
	if (phase === "building" || phase === "verifying") return "warning";
	if (phase === "built") return "info";
	return "neutral";
}

export function operationTone(
	status: string,
): "success" | "warning" | "danger" | "info" | "neutral" {
	if (status === "delivered" || status === "settled") return "success";
	if (
		status === "ineligible" ||
		status === "failed" ||
		status === "expired" ||
		status === "cancelled"
	)
		return "danger";
	if (status === "queued" || status === "pending" || status === "retrying")
		return "warning";
	return "info";
}

export function idempotencyKey(scope: string): string {
	return `${scope}:${globalThis.crypto.randomUUID()}`;
}

export function formatTimestamp(value: string): string {
	const parsed = new Date(value);
	return Number.isNaN(parsed.valueOf())
		? value
		: new Intl.DateTimeFormat(undefined, {
				dateStyle: "medium",
				timeStyle: "short",
			}).format(parsed);
}
