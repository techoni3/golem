import {
	type AliasReference,
	AliasReferenceBodySchema,
	type RuntimeSignalV1,
} from "@golem/contracts";

import { result } from "./explain.js";
import { compareFieldVersion, fieldVersion, sourceTime } from "./ordering.js";
import type {
	DomainState,
	GenerationRecord,
	ProjectLocation,
	ReducerClock,
	ReducerResult,
	ResolvedScopedAlias,
	ScopedAlias,
	SessionRecord,
} from "./types.js";
import { orderedRecord } from "./types.js";

export function generationFor(
	state: DomainState,
	signal: RuntimeSignalV1,
): GenerationRecord | undefined {
	return "generation" in signal.payload
		? state.generations[signal.payload.generation.generation_id]
		: undefined;
}

function createGeneration(
	signal: RuntimeSignalV1,
	clock: ReducerClock,
): GenerationRecord {
	if (!("generation" in signal.payload))
		throw new Error("domain.signal.generation_required");
	const generation = signal.payload.generation;
	const metadata =
		"metadata" in signal.payload && signal.payload.metadata
			? signal.payload.metadata
			: {};
	const version = fieldVersion(signal);
	return {
		generationId: generation.generation_id,
		sessionId: generation.session_id,
		projectId: generation.project_id,
		state: "starting",
		creationProvenance: version,
		lifecycleProvenance: version,
		clocks: {
			startedAt: sourceTime(signal),
			...(signal.payload.kind === "session.resumed"
				? { resumedAt: sourceTime(signal) }
				: {}),
			lastSourceObservedAt: signal.clocks.source_observed_at,
			receivedAt: signal.clocks.received_at,
			materializedAt: clock.materializedAt,
		},
		metadata: orderedRecord(metadata),
		fieldProvenance: orderedRecord(
			Object.fromEntries(
				Object.keys(metadata).map((field) => [field, version]),
			),
		),
	};
}

function creationMetadata(
	signal: RuntimeSignalV1,
): Readonly<Record<string, unknown>> {
	return "metadata" in signal.payload && signal.payload.metadata
		? signal.payload.metadata
		: {};
}

function withoutGeneration(
	sessions: DomainState["sessions"],
	sessionId: string,
	generationId: string,
): DomainState["sessions"] {
	const session = sessions[sessionId];
	if (!session) return sessions;
	const generationIds = session.generationIds.filter(
		(id) => id !== generationId,
	);
	const next = { ...sessions };
	if (generationIds.length === 0) {
		delete next[sessionId];
		return orderedRecord(next);
	}
	const { activeGenerationId: _activeGenerationId, ...rest } = session;
	next[sessionId] = {
		...rest,
		generationIds,
		...(session.activeGenerationId === generationId
			? {}
			: { activeGenerationId: session.activeGenerationId }),
	};
	return orderedRecord(next);
}

/**
 * Duplicate generation creation is a stable provenance choice, not a claim by
 * the event that happened to arrive first. Lifecycle facts remain intact.
 */
function reconcileDuplicateGeneration(
	state: DomainState,
	existing: GenerationRecord,
	signal: RuntimeSignalV1,
	clock: ReducerClock,
): ReducerResult {
	if (!("generation" in signal.payload))
		return result(state, "rejected", "domain.signal.unsupported", {
			eventId: signal.event_id,
		});
	const incomingVersion = fieldVersion(signal);
	if (compareFieldVersion(incomingVersion, existing.creationProvenance) <= 0)
		return result(state, "review", "domain.lifecycle.duplicate", {
			generationId: existing.generationId,
			canonicalized: false,
		});
	const reference = signal.payload.generation;
	let sessions = withoutGeneration(
		state.sessions,
		existing.sessionId,
		existing.generationId,
	);
	const target = sessions[reference.session_id] ?? {
		sessionId: reference.session_id,
		projectId: reference.project_id,
		generationIds: [],
	};
	const terminal = ["ended", "errored", "superseded"].includes(existing.state);
	sessions = orderedRecord({
		...sessions,
		[reference.session_id]: {
			...target,
			projectId: reference.project_id,
			generationIds: [...target.generationIds, existing.generationId].sort(),
			...(terminal ? {} : { activeGenerationId: existing.generationId }),
		},
	});
	const metadata = creationMetadata(signal);
	const updated: GenerationRecord = {
		...existing,
		sessionId: reference.session_id,
		projectId: reference.project_id,
		creationProvenance: incomingVersion,
		/* Equivalent starting facts share a provenance winner; later stages stay put. */
		...(existing.state === "starting"
			? { lifecycleProvenance: incomingVersion }
			: {}),
		metadata: orderedRecord(metadata),
		fieldProvenance: orderedRecord(
			Object.fromEntries(
				Object.keys(metadata).map((field) => [field, incomingVersion]),
			),
		),
		clocks: {
			...existing.clocks,
			startedAt: sourceTime(signal),
			lastSourceObservedAt: signal.clocks.source_observed_at,
			receivedAt: signal.clocks.received_at,
			materializedAt: clock.materializedAt,
		},
	};
	return result(
		{
			...state,
			generations: orderedRecord({
				...state.generations,
				[updated.generationId]: updated,
			}),
			sessions,
		},
		"review",
		"domain.lifecycle.duplicate",
		{ generationId: updated.generationId, canonicalized: true },
	);
}

export function projectObserved(
	state: DomainState,
	signal: RuntimeSignalV1,
): ReducerResult {
	if (signal.payload.kind !== "project.observed")
		return result(state, "rejected", "domain.signal.unsupported", {
			eventId: signal.event_id,
		});
	const { project, location } = signal.payload;
	const previous = state.projects[project.project_id] ?? {
		projectId: project.project_id,
		locations: {},
	};
	const version = fieldVersion(signal);
	const existing = previous.locations[location.location_id];
	if (existing && compareFieldVersion(version, existing.provenance) <= 0)
		return result(state, "ignored", "domain.ordering.field_stale", {
			eventId: signal.event_id,
			field: "project_location",
		});
	const nextLocation: ProjectLocation = {
		locationId: location.location_id,
		canonicalPath: location.canonical_path,
		relation: location.relation,
		provenance: version,
		...(location.observed_path ? { observedPath: location.observed_path } : {}),
	};
	return result(
		{
			...state,
			projects: orderedRecord({
				...state.projects,
				[project.project_id]: {
					...previous,
					locations: orderedRecord({
						...previous.locations,
						[location.location_id]: nextLocation,
					}),
				},
			}),
		},
		"applied",
		"domain.event.applied",
		{ eventId: signal.event_id, projectId: project.project_id },
	);
}

export function startOrResume(
	state: DomainState,
	signal: RuntimeSignalV1,
	clock: ReducerClock,
): ReducerResult {
	if (
		!(
			signal.payload.kind === "session.started" ||
			signal.payload.kind === "session.resumed"
		)
	)
		return result(state, "rejected", "domain.signal.unsupported", {
			eventId: signal.event_id,
		});
	const reference = signal.payload.generation;
	const existing = state.generations[reference.generation_id];
	if (existing)
		return reconcileDuplicateGeneration(state, existing, signal, clock);
	const previousSession: SessionRecord = state.sessions[
		reference.session_id
	] ?? {
		sessionId: reference.session_id,
		projectId: reference.project_id,
		generationIds: [],
	};
	if (previousSession.projectId !== reference.project_id)
		return result(state, "rejected", "domain.signal.unsupported", {
			eventId: signal.event_id,
		});
	let generations = state.generations;
	const incomingVersion = fieldVersion(signal);
	const active = previousSession.activeGenerationId
		? generations[previousSession.activeGenerationId]
		: undefined;
	const activeIsNewer =
		active &&
		compareFieldVersion(incomingVersion, active.lifecycleProvenance) <= 0;
	/* A later start/resume is a terminal supersession fact, never a resurrection. */
	if (active && !activeIsNewer)
		generations = orderedRecord({
			...generations,
			[active.generationId]: {
				...active,
				state: "superseded",
				lifecycleProvenance: incomingVersion,
				clocks: {
					...active.clocks,
					endedAt: sourceTime(signal),
					lastSourceObservedAt: signal.clocks.source_observed_at,
					receivedAt: signal.clocks.received_at,
					materializedAt: clock.materializedAt,
				},
			},
		});
	let created = createGeneration(signal, clock);
	/* A delayed generation becomes historical instead of displacing a newer active one. */
	if (active && activeIsNewer)
		created = {
			...created,
			state: "superseded",
			lifecycleProvenance: active.lifecycleProvenance,
			clocks: {
				...created.clocks,
				endedAt: active.lifecycleProvenance.sourceTime,
				lastSourceObservedAt: active.clocks.lastSourceObservedAt,
				receivedAt: active.clocks.receivedAt,
				materializedAt: clock.materializedAt,
			},
		};
	const session: SessionRecord = {
		...previousSession,
		activeGenerationId: activeIsNewer
			? active.generationId
			: created.generationId,
		generationIds: [
			...previousSession.generationIds,
			created.generationId,
		].sort(),
	};
	return result(
		{
			...state,
			generations: orderedRecord({
				...generations,
				[created.generationId]: created,
			}),
			sessions: orderedRecord({
				...state.sessions,
				[session.sessionId]: session,
			}),
		},
		"applied",
		"domain.event.applied",
		{
			eventId: signal.event_id,
			generationId: created.generationId,
			resumed: signal.payload.kind === "session.resumed",
		},
	);
}

function aliasKey(
	alias: Pick<
		ScopedAlias,
		"projectId" | "harness" | "kind" | "value" | "producerId"
	>,
): string {
	return [
		alias.projectId,
		alias.harness,
		alias.kind,
		alias.producerId ?? "",
		alias.value,
	].join("|");
}

function aliasReferenceInput(alias: ScopedAlias): AliasReference {
	return {
		project_id: alias.projectId,
		harness: alias.harness,
		alias_kind: alias.kind,
		alias: alias.value,
		...(alias.producerId === undefined
			? {}
			: { producer_id: alias.producerId }),
		...(alias.sessionId === undefined
			? {}
			: {
					session: {
						project_id: alias.projectId,
						session_id: alias.sessionId,
					},
				}),
	};
}

function scopedAlias(reference: AliasReference): ScopedAlias {
	return {
		projectId: reference.project_id,
		harness: reference.harness,
		kind: reference.alias_kind,
		value: reference.alias,
		...(reference.producer_id === undefined
			? {}
			: { producerId: reference.producer_id }),
		...(reference.session === undefined
			? {}
			: { sessionId: reference.session.session_id }),
	};
}

export function attachAlias(
	state: DomainState,
	alias: ScopedAlias,
): ReducerResult {
	const parsed = AliasReferenceBodySchema.safeParse(aliasReferenceInput(alias));
	if (!parsed.success)
		return result(state, "rejected", "domain.alias.invalid", {
			contract: "alias-reference",
		});
	const candidate = scopedAlias(parsed.data);
	if (candidate.sessionId === undefined)
		return result(state, "review", "domain.alias.unresolved", {
			projectId: candidate.projectId,
			harness: candidate.harness,
			kind: candidate.kind,
			alias: candidate.value,
		});
	const resolvedCandidate: ResolvedScopedAlias = {
		...candidate,
		sessionId: candidate.sessionId,
	};
	const key = aliasKey(resolvedCandidate);
	const existing = state.aliases[key];
	if (!existing)
		return result(
			{
				...state,
				aliases: orderedRecord({ ...state.aliases, [key]: resolvedCandidate }),
			},
			"applied",
			"domain.alias.attached",
			{ sessionId: resolvedCandidate.sessionId },
		);
	if (existing.sessionId === resolvedCandidate.sessionId)
		return result(state, "ignored", "domain.alias.duplicate", {
			sessionId: resolvedCandidate.sessionId,
		});
	const canonical =
		existing.sessionId.localeCompare(resolvedCandidate.sessionId) <= 0
			? existing
			: resolvedCandidate;
	return result(
		canonical === existing
			? state
			: {
					...state,
					aliases: orderedRecord({ ...state.aliases, [key]: canonical }),
				},
		"review",
		"domain.alias.ambiguous",
		{
			existingSessionId: canonical.sessionId,
			candidateSessionId:
				canonical.sessionId === existing.sessionId
					? resolvedCandidate.sessionId
					: existing.sessionId,
			...(canonical === existing ? {} : { aliases: "canonicalized" }),
		},
	);
}
