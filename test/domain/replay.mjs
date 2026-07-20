import assert from "node:assert/strict";

import {
	attachAlias,
	emptyDomainState,
	lifecycleDecision,
	lifecycleRank,
	projectDomain,
	reduceDomain,
	resolveCapability,
} from "@golem/domain";

const projectId = "prj_00000000-0000-4000-8000-000000000001";
const producerId = (number) =>
	`prod_00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const sessionId = (number) =>
	`ses_00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const generationId = (number) =>
	`gen_00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const eventId = (number) =>
	`evt_00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const endpointId = "ep_00000000-0000-4000-8000-000000000001";
const materializedAt = "2026-07-20T12:00:00.000Z";

function signal({
	harness = "claude",
	producer = 1,
	sequence,
	number,
	payload,
	ownerFence,
	sourceAt,
}) {
	const second = String(number % 60).padStart(2, "0");
	const source = sourceAt ?? `2026-07-20T10:00:${second}.000Z`;
	return {
		schema_version: "golem.runtime-signal/v1",
		event_id: eventId(number),
		event_kind: payload.kind,
		producer: `${harness}-fixture`,
		producer_instance_id: producerId(producer),
		harness,
		producer_sequence: sequence,
		correlation_id: `replay-${number}`,
		deduplication_key: `replay-${number}`,
		...(ownerFence ? { owner_fence: ownerFence } : {}),
		clocks: {
			source_event_at: source,
			source_observed_at: source,
			received_at: source.replace("10:00", "10:59").replace("10:01", "10:59"),
		},
		provenance: { source: "adapter", confidence: "verified" },
		clear_fields: [],
		payload,
	};
}

function generation(number) {
	return {
		project_id: projectId,
		session_id: sessionId(number),
		generation_id: generationId(number),
	};
}

function apply(state, event) {
	return reduceDomain(state, event, { materializedAt });
}

function replay(initial, events) {
	return events.reduce((state, event) => apply(state, event).state, initial);
}

/** The state plus its public projections are the deterministic terminal effects. */
function canonical(state) {
	return JSON.stringify({ state, effects: projectDomain(state) });
}

function lifecycleExpectation(current, next) {
	if (current === next) return "ignored";
	return lifecycleRank[next] < lifecycleRank[current] ? "rejected" : "applied";
}

export function runDomainReplay() {
	const lifecycleStates = [
		"starting",
		"idle",
		"active",
		"waiting",
		"ending",
		"ended",
		"errored",
		"superseded",
	];
	for (const current of lifecycleStates) {
		for (const next of lifecycleStates) {
			const decision = lifecycleDecision(current, next);
			const expected = lifecycleExpectation(current, next);
			assert.equal(
				decision.disposition,
				expected,
				`${current} -> ${next} obeys the lifecycle stage/rank policy`,
			);
			if (expected === "rejected" && !["ended", "errored", "superseded"].includes(current))
				assert.equal(decision.explanation.code, "domain.lifecycle.regression");
		}
	}

	let observedState = emptyDomainState();
	for (const [index, harness] of ["claude", "codex", "opencode", "pi"].entries()) {
		const outcome = apply(
			observedState,
			signal({
				harness,
				producer: index + 1,
				sequence: 1,
				number: index + 1,
				payload: {
					kind: "project.observed",
					project: { project_id: projectId },
					location: {
						project_id: projectId,
						location_id: `loc_00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
						relation: index === 1 ? "worktree" : "main",
						canonical_path: index === 1 ? "/workspace/golem-worktree" : "/workspace/golem",
					},
				},
			}),
		);
		assert.equal(outcome.effect.disposition, "applied", `${harness} uses the same pure policy`);
		observedState = outcome.state;
	}
	assert.equal(Object.keys(observedState.projects[projectId].locations).length, 4);
	const relocatedEarlier = signal({
		number: 5,
		producer: 11,
		sequence: 1,
		sourceAt: "2026-07-20T10:00:10.000Z",
		payload: {
			kind: "project.observed",
			project: { project_id: projectId },
			location: {
				project_id: projectId,
				location_id: "loc_00000000-0000-4000-8000-000000000099",
				relation: "main",
				canonical_path: "/workspace/old",
			},
		},
	});
	const relocatedLater = signal({
		number: 6,
		producer: 12,
		sequence: 1,
		sourceAt: "2026-07-20T10:00:20.000Z",
		payload: {
			kind: "project.observed",
			project: { project_id: projectId },
			location: {
				project_id: projectId,
				location_id: "loc_00000000-0000-4000-8000-000000000099",
				relation: "worktree",
				canonical_path: "/workspace/new",
			},
		},
	});
	const locationForward = replay(emptyDomainState(), [relocatedEarlier, relocatedLater]);
	const locationReverse = replay(emptyDomainState(), [relocatedLater, relocatedEarlier]);
	assert.equal(canonical(locationForward), canonical(locationReverse));
	assert.equal(
		locationForward.projects[projectId].locations["loc_00000000-0000-4000-8000-000000000099"].canonicalPath,
		"/workspace/new",
	);

	const first = generation(10);
	const started = signal({
		number: 10,
		sequence: 1,
		payload: { kind: "session.started", generation: first, metadata: { name: "initial" } },
	});
	let lifecycleState = apply(observedState, started).state;
	for (const [number, sequence, kind] of [
		[11, 2, "session.activity"],
		[12, 3, "session.idle"],
		[13, 4, "session.waiting"],
	]) {
		lifecycleState = apply(
			lifecycleState,
			signal({
				number,
				sequence,
				payload: {
					kind,
					generation: first,
					...(kind === "session.activity" ? { activity_kind: "prompt" } : {}),
					...(kind === "session.waiting" ? { reason: "approval" } : {}),
				},
			}),
		).state;
	}
	const ended = signal({
		number: 14,
		sequence: 5,
		payload: { kind: "session.ended", generation: first, disposition: "ended" },
	});
	lifecycleState = apply(lifecycleState, ended).state;
	assert.equal(lifecycleState.generations[first.generation_id].state, "ended");
	assert.equal(apply(lifecycleState, ended).effect.explanation.code, "domain.event.duplicate");
	assert.equal(
		apply(
			lifecycleState,
			signal({
				number: 15,
				sequence: 6,
				payload: { kind: "session.activity", generation: first, activity_kind: "work" },
			}),
		).effect.explanation.code,
		"domain.lifecycle.terminal",
		"terminal generations cannot reactivate",
	);
	const operationalGeneration = generation(90);
	const operationalSeed = apply(
		emptyDomainState(),
		signal({
			number: 16,
			producer: 13,
			sequence: 1,
			sourceAt: "2026-07-20T10:00:00.000Z",
			payload: { kind: "session.started", generation: operationalGeneration },
		}),
	).state;
	const operationalActive = signal({
		number: 17,
		producer: 14,
			sequence: 1,
			sourceAt: "2026-07-20T10:00:10.000Z",
			payload: {
				kind: "session.activity",
				generation: operationalGeneration,
				activity_kind: "prompt",
			},
		});
	const operationalWaiting = signal({
		number: 18,
		producer: 15,
			sequence: 1,
			sourceAt: "2026-07-20T10:00:20.000Z",
			payload: {
				kind: "session.waiting",
				generation: operationalGeneration,
				reason: "approval",
			},
		});
	const operationalForward = replay(operationalSeed, [operationalActive, operationalWaiting]);
	const operationalReverse = replay(operationalSeed, [operationalWaiting, operationalActive]);
	assert.equal(canonical(operationalForward), canonical(operationalReverse));
	assert.equal(operationalForward.generations[operationalGeneration.generation_id].state, "waiting");

	/* J2: lifecycle is a stage-dominant join, not a newest-receipt reducer. */
	const semanticGeneration = generation(91);
	const semanticSeed = apply(
		emptyDomainState(),
		signal({
			number: 19,
			producer: 19,
			sequence: 1,
			sourceAt: "2026-07-20T10:00:01.000Z",
			payload: { kind: "session.started", generation: semanticGeneration },
		}),
	).state;
	const terminalEnded = signal({
		number: 20,
		producer: 20,
		sequence: 1,
		sourceAt: "2026-07-20T10:00:02.000Z",
		payload: {
			kind: "session.ended",
			generation: semanticGeneration,
			disposition: "ended",
		},
	});
	const laterIdle = signal({
		number: 21,
		producer: 21,
		sequence: 1,
		sourceAt: "2026-07-20T10:00:03.000Z",
		payload: { kind: "session.idle", generation: semanticGeneration },
	});
	const endedThenIdle = replay(semanticSeed, [terminalEnded, laterIdle]);
	const idleThenEnded = replay(semanticSeed, [laterIdle, terminalEnded]);
	assert.equal(canonical(endedThenIdle), canonical(idleThenEnded));
	assert.equal(endedThenIdle.generations[semanticGeneration.generation_id].state, "ended");

	const terminalErrored = signal({
		number: 22,
		producer: 22,
		sequence: 1,
		sourceAt: "2026-07-20T10:00:04.000Z",
		payload: {
			kind: "session.ended",
			generation: semanticGeneration,
			disposition: "errored",
		},
	});
	const terminalSuperseded = signal({
		number: 23,
		producer: 23,
		sequence: 1,
		sourceAt: "2026-07-20T10:00:05.000Z",
		payload: {
			kind: "session.ended",
			generation: semanticGeneration,
			disposition: "superseded",
		},
	});
	const terminalForwardJoin = replay(semanticSeed, [
		terminalEnded,
		terminalErrored,
		terminalSuperseded,
	]);
	const terminalReverseJoin = replay(semanticSeed, [
		terminalSuperseded,
		terminalErrored,
		terminalEnded,
	]);
	assert.equal(canonical(terminalForwardJoin), canonical(terminalReverseJoin));
	assert.equal(
		terminalForwardJoin.generations[semanticGeneration.generation_id].state,
		"superseded",
		"same-stage terminal facts use stable provenance without resurrection",
	);

	const duplicateGeneration = generation(92);
	const duplicateOwner = { ...duplicateGeneration, session_id: sessionId(93) };
	const duplicateEarlier = signal({
		number: 24,
		producer: 24,
		sequence: 1,
		sourceAt: "2026-07-20T10:00:06.000Z",
		payload: {
			kind: "session.started",
			generation: duplicateGeneration,
			metadata: { owner: "earlier" },
		},
	});
	const duplicateLater = signal({
		number: 25,
		producer: 25,
		sequence: 1,
		sourceAt: "2026-07-20T10:00:07.000Z",
		payload: {
			kind: "session.started",
			generation: duplicateOwner,
			metadata: { owner: "later" },
		},
	});
	const duplicateForward = replay(emptyDomainState(), [duplicateEarlier, duplicateLater]);
	const duplicateReverse = replay(emptyDomainState(), [duplicateLater, duplicateEarlier]);
	assert.equal(canonical(duplicateForward), canonical(duplicateReverse));
	assert.equal(
		duplicateForward.generations[duplicateGeneration.generation_id].sessionId,
		duplicateOwner.session_id,
	);
	assert.deepEqual(duplicateForward.generations[duplicateGeneration.generation_id].metadata, {
		owner: "later",
	});

	const metadataGeneration = generation(110);
	const metadataSeed = apply(
		emptyDomainState(),
		signal({
			number: 30,
			producer: 1,
			sequence: 1,
			sourceAt: "2026-07-20T10:00:30.000Z",
			payload: {
				kind: "session.started",
				generation: metadataGeneration,
				metadata: { name: "baseline", model: "baseline" },
			},
		}),
	).state;
	const delayedClear = {
		...signal({
			number: 31,
			producer: 3,
			sequence: 1,
			sourceAt: "2026-07-20T10:00:40.000Z",
			payload: {
				kind: "session.metadata_patched",
				generation: metadataGeneration,
				metadata: { name: "delayed" },
			},
		}),
		clear_fields: ["model"],
	};
	const newerMetadata = signal({
		number: 32,
		producer: 2,
		sequence: 1,
		sourceAt: "2026-07-20T10:00:50.000Z",
		payload: {
			kind: "session.metadata_patched",
			generation: metadataGeneration,
			metadata: { name: "latest", model: "latest" },
		},
	});
	const metadataForward = replay(metadataSeed, [delayedClear, newerMetadata]);
	const metadataReverse = replay(metadataSeed, [newerMetadata, delayedClear]);
	assert.equal(canonical(metadataForward), canonical(metadataReverse));
	assert.deepEqual(metadataForward.generations[metadataGeneration.generation_id].metadata, {
		model: "latest",
		name: "latest",
	});

	const delayedSet = signal({
		number: 33,
		producer: 5,
		sequence: 1,
		sourceAt: "2026-07-20T10:01:00.000Z",
		payload: {
			kind: "session.metadata_patched",
			generation: metadataGeneration,
			metadata: { model: "late" },
		},
	});
	const newestClear = {
		...signal({
			number: 34,
			producer: 4,
			sequence: 1,
			sourceAt: "2026-07-20T10:01:10.000Z",
			payload: {
				kind: "session.metadata_patched",
				generation: metadataGeneration,
				metadata: {},
			},
		}),
		clear_fields: ["model"],
	};
	const clearForward = replay(metadataForward, [delayedSet, newestClear]);
	const clearReverse = replay(metadataForward, [newestClear, delayedSet]);
	assert.equal(canonical(clearForward), canonical(clearReverse));
	assert.equal("model" in clearForward.generations[metadataGeneration.generation_id].metadata, false);

	const sameSequenceEarlier = signal({
		number: 41,
		producer: 6,
		sequence: 7,
		sourceAt: "2026-07-20T10:01:20.000Z",
		payload: {
			kind: "session.metadata_patched",
			generation: metadataGeneration,
			metadata: { name: "earlier" },
		},
	});
	const sameSequenceLater = signal({
		number: 42,
		producer: 6,
		sequence: 7,
		sourceAt: "2026-07-20T10:01:20.000Z",
		payload: {
			kind: "session.metadata_patched",
			generation: metadataGeneration,
			metadata: { name: "later" },
		},
	});
	const tieForward = replay(clearForward, [sameSequenceEarlier, sameSequenceLater]);
	const tieReverse = replay(clearForward, [sameSequenceLater, sameSequenceEarlier]);
	assert.equal(canonical(tieForward), canonical(tieReverse));
	assert.equal(tieForward.generations[metadataGeneration.generation_id].metadata.name, "later");

	const terminalGeneration = generation(200);
	const terminalSeed = apply(
		emptyDomainState(),
		signal({
			number: 50,
			producer: 7,
			sequence: 1,
			sourceAt: "2026-07-20T10:02:00.000Z",
			payload: { kind: "session.started", generation: terminalGeneration },
		}),
	).state;
	const terminalEvent = signal({
		number: 51,
		producer: 7,
		sequence: 2,
		sourceAt: "2026-07-20T10:02:01.000Z",
		payload: { kind: "session.ended", generation: terminalGeneration, disposition: "ended" },
	});
	const resumedGeneration = { ...terminalGeneration, generation_id: generationId(201) };
	const resumeEvent = signal({
		number: 52,
		producer: 7,
		sequence: 3,
		sourceAt: "2026-07-20T10:02:02.000Z",
		payload: {
			kind: "session.resumed",
			generation: resumedGeneration,
			resumed_from_generation_id: terminalGeneration.generation_id,
		},
	});
	const terminalForward = replay(terminalSeed, [terminalEvent, resumeEvent]);
	const terminalReverse = replay(terminalSeed, [resumeEvent, terminalEvent]);
	assert.equal(canonical(terminalForward), canonical(terminalReverse));
	assert.equal(terminalForward.generations[terminalGeneration.generation_id].state, "superseded");
	assert.equal(terminalForward.sessions[terminalGeneration.session_id].activeGenerationId, resumedGeneration.generation_id);
	assert.equal(
		apply(
			apply(terminalSeed, terminalEvent).state,
			signal({
				number: 53,
				producer: 7,
				sequence: 3,
				sourceAt: "2026-07-20T10:02:03.000Z",
				payload: {
					kind: "session.metadata_patched",
					generation: terminalGeneration,
					metadata: { name: "forbidden" },
				},
			}),
		).effect.explanation.code,
		"domain.lifecycle.terminal",
		"terminal metadata is blocked even from a different producer ordering",
	);

	const superseded = generation(210);
	const replacement = { ...superseded, generation_id: generationId(211) };
	const supersedeEarlier = signal({
		number: 54,
		producer: 8,
		sequence: 1,
		sourceAt: "2026-07-20T10:03:00.000Z",
		payload: { kind: "session.started", generation: superseded },
	});
	const supersedeLater = signal({
		number: 55,
		producer: 8,
		sequence: 2,
		sourceAt: "2026-07-20T10:03:01.000Z",
		payload: { kind: "session.started", generation: replacement },
	});
	const supersedeForward = replay(emptyDomainState(), [supersedeEarlier, supersedeLater]);
	const supersedeReverse = replay(emptyDomainState(), [supersedeLater, supersedeEarlier]);
	assert.equal(canonical(supersedeForward), canonical(supersedeReverse));
	assert.equal(supersedeForward.generations[superseded.generation_id].state, "superseded");

	const endpointV1 = signal({
		number: 60,
		producer: 9,
		sequence: 1,
		payload: {
			kind: "endpoint.claimed",
			endpoint: {
				endpoint_id: endpointId,
				generation: metadataGeneration,
				state: "healthy",
				owner_fence: "fence-1",
				delivery_mode: "native_channel",
				readiness: "ready",
				revision: 1,
			},
		},
	});
	const endpointV2 = signal({
		number: 61,
		producer: 10,
		sequence: 1,
		payload: {
			kind: "endpoint.readiness_changed",
			endpoint: {
				endpoint_id: endpointId,
				generation: metadataGeneration,
				state: "healthy",
				owner_fence: "fence-2",
				delivery_mode: "native_channel",
				readiness: "held_busy",
				revision: 2,
			},
		},
	});
	const endpointForward = replay(metadataSeed, [endpointV1, endpointV2]);
	const endpointReverse = replay(metadataSeed, [endpointV2, endpointV1]);
	assert.equal(canonical(endpointForward), canonical(endpointReverse));
	assert.equal(endpointForward.endpoints[endpointId].revision, 2);
	const endpointBusy = signal({
		number: 63,
		producer: 10,
		sequence: 2,
		sourceAt: "2026-07-20T10:05:00.000Z",
		payload: {
			kind: "endpoint.readiness_changed",
			endpoint: {
				...endpointV2.payload.endpoint,
				readiness: "held_busy",
			},
		},
	});
	const endpointReady = signal({
		number: 64,
		producer: 11,
		sequence: 1,
		sourceAt: "2026-07-20T10:05:01.000Z",
		payload: {
			kind: "endpoint.readiness_changed",
			endpoint: {
				...endpointV2.payload.endpoint,
				readiness: "ready",
			},
		},
	});
	const endpointTieForward = replay(endpointForward, [endpointBusy, endpointReady]);
	const endpointTieReverse = replay(endpointForward, [endpointReady, endpointBusy]);
	assert.equal(canonical(endpointTieForward), canonical(endpointTieReverse));
	assert.equal(endpointTieForward.endpoints[endpointId].readiness, "ready");
	const heartbeatEarlier = signal({
		number: 65,
		producer: 12,
		sequence: 1,
		ownerFence: "fence-2",
		sourceAt: "2026-07-20T10:05:02.000Z",
		payload: {
			kind: "endpoint.heartbeat",
			endpoint: { endpoint_id: endpointId, generation: metadataGeneration },
			heartbeat_at: "2026-07-20T10:05:02.000Z",
		},
	});
	const heartbeatLater = signal({
		number: 66,
		producer: 13,
		sequence: 1,
		ownerFence: "fence-2",
		sourceAt: "2026-07-20T10:05:03.000Z",
		payload: {
			kind: "endpoint.heartbeat",
			endpoint: { endpoint_id: endpointId, generation: metadataGeneration },
			heartbeat_at: "2026-07-20T10:05:03.000Z",
		},
	});
	const heartbeatForward = replay(endpointTieForward, [heartbeatEarlier, heartbeatLater]);
	const heartbeatReverse = replay(endpointTieForward, [heartbeatLater, heartbeatEarlier]);
	assert.equal(canonical(heartbeatForward), canonical(heartbeatReverse));
	const readinessBeforeRelease = signal({
		number: 67,
		producer: 14,
		sequence: 1,
		ownerFence: "fence-2",
		sourceAt: "2026-07-20T10:05:04.000Z",
		payload: {
			kind: "endpoint.readiness_changed",
			endpoint: {
				...endpointV2.payload.endpoint,
				readiness: "held_busy",
			},
		},
	});
	const endpointRelease = signal({
		number: 68,
		producer: 15,
		sequence: 1,
		ownerFence: "fence-2",
		sourceAt: "2026-07-20T10:05:05.000Z",
		payload: {
			kind: "endpoint.released",
			endpoint: { endpoint_id: endpointId, generation: metadataGeneration },
		},
	});
	const releaseForward = replay(heartbeatForward, [readinessBeforeRelease, endpointRelease]);
	const releaseReverse = replay(heartbeatForward, [endpointRelease, readinessBeforeRelease]);
	assert.equal(canonical(releaseForward), canonical(releaseReverse));
	assert.equal(releaseForward.endpoints[endpointId].state, "released");
	const heartbeat = apply(
		releaseForward,
		signal({
			number: 72,
			producer: 10,
			sequence: 3,
			ownerFence: "fence-1",
			payload: {
				kind: "endpoint.heartbeat",
				endpoint: { endpoint_id: endpointId, generation: metadataGeneration },
				heartbeat_at: "2026-07-20T10:04:00.000Z",
			},
		}),
	);
	assert.equal(heartbeat.effect.explanation.code, "domain.endpoint.fence_stale");
	assert.equal(
		heartbeat.state.generations[metadataGeneration.generation_id].clocks.lastActivityAt,
		undefined,
		"endpoint heartbeat never becomes actor activity",
	);

	let aliases = tieForward;
	const alias = {
		projectId,
		harness: "claude",
		kind: "native_conversation",
		value: "thread-1",
		sessionId: metadataGeneration.session_id,
	};
	const canonicalAliasKinds = [
		"native_conversation",
		"native_run",
		"legacy_canonical_id",
		"supervisor_thread",
		"bridge_session",
		"migration_relation",
	];
	for (const [index, kind] of canonicalAliasKinds.entries()) {
		const outcome = attachAlias(aliases, {
			...alias,
			kind,
			value: `canonical-${kind}`,
			sessionId: sessionId(290 + index),
		});
		assert.equal(outcome.effect.disposition, "applied", `${kind} is canonical`);
		aliases = outcome.state;
	}
	assert.deepEqual(
		Object.values(aliases.aliases)
			.filter((entry) => entry.value.startsWith("canonical-"))
			.map((entry) => entry.kind)
			.sort(),
		[...canonicalAliasKinds].sort(),
		"the alias boundary represents exactly the six GOL-26 canonical kinds",
	);
	const removedShorthand = attachAlias(aliases, {
		...alias,
		kind: "path",
		value: "/tmp",
		sessionId: sessionId(299),
	});
	assert.equal(removedShorthand.effect.disposition, "rejected");
	assert.equal(removedShorthand.effect.explanation.code, "domain.alias.invalid");
	assert.equal(removedShorthand.state, aliases, "removed shorthand cannot attach");
	const { sessionId: _resolvedSessionId, ...unresolvedEvidence } = alias;
	const unresolvedAlias = attachAlias(aliases, {
		...unresolvedEvidence,
		harness: "codex",
		kind: "native_run",
		value: "unresolved-run-evidence",
	});
	assert.equal(unresolvedAlias.effect.disposition, "review");
	assert.equal(unresolvedAlias.effect.explanation.code, "domain.alias.unresolved");
	assert.equal(unresolvedAlias.state, aliases, "unresolved evidence never auto-links");
	for (const [index, harness] of ["claude", "codex", "opencode", "pi"].entries()) {
		const outcome = attachAlias(aliases, { ...alias, harness, sessionId: sessionId(300 + index) });
		assert.equal(outcome.effect.disposition, "applied", `${harness} aliases are origin-scoped`);
		aliases = outcome.state;
	}
	assert.equal(attachAlias(aliases, { ...alias, sessionId: sessionId(400) }).effect.disposition, "review");
	const replayAliases = (candidates) =>
		candidates.reduce((state, candidate) => attachAlias(state, candidate).state, emptyDomainState());
	const aliasEarlier = { ...alias, sessionId: sessionId(401) };
	const aliasLater = { ...alias, sessionId: sessionId(400) };
	const aliasForward = replayAliases([aliasEarlier, aliasLater]);
	const aliasReverse = replayAliases([aliasLater, aliasEarlier]);
	assert.equal(JSON.stringify(aliasForward), JSON.stringify(aliasReverse));
	assert.equal(Object.values(aliasForward.aliases)[0].sessionId, sessionId(400));

	const pullCapability = {
		capability_id: "codex.direct",
		harness: "codex",
		adapter_version: "1.0.0",
		integration_layers: ["hooks"],
		qualification: "supported",
		delivery_mode: "pull",
		readiness: "ready",
	};
	assert.equal(resolveCapability(pullCapability).readiness, "pull_only");
	assert.equal(
		resolveCapability({
			...pullCapability,
			capability_id: "pi.next-turn",
			harness: "pi",
			delivery_mode: "next_turn",
			readiness: "next_turn",
		}).readiness,
		"next_turn",
	);
	assert.equal(resolveCapability({ ...pullCapability, qualification: "unsupported" }).readiness, "unsupported");
	const capabilityEarlier = signal({
		number: 69,
		producer: 16,
		sequence: 1,
		sourceAt: "2026-07-20T10:06:00.000Z",
		payload: {
			kind: "capabilities.reported",
			capabilities: [{ ...pullCapability, readiness: "uninitialized" }],
		},
	});
	const capabilityLater = signal({
		number: 71,
		producer: 17,
		sequence: 1,
		sourceAt: "2026-07-20T10:06:01.000Z",
		payload: {
			kind: "capabilities.reported",
			capabilities: [
				{
					...pullCapability,
					delivery_mode: "next_turn",
					readiness: "next_turn",
				},
			],
		},
	});
	const capabilityForward = replay(emptyDomainState(), [capabilityEarlier, capabilityLater]);
	const capabilityReverse = replay(emptyDomainState(), [capabilityLater, capabilityEarlier]);
	assert.equal(canonical(capabilityForward), canonical(capabilityReverse));
	assert.equal(capabilityForward.capabilities[pullCapability.capability_id].capability.readiness, "next_turn");

	const closedResume = apply(
		terminalForward,
		signal({
			number: 70,
			producer: 7,
			sequence: 4,
			sourceAt: "2026-07-20T10:02:04.000Z",
			payload: { kind: "session.ended", generation: resumedGeneration, disposition: "ended" },
		}),
	).state;
	const projections = projectDomain(closedResume);
	assert.equal(projections.live.some((entry) => entry.sessionId === terminalGeneration.session_id), false);
	assert.equal(projections.history.some((entry) => entry.sessionId === terminalGeneration.session_id), true);
	assert.ok(projections.diagnostics.some((entry) => entry.code === "domain.projection.history_terminal"));

	return "four harness origins; stage-dominant lifecycle and terminal/idle convergence; provenance-selected duplicate creation; source-versioned metadata, project, activity, capability, and endpoint convergence; six canonical aliases, removed shorthand rejection, unresolved review, terminal/resume/supersede, readiness, and projections verified";
}
