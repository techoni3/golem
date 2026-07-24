export const requirements = Object.freeze([
	{
		id: "GOL12-B01",
		text: "A strict TypeScript-first architecture defines shared domain contracts across adapters, runtime, persistence, control plane, CLI, and web UI.",
		evidence: ["ENTRY", "J6"],
	},
	{
		id: "GOL12-B02",
		text: "Harness adapters translate Claude Code, Codex, OpenCode, Pi, and supported backend/model capabilities into versioned canonical contracts.",
		evidence: ["J2", "J4", "J5"],
	},
	{
		id: "GOL12-B03",
		text: "One durable control-plane model owns identity, generations, endpoint fencing, lifecycle, activity semantics, readiness, and diagnostics.",
		evidence: ["J2", "J3"],
	},
	{
		id: "GOL12-B04",
		text: "Registration, lifecycle changes, crash recovery, and projections behave deterministically across supported harnesses.",
		evidence: ["J2", "J3", "J4"],
	},
	{
		id: "GOL12-B05",
		text: "The compact launcher has deterministic precedence, presets, capability validation, concise output, diagnostics, and non-recursive invocation.",
		evidence: ["J5"],
	},
	{
		id: "GOL12-B06",
		text: "Dashboard, sessions, tracker, controls, CLI, and diagnostics consume typed APIs and materialized views.",
		evidence: ["J4", "J6"],
	},
	{
		id: "GOL12-B07",
		text: "The dashboard has an accessible design system, bounded responsive layouts, and light/dark/system themes.",
		evidence: ["J8", "BROWSER"],
	},
	{
		id: "GOL12-B08",
		text: "Existing data and integrations have dry-run migration, compatibility, observable cutover, and nondestructive rollback.",
		evidence: ["J7", "LEGACY"],
	},
	{
		id: "GOL12-B09",
		text: "Delivery is staged behind parity and migration gates and each wave remains runnable.",
		evidence: ["J1", "J7", "LEGACY"],
	},
	{
		id: "GOL12-B10",
		text: "Verification uses real SQLite, processes, services, concurrency, reordering, duplicate delivery, crashes, restart, migration, launch UX, and UI states.",
		evidence: ["J1", "J2", "J3", "J4", "J5", "J6", "J7", "J8"],
	},
	{
		id: "GOL12-B11",
		text: "Repository structure, decisions, contributor workflow, generated boundaries, and invariants are documented.",
		evidence: ["ENTRY"],
	},
	{
		id: "GOL12-B12",
		text: "Deep design documents, ADRs, component/data-flow, migration, and dependency-ordered implementation planning exist.",
		evidence: ["ENTRY"],
	},
	{
		id: "GOL12-B13",
		text: "Builder briefs retain parent, ADR, predecessor, acceptance, workspace, and non-goal context.",
		evidence: ["TRACKER"],
	},
	{
		id: "GOL12-B14",
		text: "The replacement demonstrates retained parity, GOL-6 lifecycle consistency, and GOL-11 launcher truth.",
		evidence: ["J1", "J2", "J3", "J4", "J5", "J6", "J7", "J8", "BROWSER", "LEGACY"],
	},
]);
