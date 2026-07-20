import crypto from "node:crypto";

import type { PersistenceClock } from "./types.js";

/** The only ambient-time adapter; owners inject this boundary in production/tests. */
export const systemPersistenceClock: PersistenceClock = Object.freeze({
	now: () => new Date().toISOString(),
	after: (milliseconds: number) =>
		new Date(Date.now() + milliseconds).toISOString(),
});

export function createOwnerNonce(): string {
	return `owner_${crypto.randomUUID()}`;
}
