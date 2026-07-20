import path from "node:path";

import type { ResolvedUpstreamBinary } from "../binaries/discovery.js";
import type { SanitizedEnvironment } from "../environment/sanitize.js";
import type { LaunchPlan } from "../types.js";

export interface LaunchRecord {
	readonly schemaVersion: "golem.launch-record/v1";
	readonly disposition: "dry_run" | "spawned";
	readonly executable: string;
	readonly argv: readonly string[];
	readonly environmentKeys: readonly string[];
	readonly stdio: "inherit" | "capture";
	readonly controlPlane: "not_required" | "would_ensure" | "ensured";
	readonly capability: {
		readonly id: string;
		readonly mode: LaunchPlan["selection"]["mode"];
		readonly deliveryMode: LaunchPlan["selection"]["deliveryMode"];
		readonly qualification: LaunchPlan["qualification"]["status"];
	};
	readonly precedence: readonly {
		readonly code: string;
		readonly source: LaunchPlan["trace"][number]["source"];
	}[];
}

function redactedArgument(argument: string): string {
	return /(?:api[_-]?key|token|secret|password|credential)\s*=/iu.test(
		argument,
	) || /^--?(?:api[_-]?key|token|secret|password|credential)$/iu.test(argument)
		? "$REDACTED"
		: argument;
}

/** A record is safe for text/JSON/doctor output: it contains no values or full temp paths. */
export function launchRecord(input: {
	readonly plan: LaunchPlan;
	readonly binary: ResolvedUpstreamBinary;
	readonly argv: readonly string[];
	readonly environment: SanitizedEnvironment;
	readonly disposition: LaunchRecord["disposition"];
	readonly stdio: LaunchRecord["stdio"];
	readonly controlPlane: LaunchRecord["controlPlane"];
}): LaunchRecord {
	return Object.freeze({
		schemaVersion: "golem.launch-record/v1",
		disposition: input.disposition,
		executable: `<trusted>/${path.basename(input.binary.path)}`,
		argv: Object.freeze(input.argv.map(redactedArgument)),
		environmentKeys: Object.freeze([...input.environment.keys].sort()),
		stdio: input.stdio,
		controlPlane: input.controlPlane,
		capability: Object.freeze({
			id: input.plan.selection.adapterId,
			mode: input.plan.selection.mode,
			deliveryMode: input.plan.selection.deliveryMode,
			qualification: input.plan.qualification.status,
		}),
		precedence: Object.freeze(
			input.plan.trace.map((entry) =>
				Object.freeze({ code: entry.code, source: entry.source }),
			),
		),
	});
}

export function stableLaunchRecordJson(record: LaunchRecord): string {
	return `${JSON.stringify(record)}\n`;
}
