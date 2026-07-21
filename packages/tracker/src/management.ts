/// <reference types="node" />

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
	ManagementCommunicationKind,
	ManagementGateKind,
	ManagementGateStatus,
	ManagementRoleScope,
	TrackerJsonObject,
	TrackerManagementAsset,
	TrackerManagementAssignment,
	TrackerManagementAuditRecord,
	TrackerManagementGate,
	TrackerManagementIdea,
	TrackerManagementOperation,
	TrackerManagementRole,
	TrackerManagementStorageCapability,
} from "@golem/persistence";
import type { TrackerTicketService } from "./tickets/service.js";
import type { TrackerClock } from "./types.js";
import {
	requireIdentifier,
	requireJsonObject,
	sanitizeDiagnostic,
	TrackerValidationError,
} from "./validation.js";

const roleScopes = new Set<ManagementRoleScope>([
	"project",
	"session",
	"generation",
]);
const gateKinds = new Set<ManagementGateKind>(["approval", "input"]);
const gateStatuses = new Set<ManagementGateStatus>([
	"approved",
	"denied",
	"cancelled",
]);
const operationKinds = new Set<ManagementCommunicationKind>([
	"chat",
	"brief",
	"interrupt",
	"halt",
	"control",
]);
const assetMimes = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);
const sensitiveKey =
	/(?:^|[_-])(?:token|credential|password|secret|api[_-]?key|authorization)(?:$|[_-])/iu;

export class TrackerManagementError extends Error {
	readonly code:
		| "management.invalid"
		| "management.not_found"
		| "management.forbidden"
		| "management.conflict"
		| "management.asset_invalid";

	constructor(code: TrackerManagementError["code"], message: string) {
		super(message);
		this.name = "TrackerManagementError";
		this.code = code;
	}
}

function invalid(message: string): never {
	throw new TrackerManagementError("management.invalid", message);
}

function id(value: unknown, label: string): string {
	try {
		return requireIdentifier(value, label);
	} catch (error) {
		if (error instanceof TrackerValidationError)
			throw new TrackerManagementError("management.invalid", error.message);
		throw error;
	}
}

function text(value: unknown, label: string, max = 4_096): string {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.length > max
	)
		invalid(`${label} must be nonblank text up to ${max} characters`);
	return value.trim();
}

function payload(value: unknown, label: string): TrackerJsonObject {
	try {
		requireJsonObject(value, label);
	} catch (error) {
		if (error instanceof TrackerValidationError)
			throw new TrackerManagementError("management.invalid", error.message);
		throw error;
	}
	return sanitizePayload(value as TrackerJsonObject);
}

function sanitizePayload(value: TrackerJsonObject): TrackerJsonObject {
	const visit = (entry: unknown, key?: string): unknown => {
		if (key && sensitiveKey.test(key)) return "[REDACTED]";
		if (typeof entry === "string") {
			try {
				return sanitizeDiagnostic(entry);
			} catch {
				return "[REDACTED]";
			}
		}
		if (Array.isArray(entry)) return entry.map((child) => visit(child, key));
		if (entry && typeof entry === "object")
			return Object.fromEntries(
				Object.entries(entry as Record<string, unknown>).map(
					([childKey, child]) => [childKey, visit(child, childKey)],
				),
			);
		return entry;
	};
	return visit(value) as TrackerJsonObject;
}

function actor(value: unknown): string {
	return text(value, "actor", 256);
}

function now(clock: TrackerClock): string {
	return clock.now();
}

function ensureProject(value: unknown): string {
	return id(value, "project id");
}

function ensureRoleScope(value: unknown): ManagementRoleScope {
	if (
		typeof value !== "string" ||
		!roleScopes.has(value as ManagementRoleScope)
	)
		invalid("role scope is unsupported");
	return value as ManagementRoleScope;
}

function ensureGateKind(value: unknown): ManagementGateKind {
	if (typeof value !== "string" || !gateKinds.has(value as ManagementGateKind))
		invalid("gate kind is unsupported");
	return value as ManagementGateKind;
}

function ensureOperationKind(value: unknown): ManagementCommunicationKind {
	if (
		typeof value !== "string" ||
		!operationKinds.has(value as ManagementCommunicationKind)
	)
		invalid("communication kind is unsupported");
	return value as ManagementCommunicationKind;
}

function ensureAssetPath(value: unknown): string {
	const relative = text(value, "asset path", 512).replaceAll("\\", "/");
	if (
		path.posix.isAbsolute(relative) ||
		relative.split("/").some((part) => part === ".." || part.length === 0) ||
		relative.includes("\0")
	)
		throw new TrackerManagementError(
			"management.asset_invalid",
			"asset path must be a relative ticket-bound path",
		);
	return relative;
}

function ensureSafeParent(root: string, target: string): void {
	const relativeParent = path.relative(root, path.dirname(target));
	let current = root;
	for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
			throw new TrackerManagementError(
				"management.asset_invalid",
				"asset parent cannot be a symbolic link",
			);
		fs.mkdirSync(current, { recursive: true, mode: 0o700 });
	}
}

function assertWithin(root: string, target: string): void {
	const relative = path.relative(root, target);
	if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
		throw new TrackerManagementError(
			"management.asset_invalid",
			"asset path escapes the configured store",
		);
}

export interface TrackerManagementServices {
	readonly roles: {
		create(input: {
			readonly projectId: string;
			readonly name: string;
			readonly scope?: ManagementRoleScope;
			readonly definition?: TrackerJsonObject;
			readonly actor: string;
		}): TrackerManagementRole;
		list(projectId: string): readonly TrackerManagementRole[];
		assign(input: {
			readonly projectId: string;
			readonly roleId: string;
			readonly sessionId?: string;
			readonly generationId?: string;
			readonly actor: string;
			readonly idempotencyKey: string;
		}): TrackerManagementAssignment;
	};
	readonly gates: {
		create(input: {
			readonly projectId: string;
			readonly kind: ManagementGateKind;
			readonly question: string;
			readonly assignee: string;
			readonly idempotencyKey: string;
			readonly actor: string;
		}): TrackerManagementGate;
		answer(input: {
			readonly projectId: string;
			readonly gateId: string;
			readonly status: Exclude<ManagementGateStatus, "awaiting">;
			readonly verdict: TrackerJsonObject;
			readonly actor: string;
		}): TrackerManagementGate;
		list(projectId: string): readonly TrackerManagementGate[];
	};
	readonly ideas: {
		create(input: {
			readonly projectId: string;
			readonly body: string;
			readonly idempotencyKey: string;
			readonly actor: string;
		}): TrackerManagementIdea;
		pop(input: {
			readonly projectId: string;
			readonly ideaId: string;
			readonly actor: string;
		}): TrackerManagementIdea;
		promote(input: {
			readonly projectId: string;
			readonly ideaId: string;
			readonly actor: string;
			readonly title?: string;
		}): TrackerManagementIdea;
		list(projectId: string): readonly TrackerManagementIdea[];
	};
	readonly assets: {
		put(input: {
			readonly projectId: string;
			readonly ticketId: string;
			readonly relativePath: string;
			readonly mimeType: string;
			readonly bytes: Uint8Array;
			readonly actor: string;
		}): TrackerManagementAsset;
		read(input: {
			readonly projectId: string;
			readonly ticketId: string;
			readonly assetId: string;
		}): { readonly asset: TrackerManagementAsset; readonly bytes: Uint8Array };
	};
	readonly communications: {
		create(input: {
			readonly projectId: string;
			readonly kind: ManagementCommunicationKind;
			readonly command: string;
			readonly payload?: TrackerJsonObject;
			readonly sessionId?: string;
			readonly generationId?: string;
			readonly actor: string;
			readonly idempotencyKey: string;
		}): TrackerManagementOperation;
	};
	readonly controls: {
		request(input: {
			readonly projectId: string;
			readonly command: string;
			readonly payload?: TrackerJsonObject;
			readonly sessionId?: string;
			readonly generationId?: string;
			readonly actor: string;
			readonly idempotencyKey: string;
		}): TrackerManagementOperation;
		get(input: {
			readonly projectId: string;
			readonly id: string;
		}): TrackerManagementOperation;
		list(projectId: string): readonly TrackerManagementOperation[];
	};
	audit(projectId: string): readonly TrackerManagementAuditRecord[];
}

export function createTrackerManagementServices(options: {
	readonly storage: TrackerManagementStorageCapability;
	readonly clock: TrackerClock;
	readonly assetRoot: string;
	readonly tickets?: TrackerTicketService;
}): TrackerManagementServices {
	const service: TrackerManagementServices = {
		roles: {
			create(input) {
				const projectId = ensureProject(input.projectId);
				const name = text(input.name, "role name", 128);
				const definition = payload(input.definition ?? {}, "role definition");
				const existing = options.storage
					.listRoles(projectId)
					.find((role) => role.name === name);
				return options.storage.createRole({
					id: existing?.id ?? `role_${crypto.randomUUID()}`,
					projectId,
					name,
					scope: ensureRoleScope(input.scope ?? "project"),
					definition,
					now: now(options.clock),
				});
			},
			list(projectId) {
				return options.storage.listRoles(ensureProject(projectId));
			},
			assign(input) {
				const projectId = ensureProject(input.projectId);
				const roleId = id(input.roleId, "role id");
				if (
					!options.storage
						.listRoles(projectId)
						.some((role) => role.id === roleId)
				)
					throw new TrackerManagementError(
						"management.not_found",
						"role does not belong to project",
					);
				const assignment = options.storage.assignRole({
					id: `rasg_${crypto.randomUUID()}`,
					projectId,
					roleId,
					...(input.sessionId === undefined
						? {}
						: { sessionId: id(input.sessionId, "session id") }),
					...(input.generationId === undefined
						? {}
						: { generationId: id(input.generationId, "generation id") }),
					actor: actor(input.actor),
					idempotencyKey: id(input.idempotencyKey, "idempotency key"),
					now: now(options.clock),
				});
				options.storage.createOperation({
					id: `op_${crypto.randomUUID()}`,
					projectId,
					kind: "control",
					command: "role.assign",
					payload: {
						role_id: roleId,
						assignment_id: assignment.id,
						...(input.sessionId === undefined
							? {}
							: { session_id: input.sessionId }),
						...(input.generationId === undefined
							? {}
							: { generation_id: input.generationId }),
					},
					actor: actor(input.actor),
					idempotencyKey: `role-assign:${id(input.idempotencyKey, "idempotency key")}`,
					now: now(options.clock),
				});
				return assignment;
			},
		},
		gates: {
			create(input) {
				return options.storage.createGate({
					id: `gate_${crypto.randomUUID()}`,
					projectId: ensureProject(input.projectId),
					kind: ensureGateKind(input.kind),
					question: text(input.question, "gate question"),
					assignee: actor(input.assignee),
					idempotencyKey: id(input.idempotencyKey, "idempotency key"),
					now: now(options.clock),
				});
			},
			answer(input) {
				if (!gateStatuses.has(input.status))
					invalid("gate verdict is unsupported");
				const result = options.storage.answerGate({
					id: id(input.gateId, "gate id"),
					projectId: ensureProject(input.projectId),
					status: input.status,
					verdict: payload(input.verdict, "gate verdict"),
					now: now(options.clock),
				});
				if (!result)
					throw new TrackerManagementError(
						"management.not_found",
						"gate does not belong to project",
					);
				return result;
			},
			list(projectId) {
				return options.storage.listGates(ensureProject(projectId));
			},
		},
		ideas: {
			create(input) {
				return options.storage.createIdea({
					id: `idea_${crypto.randomUUID()}`,
					projectId: ensureProject(input.projectId),
					body: text(input.body, "idea body", 16_384),
					idempotencyKey: id(input.idempotencyKey, "idempotency key"),
					now: now(options.clock),
				});
			},
			pop(input) {
				const result = options.storage.popIdea({
					id: id(input.ideaId, "idea id"),
					projectId: ensureProject(input.projectId),
					now: now(options.clock),
				});
				if (!result)
					throw new TrackerManagementError(
						"management.not_found",
						"idea does not belong to project",
					);
				return result;
			},
			promote(input) {
				const projectId = ensureProject(input.projectId);
				const ideaId = id(input.ideaId, "idea id");
				const current = options.storage
					.listIdeas(projectId)
					.find((idea) => idea.id === ideaId);
				if (!current)
					throw new TrackerManagementError(
						"management.not_found",
						"idea does not belong to project",
					);
				if (current.promotedTicketId) return current;
				if (!options.tickets)
					throw new TrackerManagementError(
						"management.invalid",
						"ticket promotion is not composed",
					);
				const ticket = options.tickets.create({
					projectId,
					kind: "work-item",
					title: text(
						input.title ?? current.body.slice(0, 120),
						"idea title",
						256,
					),
					body: current.body,
					labels: ["idea"],
					actor: actor(input.actor),
				});
				const promoted = options.storage.promoteIdea({
					id: ideaId,
					projectId,
					ticketId: ticket.id,
					now: now(options.clock),
				});
				if (!promoted)
					throw new TrackerManagementError(
						"management.conflict",
						"idea promotion could not be recorded",
					);
				return promoted;
			},
			list(projectId) {
				return options.storage.listIdeas(ensureProject(projectId));
			},
		},
		assets: {
			put(input) {
				const projectId = ensureProject(input.projectId);
				const ticketId = id(input.ticketId, "ticket id");
				if (
					options.tickets &&
					options.tickets.get(ticketId)?.ticket.projectId !== projectId
				)
					throw new TrackerManagementError(
						"management.forbidden",
						"ticket is not in the requested project",
					);
				const relativePath = ensureAssetPath(input.relativePath);
				if (!assetMimes.has(input.mimeType))
					throw new TrackerManagementError(
						"management.asset_invalid",
						"asset MIME type is not allowed",
					);
				if (
					!(input.bytes instanceof Uint8Array) ||
					input.bytes.byteLength === 0 ||
					input.bytes.byteLength > 10 * 1024 * 1024
				)
					throw new TrackerManagementError(
						"management.asset_invalid",
						"asset bytes exceed the bounded limit",
					);
				const root = path.resolve(options.assetRoot, projectId, ticketId);
				fs.mkdirSync(root, { recursive: true, mode: 0o700 });
				const target = path.resolve(root, relativePath);
				assertWithin(root, target);
				ensureSafeParent(root, target);
				if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink())
					throw new TrackerManagementError(
						"management.asset_invalid",
						"asset target cannot be a symbolic link",
					);
				const temporary = `${target}.tmp-${crypto.randomUUID()}`;
				fs.writeFileSync(temporary, input.bytes, { mode: 0o600 });
				fs.renameSync(temporary, target);
				const asset = options.storage.putAsset({
					id: `asset_${crypto.randomUUID()}`,
					projectId,
					ticketId,
					relativePath,
					mimeType: input.mimeType,
					byteSize: input.bytes.byteLength,
					sha256: crypto.createHash("sha256").update(input.bytes).digest("hex"),
					storagePath: target,
					now: now(options.clock),
				});
				return asset;
			},
			read(input) {
				const asset = options.storage.getAsset({
					id: id(input.assetId, "asset id"),
					projectId: ensureProject(input.projectId),
					ticketId: id(input.ticketId, "ticket id"),
				});
				if (!asset)
					throw new TrackerManagementError(
						"management.not_found",
						"asset is not authorized for this ticket",
					);
				const root = path.resolve(
					options.assetRoot,
					asset.projectId,
					asset.ticketId,
				);
				const target = path.resolve(root, asset.relativePath);
				assertWithin(root, target);
				if (!fs.existsSync(target) || fs.lstatSync(target).isSymbolicLink())
					throw new TrackerManagementError(
						"management.not_found",
						"asset is unavailable",
					);
				const bytes = fs.readFileSync(target);
				if (
					bytes.byteLength !== asset.byteSize ||
					crypto.createHash("sha256").update(bytes).digest("hex") !==
						asset.sha256
				)
					throw new TrackerManagementError(
						"management.not_found",
						"asset integrity check failed",
					);
				return { asset, bytes: new Uint8Array(bytes) };
			},
		},
		communications: {
			create(input) {
				return options.storage.createOperation({
					id: `op_${crypto.randomUUID()}`,
					projectId: ensureProject(input.projectId),
					...(input.sessionId === undefined
						? {}
						: { sessionId: id(input.sessionId, "session id") }),
					...(input.generationId === undefined
						? {}
						: { generationId: id(input.generationId, "generation id") }),
					kind: ensureOperationKind(input.kind),
					command: text(input.command, "command", 128),
					payload: payload(input.payload ?? {}, "communication payload"),
					actor: actor(input.actor),
					idempotencyKey: id(input.idempotencyKey, "idempotency key"),
					now: now(options.clock),
				});
			},
		},
		controls: {
			request(input) {
				return service.communications.create({ ...input, kind: "control" });
			},
			get(input) {
				const value = options.storage.getOperation(
					id(input.id, "operation id"),
					ensureProject(input.projectId),
				);
				if (!value)
					throw new TrackerManagementError(
						"management.not_found",
						"control request does not belong to project",
					);
				return value;
			},
			list(projectId) {
				return options.storage.listOperations(ensureProject(projectId));
			},
		},
		audit(projectId) {
			return options.storage.auditManagement(ensureProject(projectId));
		},
	};
	return Object.freeze(service);
}
