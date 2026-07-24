import type { ControlPlaneAuthority } from "@golem/persistence";

export type CutoverGateCode =
	| "cutover.migration_applied"
	| "cutover.backup_verified"
	| "cutover.binary_hash"
	| "cutover.schema_hash"
	| "cutover.migration_hash"
	| "cutover.final_import_current"
	| "cutover.parity_complete"
	| "cutover.backlog_safe"
	| "cutover.single_owner"
	| "cutover.presets_qualified"
	| "cutover.api_smoke"
	| "cutover.ui_smoke"
	| "cutover.disk_space"
	| "cutover.identity_conflicts"
	| "cutover.canonical_invariants";

export interface CutoverGate {
	readonly code: CutoverGateCode;
	readonly passed: boolean;
	readonly actual: string | number | boolean;
	readonly remedy: string;
}

export interface CutoverPresetQualification {
	readonly preset: string;
	readonly enabled: boolean;
	readonly qualified: boolean;
}

export interface CutoverPreflightEvidence {
	readonly parity_gaps?: readonly string[];
	readonly unsafe_backlog?: number;
	readonly service_owners?: number;
	readonly presets?: readonly CutoverPresetQualification[];
	readonly api_smoke?: boolean;
	readonly ui_smoke?: boolean;
	readonly strong_identity_conflicts?: number;
	readonly expected_binary_hash?: string;
	readonly expected_schema_hash?: string;
	readonly expected_migration_hash?: string;
	readonly minimum_free_bytes?: number;
}

export interface CanonicalCutoverPlan {
	readonly schema_version: "golem.canonical-cutover-plan/v1";
	readonly plan_hash: string;
	readonly migration_plan_hash: string;
	readonly source_manifest_hash: string;
	readonly imported_runtime_source_hash: string;
	readonly current_runtime_source_hash: string;
	readonly binary_hash: string;
	readonly schema_hash: string;
	readonly migration_hash: string;
	readonly canonical_revision: number;
	readonly canonical_counts: Readonly<{
		projects: number;
		sessions: number;
	}>;
	readonly gates: readonly CutoverGate[];
	readonly eligible: boolean;
	readonly generated_at: string;
}

export type CanonicalCutoverPhase =
	| "quiesced"
	| "checkpointed"
	| "soaking"
	| "stable"
	| "rollback_required"
	| "rolled_back";

export interface CanonicalCutoverState {
	readonly schema_version: "golem.canonical-cutover-state/v1";
	readonly plan_hash: string;
	readonly phase: CanonicalCutoverPhase;
	readonly canonical_revision: number;
	readonly authority_revision: number;
	readonly checkpoint_manifest?: string;
	readonly rollback_audit?: string;
	readonly updated_at: string;
	readonly transitions: readonly Readonly<{
		phase: CanonicalCutoverPhase;
		at: string;
		reason?: string;
	}>[];
}

export interface PlanCanonicalCutoverOptions {
	readonly home: string;
	readonly binary_path?: string;
	readonly evidence?: CutoverPreflightEvidence;
	readonly now?: () => string;
}

export interface ApplyCanonicalCutoverOptions
	extends PlanCanonicalCutoverOptions {
	readonly expected_plan_hash: string;
	readonly failpoint?: "after_quiesce" | "after_checkpoint" | "after_switch";
}

export interface CutoverSoakEvidence {
	readonly parity_ok?: boolean;
	readonly health_ok?: boolean;
	readonly unsafe_backlog?: number;
	readonly single_owner?: boolean;
}

export interface CutoverSoakResult {
	readonly state: CanonicalCutoverState;
	readonly authority: ControlPlaneAuthority;
	readonly rollback_triggered: boolean;
	readonly triggers: readonly string[];
}

export interface ApplyCanonicalCutoverResult {
	readonly plan: CanonicalCutoverPlan;
	readonly state: CanonicalCutoverState;
	readonly authority: ControlPlaneAuthority;
	readonly resumed: boolean;
	readonly idempotent: boolean;
}

export class CanonicalCutoverError extends Error {
	readonly code:
		| "cutover.plan_hash_required"
		| "cutover.plan_hash_mismatch"
		| "cutover.preflight_failed"
		| "cutover.locked"
		| "cutover.source_changed"
		| "cutover.state_invalid"
		| "cutover.not_active";
	readonly gates: readonly CutoverGate[] | undefined;

	constructor(
		code: CanonicalCutoverError["code"],
		message: string,
		gates?: readonly CutoverGate[],
	) {
		super(message);
		this.name = "CanonicalCutoverError";
		this.code = code;
		this.gates = gates;
	}
}
