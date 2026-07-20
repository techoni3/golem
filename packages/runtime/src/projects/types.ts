import type {
	ProjectIdentitySource,
	RuntimeProjectLocationInput,
	RuntimeProjectStorage,
	RuntimeProjectView,
} from "@golem/persistence";

export interface ProjectDiscoveryEvidence {
	readonly inputPath: string;
	readonly canonicalPath?: string;
	readonly projectRoot?: string;
	readonly gitCommonDir?: string;
	readonly identityKey?: string;
	readonly source: ProjectIdentitySource | "none";
	readonly relation?: RuntimeProjectLocationInput["relation"];
	readonly markerPath?: string;
	readonly markerProjectId?: string;
	readonly isWorktree?: boolean;
}

export type ProjectResolutionStatus =
	| "registered"
	| "unregistered"
	| "ambiguous";

export interface ProjectResolution {
	readonly status: ProjectResolutionStatus;
	readonly evidence: ProjectDiscoveryEvidence;
	readonly view?: RuntimeProjectView;
	readonly diagnostic: {
		readonly code: string;
		readonly remedy?: string;
		readonly ignoredCandidates: readonly string[];
	};
}

export interface ProjectRegisterInput {
	readonly cwd: string;
	readonly name?: string;
	readonly projectId?: string;
	readonly retireLocationId?: string;
}

export interface ProjectServiceOptions {
	readonly storage: RuntimeProjectStorage;
	readonly golemHome?: string;
	readonly homeDirectory?: string;
	readonly now?: () => string;
}
