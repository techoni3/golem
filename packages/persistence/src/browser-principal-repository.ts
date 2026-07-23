import crypto from "node:crypto";

import type { SqliteConnection } from "./internals.js";
import type {
	BrowserPrincipalStorage,
	PersistenceClock,
	PrincipalBinding,
	PrincipalBindingProvision,
	PrincipalRole,
} from "./types.js";

interface BindingRow {
	readonly id: string;
	readonly actor_id: string;
	readonly role: PrincipalRole;
	readonly default_project_id: string;
	readonly enabled: number;
	readonly version: number;
	readonly expires_at: string | null;
	readonly revoked_at: string | null;
}

function digest(value: string): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}

function validText(value: string): boolean {
	return value.trim().length > 0 && value.length <= 512;
}

function validTimestamp(value: string): boolean {
	return Number.isFinite(Date.parse(value));
}

function active(row: BindingRow, now: string): boolean {
	return (
		row.enabled === 1 &&
		row.revoked_at === null &&
		(row.expires_at === null ||
			(validTimestamp(row.expires_at) &&
				Date.parse(row.expires_at) > Date.parse(now)))
	);
}

/** Opaque, durable policy state. Browser/bearer values are hashed before they
 * reach SQLite and no raw credential is included in a returned binding. */
export class BrowserPrincipalRepository implements BrowserPrincipalStorage {
	readonly #database: SqliteConnection;
	readonly #clock: PersistenceClock;

	constructor(database: SqliteConnection, clock: PersistenceClock) {
		this.#database = database;
		this.#clock = clock;
	}

	#binding(row: BindingRow, now?: string): PrincipalBinding | undefined {
		if (now !== undefined && !active(row, now)) return undefined;
		const scopes = this.#database
			.prepare<{ readonly project_id: string }>(
				"SELECT project_id FROM browser_principal_scopes WHERE binding_id = ? ORDER BY project_id",
			)
			.all(row.id)
			.map((scope) => scope.project_id);
		if (!scopes.includes(row.default_project_id)) return undefined;
		return Object.freeze({
			id: row.id,
			actorId: row.actor_id,
			role: row.role,
			defaultProjectId: row.default_project_id,
			scopeProjectIds: Object.freeze(scopes),
			enabled: row.enabled === 1,
			version: Number(row.version),
			...(row.expires_at ? { expiresAt: row.expires_at } : {}),
			...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
		});
	}

	provision(input: PrincipalBindingProvision): PrincipalBinding {
		if (
			!validText(input.id) ||
			!validText(input.actorId) ||
			!validText(input.defaultProjectId) ||
			input.scopeProjectIds.length === 0 ||
			!input.scopeProjectIds.every(validText) ||
			!input.scopeProjectIds.includes(input.defaultProjectId) ||
			(input.expiresAt !== undefined && !validTimestamp(input.expiresAt))
		)
			throw new Error("principal binding provision is invalid");
		const scopes = [...new Set(input.scopeProjectIds)].sort();
		const now = this.#clock.now();
		const transaction = this.#database.transaction(() => {
			this.#database
				.prepare(
					"INSERT INTO browser_principal_bindings (id, actor_id, role, default_project_id, enabled, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					input.id,
					input.actorId,
					input.role,
					input.defaultProjectId,
					input.enabled === false ? 0 : 1,
					input.expiresAt ?? null,
					now,
					now,
				);
			const insertScope = this.#database.prepare(
				"INSERT INTO browser_principal_scopes (binding_id, project_id) VALUES (?, ?)",
			);
			for (const projectId of scopes) insertScope.run(input.id, projectId);
		});
		transaction.immediate();
		const row = this.#database
			.prepare<BindingRow>(
				"SELECT id, actor_id, role, default_project_id, enabled, version, expires_at, revoked_at FROM browser_principal_bindings WHERE id = ?",
			)
			.get(input.id);
		if (!row) throw new Error("principal binding provision was not durable");
		const binding = this.#binding(row);
		if (!binding) throw new Error("principal binding scope is invalid");
		return binding;
	}

	bindCredential(input: {
		readonly bindingId: string;
		readonly adapter: "bearer" | "mcp" | "internal";
		readonly credential: string;
		readonly expiresAt?: string;
	}): void {
		if (!validText(input.credential))
			throw new Error("principal credential is invalid");
		if (input.expiresAt !== undefined && !validTimestamp(input.expiresAt))
			throw new Error("principal credential expiry is invalid");
		const exists = this.#database
			.prepare<{ readonly id: string }>(
				"SELECT id FROM browser_principal_bindings WHERE id = ?",
			)
			.get(input.bindingId);
		if (!exists) throw new Error("principal binding is unknown");
		this.#database
			.prepare(
				"INSERT INTO browser_principal_credentials (adapter, credential_digest, binding_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.run(
				input.adapter,
				digest(input.credential),
				input.bindingId,
				input.expiresAt ?? null,
				this.#clock.now(),
			);
	}

	resolveCredential(input: {
		readonly adapter: "bearer" | "mcp" | "internal";
		readonly credential: string;
		readonly now: string;
	}): PrincipalBinding | undefined {
		if (!validText(input.credential)) return undefined;
		const row = this.#database
			.prepare<BindingRow & { readonly credential_expires_at: string | null }>(
				`SELECT binding.id, binding.actor_id, binding.role, binding.default_project_id, binding.enabled, binding.version, binding.expires_at, binding.revoked_at, credential.expires_at AS credential_expires_at FROM browser_principal_credentials AS credential JOIN browser_principal_bindings AS binding ON binding.id = credential.binding_id WHERE credential.adapter = ? AND credential.credential_digest = ? AND credential.revoked_at IS NULL AND (credential.expires_at IS NULL OR credential.expires_at > ?)`,
			)
			.get(input.adapter, digest(input.credential), input.now);
		if (
			row &&
			row.credential_expires_at !== null &&
			(!validTimestamp(row.credential_expires_at) ||
				Date.parse(row.credential_expires_at) <= Date.parse(input.now))
		)
			return undefined;
		return row ? this.#binding(row, input.now) : undefined;
	}

	createBrowserSession(input: {
		readonly bindingId: string;
		readonly session: string;
		readonly csrf: string;
		readonly expiresAt: string;
		readonly now: string;
	}): boolean {
		if (
			!validText(input.session) ||
			!validText(input.csrf) ||
			!validTimestamp(input.expiresAt) ||
			Date.parse(input.expiresAt) <= Date.parse(input.now)
		)
			return false;
		const binding = this.#database
			.prepare<BindingRow>(
				"SELECT id, actor_id, role, default_project_id, enabled, version, expires_at, revoked_at FROM browser_principal_bindings WHERE id = ?",
			)
			.get(input.bindingId);
		const resolved = binding ? this.#binding(binding, input.now) : undefined;
		// Browser-session issuance proves a durable, enabled binding. Read-only
		// viewers may therefore receive a same-origin session; mutation policy
		// remains resolver-owned and rejects them before a command can run.
		if (!resolved) return false;
		this.#database
			.prepare(
				"INSERT INTO browser_principal_sessions (session_digest, csrf_digest, binding_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.run(
				digest(input.session),
				digest(input.csrf),
				input.bindingId,
				input.expiresAt,
				input.now,
			);
		return true;
	}

	resolveBrowserSession(input: {
		readonly session: string;
		readonly csrf?: string;
		readonly now: string;
	}): PrincipalBinding | undefined {
		if (!validText(input.session)) return undefined;
		const row = this.#database
			.prepare<
				BindingRow & {
					readonly csrf_digest: string;
					readonly session_expires_at: string;
				}
			>(
				`SELECT binding.id, binding.actor_id, binding.role, binding.default_project_id, binding.enabled, binding.version, binding.expires_at, binding.revoked_at, session.csrf_digest, session.expires_at AS session_expires_at FROM browser_principal_sessions AS session JOIN browser_principal_bindings AS binding ON binding.id = session.binding_id WHERE session.session_digest = ? AND session.revoked_at IS NULL AND session.expires_at > ?`,
			)
			.get(digest(input.session), input.now);
		if (
			!row ||
			!validTimestamp(row.session_expires_at) ||
			Date.parse(row.session_expires_at) <= Date.parse(input.now) ||
			(input.csrf !== undefined && digest(input.csrf) !== row.csrf_digest)
		)
			return undefined;
		return this.#binding(row, input.now);
	}

	revokeBinding(id: string, now: string): boolean {
		const transaction = this.#database.transaction(() => {
			const result = this.#database
				.prepare(
					"UPDATE browser_principal_bindings SET revoked_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND revoked_at IS NULL",
				)
				.run(now, now, id);
			if (result.changes > 0)
				this.#database
					.prepare(
						"UPDATE browser_principal_sessions SET revoked_at = ? WHERE binding_id = ? AND revoked_at IS NULL",
					)
					.run(now, id);
			return result.changes > 0;
		});
		return transaction.immediate();
	}
}
