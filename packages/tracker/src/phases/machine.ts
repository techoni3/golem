import type {
	TrackerCoreState,
	TrackerCoreWorkItemKind,
} from "../repositories/port.js";

interface PhaseMachine {
	readonly initial: string;
	readonly phases: readonly string[];
	readonly transitions: Readonly<Record<string, readonly string[]>>;
	readonly canonical: Readonly<Record<string, TrackerCoreState>>;
	readonly requirements: Readonly<Record<string, readonly string[]>>;
}

const workItemMachine = Object.freeze({
	initial: "queued",
	phases: [
		"queued",
		"building",
		"blocked",
		"built",
		"verifying",
		"verified",
		"rejected",
		"done",
	],
	transitions: {
		queued: ["building", "blocked"],
		building: ["built", "blocked"],
		blocked: ["building"],
		built: ["verifying", "done"],
		verifying: ["verified", "rejected"],
		verified: ["done"],
		rejected: ["building"],
		done: [],
	},
	canonical: {
		queued: "todo",
		building: "in_progress",
		blocked: "blocked",
		built: "review",
		verifying: "review",
		verified: "review",
		rejected: "in_progress",
		done: "done",
	},
	requirements: {
		blocked: ["reason"],
		built: ["closingBrief"],
		verifying: ["managerDispatch"],
		verified: ["verificationReport"],
		rejected: ["verificationReport"],
		done: ["verifiedOrSkipReason"],
	},
} satisfies PhaseMachine);

const specMachine = Object.freeze({
	initial: "drafting",
	phases: [
		"drafting",
		"grounding",
		"grounded",
		"designing",
		"designed",
		"planning",
		"planned",
		"building",
		"done",
		"parked",
	],
	transitions: {
		drafting: ["grounding", "parked"],
		grounding: ["grounded", "parked"],
		grounded: ["designing", "parked"],
		designing: ["designed", "grounding", "parked"],
		designed: ["planning", "parked"],
		planning: ["planned", "designing", "parked"],
		planned: ["building", "parked"],
		building: ["done", "parked"],
		parked: ["drafting", "grounding", "designing", "planning", "building"],
		done: [],
	},
	canonical: {
		drafting: "todo",
		grounding: "in_progress",
		grounded: "in_progress",
		designing: "in_progress",
		designed: "review",
		planning: "in_progress",
		planned: "in_progress",
		building: "in_progress",
		done: "done",
		parked: "blocked",
	},
	requirements: {
		grounded: ["groundingSummary"],
		designed: ["design", "concerns"],
		planning: ["humanFinalise"],
		planned: ["children", "waves"],
		building: ["childStarted"],
		done: ["childrenTerminal"],
		parked: ["reason"],
	},
} satisfies PhaseMachine);

const questionMachine = Object.freeze({
	initial: "open",
	phases: ["open", "answered", "closed"],
	transitions: { open: ["answered"], answered: ["closed"], closed: [] },
	canonical: { open: "todo", answered: "review", closed: "done" },
	requirements: { answered: ["answerComment"] },
} satisfies PhaseMachine);

const decisionMachine = Object.freeze({
	initial: "open",
	phases: ["open", "decided", "closed"],
	transitions: { open: ["decided"], decided: ["closed"], closed: [] },
	canonical: { open: "todo", decided: "review", closed: "done" },
	requirements: { decided: ["decisionComment"] },
} satisfies PhaseMachine);

function machineFor(kind: TrackerCoreWorkItemKind): PhaseMachine {
	if (kind === "spec") return specMachine;
	if (kind === "question") return questionMachine;
	if (kind === "decision") return decisionMachine;
	return workItemMachine;
}

function provided(value: unknown): boolean {
	if (typeof value === "string") return value.trim().length > 0;
	if (Array.isArray(value)) return value.length > 0;
	return value === true || (typeof value === "object" && value !== null);
}

export class TrackerPhaseError extends Error {
	constructor(
		readonly code: "phase_unknown" | "phase_illegal" | "phase_artifact_missing",
		message: string,
	) {
		super(message);
		this.name = "TrackerPhaseError";
	}
}

export function initialTrackerPhase(kind: TrackerCoreWorkItemKind): string {
	return machineFor(kind).initial;
}

/** Structural successors only; callers must still check durable evidence. */
export function candidateTrackerPhaseTransitions(
	kind: TrackerCoreWorkItemKind,
	phase: string,
): readonly string[] {
	return Object.freeze([...(machineFor(kind).transitions[phase] ?? [])]);
}

export function canonicalTrackerState(
	kind: TrackerCoreWorkItemKind,
	phase: string,
): TrackerCoreState {
	const state = machineFor(kind).canonical[phase];
	if (!state)
		throw new TrackerPhaseError(
			"phase_unknown",
			`phase ${phase} is not defined for ${kind}`,
		);
	return state;
}

export function validateTrackerPhaseTransition(input: {
	readonly kind: TrackerCoreWorkItemKind;
	readonly from: string;
	readonly to: string;
	readonly artifacts: Readonly<Record<string, unknown>>;
}): TrackerCoreState {
	const machine = machineFor(input.kind);
	if (!machine.phases.includes(input.to))
		throw new TrackerPhaseError(
			"phase_unknown",
			`phase ${input.to} is not defined for ${input.kind}`,
		);
	if (!machine.transitions[input.from]?.includes(input.to))
		throw new TrackerPhaseError(
			"phase_illegal",
			`cannot transition ${input.kind} from ${input.from} to ${input.to}`,
		);
	for (const requirement of machine.requirements[input.to] ?? []) {
		if (!provided(input.artifacts[requirement]))
			throw new TrackerPhaseError(
				"phase_artifact_missing",
				`phase ${input.to} requires ${requirement}`,
			);
	}
	return canonicalTrackerState(input.kind, input.to);
}
