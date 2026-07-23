export {
	applyLegacyMigration,
	MigrationApplyError,
	migrationStatus,
	rollbackLegacyMigration,
} from "./apply/service.js";
export type {
	ApplyMigrationOptions,
	ApplyMigrationResult,
	MigrationApplyStatus,
	MigrationStatus,
} from "./apply/types.js";
export {
	auditLegacyHome,
	formatAuditPlanText,
	stableAuditPlanJson,
} from "./audit/audit.js";
export {
	applyCanonicalCutover,
	canonicalCutoverStatus,
	evaluateCanonicalCutoverSoak,
	planCanonicalCutover,
	rollbackCanonicalCutover,
} from "./cutover/service.js";
export type {
	ApplyCanonicalCutoverOptions,
	ApplyCanonicalCutoverResult,
	CanonicalCutoverPhase,
	CanonicalCutoverPlan,
	CanonicalCutoverState,
	CutoverGate,
	CutoverGateCode,
	CutoverPreflightEvidence,
	CutoverPresetQualification,
	CutoverSoakEvidence,
	CutoverSoakResult,
	PlanCanonicalCutoverOptions,
} from "./cutover/types.js";
export { CanonicalCutoverError } from "./cutover/types.js";
export { planLegacyMigration } from "./plan/plan.js";
export type {
	AuditAction,
	AuditActionKind,
	AuditFinding,
	AuditPlan,
	AuditSource,
	AuditSourceStatus,
} from "./plan/types.js";
export { redactDiagnosticText } from "./redact/redact.js";
