import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type {
	AuditFinding,
	AuditSource,
	AuditSourceStatus,
	JsonRecord,
	LegacyReadResult,
} from "../plan/types.js";
import { redactedHomePath, redactedRelativePath } from "../redact/redact.js";

interface KnownSource {
	readonly id: string;
	readonly relative: string;
	readonly category: AuditSource["category"];
	readonly parse_json?: boolean;
	readonly recursive?: boolean;
	readonly sqlite_metadata?: boolean;
}

const knownSources: readonly KnownSource[] = [
	{
		id: "projects",
		relative: "projects.json",
		category: "registry",
		parse_json: true,
	},
	{
		id: "sessions",
		relative: "sessions.json",
		category: "registry",
		parse_json: true,
	},
	{
		id: "facts",
		relative: "session-facts.json",
		category: "state",
		parse_json: true,
	},
	{
		id: "leases",
		relative: "endpoint-leases.json",
		category: "state",
		parse_json: true,
	},
	{
		id: "channels",
		relative: "channels.json",
		category: "state",
		parse_json: true,
	},
	{
		id: "opencode-bridges",
		relative: "opencode-bridges.json",
		category: "state",
		parse_json: true,
	},
	{
		id: "codex-supervisors",
		relative: "codex-supervisors.json",
		category: "state",
		parse_json: true,
	},
	{
		id: "dashboard",
		relative: "dashboard.json",
		category: "state",
		parse_json: true,
	},
	{
		id: "config",
		relative: "config.json",
		category: "config",
		parse_json: true,
	},
	{
		id: "substrate-lock",
		relative: "substrate.lock",
		category: "render",
		parse_json: true,
	},
	{
		id: "tracker",
		relative: "tracker.db",
		category: "database",
		sqlite_metadata: true,
	},
	{ id: "tracker-wal", relative: "tracker.db-wal", category: "database" },
	{ id: "tracker-shm", relative: "tracker.db-shm", category: "database" },
	{
		id: "journals",
		relative: "journals",
		category: "history",
		recursive: true,
	},
	{ id: "spool", relative: "spool", category: "history", recursive: true },
	{ id: "gates", relative: "gates", category: "history", recursive: true },
	{ id: "ideas", relative: "ideas", category: "history", recursive: true },
	{ id: "roles", relative: "roles", category: "history", recursive: true },
	{ id: "renders", relative: "renders", category: "render", recursive: true },
];

const maxJsonBytes = 1_048_576;
const maxInventoryEntries = 5_000;

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function modeOf(mode: number): string {
	return `0${(mode & 0o777).toString(8)}`;
}

function source(
	id: string,
	relative: string,
	category: AuditSource["category"],
	status: AuditSourceStatus,
	properties: Partial<
		Pick<AuditSource, "fingerprint" | "size_bytes" | "mode" | "details">
	> = {},
): AuditSource {
	return {
		id,
		path: redactedHomePath(relative),
		category,
		status,
		...properties,
	};
}

function finding(
	code: string,
	severity: AuditFinding["severity"],
	sourceId: string,
	relative: string,
): AuditFinding {
	return {
		code,
		severity,
		source_id: sourceId,
		path: redactedHomePath(relative),
	};
}

function relativeId(relative: string): string {
	return redactedRelativePath(relative) || ".";
}

class AuditReaderError extends Error {
	readonly code: "AUDIT_PATH_ESCAPE" | "AUDIT_PATH_SYMLINK";

	constructor(code: AuditReaderError["code"]) {
		super(code);
		this.code = code;
	}
}

interface FileSnapshot {
	readonly stat: Stats;
	readonly fingerprint: string;
	readonly bytes?: Uint8Array;
	readonly sqlite_details?: Readonly<Record<string, string | number | boolean>>;
	readonly changed: boolean;
}

function sameObject(left: Stats, right: Stats): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs &&
		left.mode === right.mode
	);
}

function contained(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) &&
			relative !== ".." &&
			!path.isAbsolute(relative))
	);
}

async function assertContainedPath(
	home: string,
	target: string,
): Promise<void> {
	if (!contained(home, target)) throw new AuditReaderError("AUDIT_PATH_ESCAPE");
	const relative = path.relative(home, target);
	let current = home;
	for (const segment of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		const stat = await lstat(current);
		if (stat.isSymbolicLink()) throw new AuditReaderError("AUDIT_PATH_SYMLINK");
	}
	const resolved = await realpath(target);
	if (!contained(home, resolved))
		throw new AuditReaderError("AUDIT_PATH_ESCAPE");
}

function sqliteDetails(
	header: Uint8Array,
	headerBytes: number,
): Readonly<Record<string, string | number | boolean>> {
	const signature = new TextDecoder().decode(header.slice(0, 16));
	if (headerBytes < 100 || signature !== "SQLite format 3\u0000")
		return { format: "unrecognized" };
	const pageSize = (header[16] ?? 0) * 256 + (header[17] ?? 0);
	const schemaFormat =
		((header[44] ?? 0) << 24) |
		((header[45] ?? 0) << 16) |
		((header[46] ?? 0) << 8) |
		(header[47] ?? 0);
	const userVersion =
		((header[60] ?? 0) << 24) |
		((header[61] ?? 0) << 16) |
		((header[62] ?? 0) << 8) |
		(header[63] ?? 0);
	return {
		format: "sqlite",
		page_size: pageSize === 1 ? 65_536 : pageSize,
		schema_format: schemaFormat >>> 0,
		user_version: userVersion >>> 0,
	};
}

async function snapshotRegularFile(input: {
	readonly home: string;
	readonly target: string;
	readonly expected: Stats;
	readonly captureBytes: boolean;
	readonly readSqliteHeader: boolean;
}): Promise<FileSnapshot> {
	await assertContainedPath(input.home, input.target);
	const handle = await open(
		input.target,
		constants.O_RDONLY | constants.O_NOFOLLOW,
	);
	try {
		const before = await handle.stat();
		if (!before.isFile()) throw new Error("audit.reader.not_regular");
		const digest = createHash("sha256");
		const chunks: Uint8Array[] = [];
		const header = new Uint8Array(100);
		let headerBytes = 0;
		let size = 0;
		const buffer = new Uint8Array(65_536);
		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			const chunk = buffer.slice(0, bytesRead);
			digest.update(chunk);
			if (input.readSqliteHeader && headerBytes < header.length) {
				const count = Math.min(header.length - headerBytes, chunk.length);
				header.set(chunk.subarray(0, count), headerBytes);
				headerBytes += count;
			}
			size += chunk.length;
			if (input.captureBytes && size <= maxJsonBytes) chunks.push(chunk);
			else chunks.length = 0;
		}
		const after = await handle.stat();
		let pathMatches = false;
		try {
			await assertContainedPath(input.home, input.target);
			pathMatches = sameObject(before, await lstat(input.target));
		} catch (error) {
			if (error instanceof AuditReaderError) throw error;
			pathMatches = false;
		}
		const changed =
			!sameObject(input.expected, before) ||
			!sameObject(before, after) ||
			!pathMatches;
		const fingerprint = digest.digest("hex");
		if (changed)
			return Object.freeze({ stat: before, fingerprint, changed: true });
		let bytes: Uint8Array | undefined;
		if (input.captureBytes && size <= maxJsonBytes) {
			bytes = new Uint8Array(size);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.length;
			}
		}
		return Object.freeze({
			stat: before,
			fingerprint,
			...(bytes ? { bytes } : {}),
			...(input.readSqliteHeader
				? { sqlite_details: sqliteDetails(header, headerBytes) }
				: {}),
			changed: false,
		});
	} finally {
		await handle.close();
	}
}

function errnoCode(error: unknown): string | undefined {
	return typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
		? error.code
		: undefined;
}

function asRecord(value: unknown): JsonRecord | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: undefined;
}

function sourceStatusFor(error: unknown): AuditSourceStatus {
	const code = errnoCode(error);
	return code === "ELOOP" ||
		code === "AUDIT_PATH_ESCAPE" ||
		code === "AUDIT_PATH_SYMLINK"
		? "unsafe"
		: code === "EACCES" || code === "EPERM"
			? "unreadable"
			: "malformed";
}

function sourceFindingFor(error: unknown, content?: FileSnapshot): string {
	const code = errnoCode(error);
	if (code === "AUDIT_PATH_ESCAPE") return "audit.source.path_escape";
	if (code === "ELOOP" || code === "AUDIT_PATH_SYMLINK")
		return "audit.source.symlink";
	if (code === "EACCES" || code === "EPERM") return "audit.source.unreadable";
	return content && !content.bytes
		? "audit.source.too_large"
		: "audit.source.malformed";
}

async function inspectFile(
	home: string,
	definition: KnownSource,
	sources: AuditSource[],
	documents: Record<string, JsonRecord>,
	findings: AuditFinding[],
): Promise<void> {
	const target = path.join(home, definition.relative);
	let initial: Stats;
	try {
		initial = await lstat(target);
	} catch (error) {
		if (errnoCode(error) === "ENOENT") {
			sources.push(
				source(
					definition.id,
					definition.relative,
					definition.category,
					"missing",
				),
			);
			return;
		}
		sources.push(
			source(
				definition.id,
				definition.relative,
				definition.category,
				"unreadable",
			),
		);
		findings.push(
			finding(
				"audit.source.unreadable",
				"error",
				definition.id,
				definition.relative,
			),
		);
		return;
	}
	if (initial.isSymbolicLink()) {
		sources.push(
			source(
				definition.id,
				definition.relative,
				definition.category,
				"unsafe",
				{ fingerprint: sha256("symlink") },
			),
		);
		findings.push(
			finding(
				"audit.source.symlink",
				"error",
				definition.id,
				definition.relative,
			),
		);
		return;
	}
	if (!initial.isFile()) {
		sources.push(
			source(definition.id, definition.relative, definition.category, "unsafe"),
		);
		findings.push(
			finding(
				"audit.source.not_regular",
				"error",
				definition.id,
				definition.relative,
			),
		);
		return;
	}
	let snapshot: FileSnapshot;
	try {
		snapshot = await snapshotRegularFile({
			home,
			target,
			expected: initial,
			captureBytes: definition.parse_json === true,
			readSqliteHeader: definition.sqlite_metadata === true,
		});
	} catch (error) {
		const status = sourceStatusFor(error);
		sources.push(
			source(definition.id, definition.relative, definition.category, status),
		);
		findings.push(
			finding(
				sourceFindingFor(error),
				"error",
				definition.id,
				definition.relative,
			),
		);
		return;
	}
	if (snapshot.changed) {
		sources.push(
			source(
				definition.id,
				definition.relative,
				definition.category,
				"changed",
			),
		);
		findings.push(
			finding(
				"audit.source.changed_during_audit",
				"error",
				definition.id,
				definition.relative,
			),
		);
		return;
	}
	const metadata = {
		fingerprint: snapshot.fingerprint,
		size_bytes: snapshot.stat.size,
		mode: modeOf(snapshot.stat.mode),
		...(snapshot.sqlite_details ? { details: snapshot.sqlite_details } : {}),
	};
	if (!definition.parse_json) {
		sources.push(
			source(
				definition.id,
				definition.relative,
				definition.category,
				"present",
				metadata,
			),
		);
		return;
	}
	try {
		if (!snapshot.bytes) throw new Error("audit.reader.too_large");
		const parsed = asRecord(
			JSON.parse(new TextDecoder().decode(snapshot.bytes)),
		);
		if (!parsed) throw new Error("audit.reader.json_object_required");
		sources.push(
			source(
				definition.id,
				definition.relative,
				definition.category,
				"present",
				metadata,
			),
		);
		documents[definition.id] = parsed;
	} catch (error) {
		sources.push(
			source(
				definition.id,
				definition.relative,
				definition.category,
				"malformed",
				metadata,
			),
		);
		findings.push(
			finding(
				sourceFindingFor(error, snapshot),
				"error",
				definition.id,
				definition.relative,
			),
		);
	}
}

interface InventoryBudget {
	entries: number;
	halted: boolean;
	limitReported: boolean;
}

function recordInventoryLimit(
	budget: InventoryBudget,
	definition: KnownSource,
	findings: AuditFinding[],
): void {
	budget.halted = true;
	if (budget.limitReported) return;
	budget.limitReported = true;
	findings.push(
		finding(
			"audit.source.entry_limit",
			"error",
			definition.id,
			definition.relative,
		),
	);
}

async function inspectDirectory(
	home: string,
	definition: KnownSource,
	sources: AuditSource[],
	findings: AuditFinding[],
	budget: InventoryBudget,
): Promise<void> {
	if (budget.halted) return;
	const target = path.join(home, definition.relative);
	let stat: Stats;
	try {
		stat = await lstat(target);
	} catch (error) {
		if (errnoCode(error) === "ENOENT") {
			sources.push(
				source(
					definition.id,
					definition.relative,
					definition.category,
					"missing",
				),
			);
			return;
		}
		sources.push(
			source(
				definition.id,
				definition.relative,
				definition.category,
				"unreadable",
			),
		);
		findings.push(
			finding(
				"audit.source.unreadable",
				"error",
				definition.id,
				definition.relative,
			),
		);
		return;
	}
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		sources.push(
			source(definition.id, definition.relative, definition.category, "unsafe"),
		);
		findings.push(
			finding(
				stat.isSymbolicLink()
					? "audit.source.symlink"
					: "audit.source.not_directory",
				"error",
				definition.id,
				definition.relative,
			),
		);
		return;
	}
	try {
		await assertContainedPath(home, target);
	} catch (error) {
		sources.push(
			source(
				definition.id,
				definition.relative,
				definition.category,
				sourceStatusFor(error),
			),
		);
		findings.push(
			finding(
				sourceFindingFor(error),
				"error",
				definition.id,
				definition.relative,
			),
		);
		return;
	}
	const rootSourceIndex = sources.length;
	sources.push(
		source(definition.id, definition.relative, definition.category, "present", {
			mode: modeOf(stat.mode),
		}),
	);
	const scan = async (absolute: string, relative: string): Promise<boolean> => {
		if (budget.halted) return true;
		try {
			await assertContainedPath(home, absolute);
			const entries = await readdir(absolute, { withFileTypes: true });
			// A directory can be atomically replaced after enumeration. Re-resolve it
			// before trusting any child Dirent and again for each nested descent.
			await assertContainedPath(home, absolute);
			for (const entry of entries.sort((left, right) =>
				left.name.localeCompare(right.name),
			)) {
				if (budget.halted) return true;
				if (budget.entries >= maxInventoryEntries) {
					recordInventoryLimit(budget, definition, findings);
					return true;
				}
				budget.entries += 1;
				const nestedRelative = path.join(relative, entry.name);
				const childRelative = path.join(definition.relative, nestedRelative);
				const childId = `${definition.id}/${relativeId(nestedRelative)}`;
				const childAbsolute = path.join(absolute, entry.name);
				if (entry.isSymbolicLink()) {
					sources.push(
						source(childId, childRelative, definition.category, "unsafe", {
							fingerprint: sha256("symlink"),
						}),
					);
					findings.push(
						finding("audit.source.symlink", "error", childId, childRelative),
					);
					continue;
				}
				if (entry.isDirectory()) {
					if (!(await scan(childAbsolute, nestedRelative))) return false;
					continue;
				}
				let initial: Stats;
				try {
					initial = await lstat(childAbsolute);
				} catch (error) {
					sources.push(
						source(
							childId,
							childRelative,
							definition.category,
							sourceStatusFor(error),
						),
					);
					findings.push(
						finding(sourceFindingFor(error), "error", childId, childRelative),
					);
					continue;
				}
				if (initial.isSymbolicLink()) {
					sources.push(
						source(childId, childRelative, definition.category, "unsafe", {
							fingerprint: sha256("symlink"),
						}),
					);
					findings.push(
						finding("audit.source.symlink", "error", childId, childRelative),
					);
					continue;
				}
				if (!initial.isFile()) {
					sources.push(
						source(childId, childRelative, definition.category, "unsafe"),
					);
					findings.push(
						finding(
							"audit.source.not_regular",
							"error",
							childId,
							childRelative,
						),
					);
					continue;
				}
				try {
					const snapshot = await snapshotRegularFile({
						home,
						target: childAbsolute,
						expected: initial,
						captureBytes: false,
						readSqliteHeader: false,
					});
					if (snapshot.changed) {
						sources.push(
							source(childId, childRelative, definition.category, "changed"),
						);
						findings.push(
							finding(
								"audit.source.changed_during_audit",
								"error",
								childId,
								childRelative,
							),
						);
						continue;
					}
					sources.push(
						source(childId, childRelative, definition.category, "present", {
							fingerprint: snapshot.fingerprint,
							size_bytes: snapshot.stat.size,
							mode: modeOf(snapshot.stat.mode),
						}),
					);
				} catch (error) {
					sources.push(
						source(
							childId,
							childRelative,
							definition.category,
							sourceStatusFor(error),
						),
					);
					findings.push(
						finding(sourceFindingFor(error), "error", childId, childRelative),
					);
					if (error instanceof AuditReaderError) return false;
				}
			}
			return true;
		} catch (error) {
			findings.push(
				finding(
					sourceFindingFor(error),
					"error",
					definition.id,
					path.join(definition.relative, relative),
				),
			);
			return false;
		}
	};
	if (!(await scan(target, ""))) {
		sources[rootSourceIndex] = source(
			definition.id,
			definition.relative,
			definition.category,
			"unsafe",
			{ mode: modeOf(stat.mode) },
		);
	}
}

/** Read a supplied home only; every lookup is lstat/no-follow and never creates a lock, DB connection, or output file. */
export async function readLegacyHome(
	homeInput: string,
): Promise<LegacyReadResult> {
	let home = path.resolve(homeInput);
	const sources: AuditSource[] = [];
	const documents: Record<string, JsonRecord> = {};
	const findings: AuditFinding[] = [];
	try {
		const root = await lstat(home);
		if (root.isSymbolicLink() || !root.isDirectory()) {
			sources.push(source("home", ".", "state", "unsafe"));
			findings.push(
				finding(
					root.isSymbolicLink()
						? "audit.home.symlink"
						: "audit.home.not_directory",
					"error",
					"home",
					".",
				),
			);
			return { sources, documents, findings };
		}
		home = await realpath(home);
	} catch (error) {
		sources.push(
			source(
				"home",
				".",
				"state",
				errnoCode(error) === "ENOENT" ? "missing" : "unreadable",
			),
		);
		findings.push(finding("audit.home.unavailable", "error", "home", "."));
		return { sources, documents, findings };
	}
	const budget: InventoryBudget = {
		entries: 0,
		halted: false,
		limitReported: false,
	};
	for (const definition of knownSources) {
		if (definition.recursive)
			await inspectDirectory(home, definition, sources, findings, budget);
		else await inspectFile(home, definition, sources, documents, findings);
	}
	return { sources, documents, findings };
}
