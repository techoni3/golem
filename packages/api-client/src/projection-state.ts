export interface ProjectionStateLike {
	readonly resource_revision: number;
	readonly payload: unknown;
}

function objectValue(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** The authoritative snapshot consumer used by the typed dashboard Query cache. */
export function replaceProjectionSnapshot<T extends ProjectionStateLike>(
	_current: T | undefined,
	snapshot: T,
): T {
	return snapshot;
}

/** Merge only ordered same-instance deltas; snapshots are handled above. */
export function applyProjectionDelta<T extends ProjectionStateLike>(
	current: T | undefined,
	resourceRevision: number,
	delta: unknown,
): T | undefined {
	if (!current || resourceRevision < current.resource_revision) return current;
	return {
		...current,
		resource_revision: resourceRevision,
		payload: {
			...objectValue(current.payload),
			...objectValue(delta),
		},
	} as T;
}
