import fs from "node:fs";
import path from "node:path";
import type { RuntimeSignalV1 } from "@golem/contracts";
import { ProjectIdSchema } from "@golem/contracts";
import type {
	RuntimeProjectLocationInput,
	RuntimeProjectView,
} from "@golem/persistence";
import {
	discoverProjectEvidence,
	eventIdForPath,
	locationIdForPath,
	markerProjectName,
	rejectBroadRoot,
} from "./evidence.js";
import type {
	ProjectDiscoveryEvidence,
	ProjectRegisterInput,
	ProjectResolution,
	ProjectServiceOptions,
} from "./types.js";

function nameFor(canonicalPath: string): string {
	return path.basename(canonicalPath) || "project";
}

function emptyDiagnostic(code: string, remedy?: string) {
	return Object.freeze({
		code,
		...(remedy ? { remedy } : {}),
		ignoredCandidates: Object.freeze([] as string[]),
	});
}

function locationFromEvidence(
	evidence: ProjectDiscoveryEvidence,
	source: "git" | "marker" | "register",
	observedAt: string,
): RuntimeProjectLocationInput {
	if (!evidence.canonicalPath)
		throw new Error("runtime.project.path_unavailable");
	return Object.freeze({
		locationId: locationIdForPath(),
		canonicalPath: evidence.canonicalPath,
		...(evidence.inputPath !== evidence.canonicalPath
			? { observedPath: evidence.inputPath }
			: {}),
		relation: evidence.relation ?? (source === "git" ? "main" : "registered"),
		source,
		evidence: Object.freeze({
			root: evidence.projectRoot ?? evidence.canonicalPath,
			...(evidence.gitCommonDir
				? { git_common_dir: evidence.gitCommonDir }
				: {}),
			...(evidence.markerPath ? { marker: evidence.markerPath } : {}),
		}),
		observedAt,
	});
}

export class ProjectService {
	readonly #options: ProjectServiceOptions;

	constructor(options: ProjectServiceOptions) {
		this.#options = options;
	}

	#now(): string {
		return this.#options.now?.() ?? new Date().toISOString();
	}

	#resolveEvidence(cwd: string): ProjectDiscoveryEvidence {
		const evidence = discoverProjectEvidence(cwd);
		if (!evidence.canonicalPath)
			throw new Error("runtime.project.path_unavailable");
		if (!fs.statSync(evidence.canonicalPath).isDirectory())
			throw new Error("runtime.project.not_directory");
		rejectBroadRoot(evidence.canonicalPath, this.#options);
		return evidence;
	}

	resolve(cwd: string): ProjectResolution {
		const evidence = this.#resolveEvidence(cwd);
		const canonicalPath = evidence.canonicalPath;
		if (!canonicalPath) throw new Error("runtime.project.path_unavailable");
		const knownByPath = evidence.canonicalPath
			? this.#options.storage.findByCanonicalPath(evidence.canonicalPath)
			: undefined;
		if (evidence.source === "none" && knownByPath)
			return Object.freeze({
				status: "registered",
				evidence,
				view: knownByPath,
				diagnostic: emptyDiagnostic("runtime.project.resolved"),
			});
		if (evidence.source === "git" || evidence.source === "marker") {
			const byIdentity = evidence.identityKey
				? this.#options.storage.findByIdentityKey(evidence.identityKey)
				: undefined;
			const byPath = evidence.canonicalPath
				? this.#options.storage.findByCanonicalPath(evidence.canonicalPath)
				: undefined;
			if (byIdentity && byPath && byIdentity.projectId !== byPath.projectId)
				return Object.freeze({
					status: "ambiguous",
					evidence,
					diagnostic: emptyDiagnostic(
						"runtime.project.identity_ambiguous",
						"golem project explain",
					),
				});
			if (byIdentity || byPath) {
				const view = byIdentity ?? byPath;
				if (!view) throw new Error("runtime.project.materialization_missing");
				if (
					byIdentity &&
					!byPath &&
					evidence.canonicalPath &&
					!view.locations.some(
						(location) => location.canonicalPath === evidence.canonicalPath,
					)
				) {
					const attached = this.#options.storage.attachLocation({
						projectId: view.projectId,
						location: locationFromEvidence(evidence, "git", this.#now()),
						...(evidence.identityKey
							? { identityKey: evidence.identityKey }
							: {}),
						source: "git",
					});
					return Object.freeze({
						status: "registered",
						evidence,
						view: attached,
						diagnostic: emptyDiagnostic("runtime.project.worktree_attached"),
					});
				}
				return Object.freeze({
					status: "registered",
					evidence,
					view,
					diagnostic: emptyDiagnostic("runtime.project.resolved"),
				});
			}
			const projectId =
				evidence.markerProjectId &&
				ProjectIdSchema.safeParse(evidence.markerProjectId).success
					? evidence.markerProjectId
					: undefined;
			const location = locationFromEvidence(
				evidence,
				evidence.source,
				this.#now(),
			);
			const observed = this.#options.storage.observe({
				...(projectId ? { projectId } : {}),
				name: markerProjectName(canonicalPath) ?? nameFor(canonicalPath),
				location,
				...(evidence.identityKey ? { identityKey: evidence.identityKey } : {}),
				metadata: { discovery: evidence.source },
				source: evidence.source,
				eventId: eventIdForPath(canonicalPath, "project-observed"),
				deduplicationKey: `project-observed:${evidence.identityKey ?? evidence.canonicalPath}`,
				payload: {
					kind: "project.observed",
					project_id: projectId ?? "allocated",
					location: evidence.canonicalPath,
				},
				provenance: {
					source: evidence.source,
					evidence_id: evidence.identityKey ?? evidence.canonicalPath,
				},
				occurredAt: this.#now(),
			});
			const view = this.#options.storage.get(observed.projectId);
			if (!view) throw new Error("runtime.project.materialization_missing");
			return Object.freeze({
				status: "registered",
				evidence,
				view,
				diagnostic: emptyDiagnostic("runtime.project.auto_registered"),
			});
		}
		return Object.freeze({
			status: "unregistered",
			evidence,
			diagnostic: emptyDiagnostic(
				"runtime.project.unregistered",
				`golem project register ${evidence.canonicalPath}`,
			),
		});
	}

	/** Apply a validated project.observed signal through the same durable capability. */
	ingest(signal: RuntimeSignalV1): RuntimeProjectView {
		if (signal.payload.kind !== "project.observed")
			throw new Error("runtime.project.signal_unsupported");
		const source =
			signal.provenance.source === "legacy_import"
				? "legacy_import"
				: signal.provenance.source === "migration"
					? "marker"
					: signal.provenance.source === "api"
						? "register"
						: "git";
		const observed = this.#options.storage.observe({
			projectId: signal.payload.project.project_id,
			name: signal.payload.project.project_id,
			location: {
				locationId: signal.payload.location.location_id,
				canonicalPath: signal.payload.location.canonical_path,
				...(signal.payload.location.observed_path
					? { observedPath: signal.payload.location.observed_path }
					: {}),
				relation: signal.payload.location.relation,
				source,
				evidence: { signal: signal.event_id },
				observedAt: signal.clocks.source_observed_at,
			},
			source,
			eventId: signal.event_id,
			deduplicationKey: signal.deduplication_key,
			payload: signal.payload,
			provenance: signal.provenance,
			occurredAt: signal.clocks.source_observed_at,
		});
		const view = this.#options.storage.get(observed.projectId);
		if (!view) throw new Error("runtime.project.materialization_missing");
		return view;
	}

	register(input: ProjectRegisterInput): RuntimeProjectView {
		const evidence = this.#resolveEvidence(input.cwd);
		if (!evidence.canonicalPath)
			throw new Error("runtime.project.path_unavailable");
		const canonicalPath = evidence.canonicalPath;
		const source =
			evidence.source === "git"
				? "git"
				: evidence.source === "marker"
					? "marker"
					: "register";
		const explicitProjectId = input.projectId ?? evidence.markerProjectId;
		if (
			explicitProjectId &&
			!ProjectIdSchema.safeParse(explicitProjectId).success
		)
			throw new Error("runtime.project.project_id_invalid");
		const existing =
			(evidence.identityKey
				? this.#options.storage.findByIdentityKey(evidence.identityKey)
				: undefined) ??
			this.#options.storage.findByCanonicalPath(canonicalPath);
		const location = locationFromEvidence(evidence, "register", this.#now());
		const view = existing
			? this.#options.storage.attachLocation({
					projectId: explicitProjectId ?? existing.projectId,
					...(input.name ? { name: input.name } : {}),
					location,
					...(evidence.identityKey
						? { identityKey: evidence.identityKey }
						: {}),
					metadata: input.name ? { registration: "explicit" } : {},
					// A host restart calls register({ cwd }) without an operator-supplied
					// name. It must refresh the discovered location without turning an
					// automatic project name into a manual one.
					source: input.name ? "register" : source,
				})
			: this.#options.storage.observe({
					...(explicitProjectId ? { projectId: explicitProjectId } : {}),
					name:
						input.name ??
						markerProjectName(canonicalPath) ??
						nameFor(canonicalPath),
					location,
					...(evidence.identityKey
						? { identityKey: evidence.identityKey }
						: {}),
					metadata: { registration: "explicit" },
					source,
					eventId: eventIdForPath(canonicalPath, "project-register"),
					deduplicationKey: `project-register:${explicitProjectId ?? evidence.identityKey ?? canonicalPath}`,
					payload: {
						kind: "project.register",
						canonical_path: canonicalPath,
					},
					provenance: {
						source,
						evidence_id: evidence.identityKey ?? canonicalPath,
					},
					occurredAt: this.#now(),
				}).projectId;
		const result =
			typeof view === "string" ? this.#options.storage.get(view) : view;
		if (!result) throw new Error("runtime.project.materialization_missing");
		if (input.retireLocationId)
			return this.#options.storage.retireLocation(
				result.projectId,
				input.retireLocationId,
				"relocated",
			);
		return result;
	}

	rename(projectId: string, name: string): RuntimeProjectView {
		if (!name.trim()) throw new Error("runtime.project.name_required");
		return this.#options.storage.rename(projectId, name.trim(), "register");
	}

	addLocation(
		projectId: string,
		cwd: string,
		retireLocationId?: string,
	): RuntimeProjectView {
		const evidence = this.#resolveEvidence(cwd);
		if (!evidence.canonicalPath)
			throw new Error("runtime.project.path_unavailable");
		const location = locationFromEvidence(evidence, "register", this.#now());
		const view = this.#options.storage.attachLocation({
			projectId,
			location,
			...(evidence.identityKey ? { identityKey: evidence.identityKey } : {}),
			source: "register",
		});
		return retireLocationId
			? this.#options.storage.retireLocation(
					projectId,
					retireLocationId,
					"relocated",
				)
			: view;
	}

	retireLocation(
		projectId: string,
		locationId: string,
		reason = "retired",
	): RuntimeProjectView {
		return this.#options.storage.retireLocation(projectId, locationId, reason);
	}

	explain(cwd: string): ProjectResolution {
		return this.resolve(cwd);
	}
}

export function createProjectService(
	options: ProjectServiceOptions,
): ProjectService {
	return new ProjectService(options);
}
