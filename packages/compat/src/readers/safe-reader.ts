import { createHash } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import type {
	AuditFinding,
	AuditSource,
	AuditSourceStatus,
	JsonRecord,
	LegacyReadResult,
} from "../plan/types.js";
import { redactedHomePath } from "../redact/redact.js";

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
	return relative.replaceAll(path.sep, "/").replace(/^\.\//u, "") || ".";
}

async function readRegularFile(
	target: string,
): Promise<{ readonly fingerprint: string; readonly bytes?: Uint8Array }> {
	const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new Error("audit.reader.not_regular");
		const digest = createHash("sha256");
		const chunks: Uint8Array[] = [];
		let size = 0;
		const buffer = new Uint8Array(65_536);
		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			const chunk = buffer.slice(0, bytesRead);
			digest.update(chunk);
			size += chunk.length;
			if (size <= maxJsonBytes) chunks.push(chunk);
			else chunks.length = 0;
		}
		const fingerprint = digest.digest("hex");
		if (size > maxJsonBytes) return { fingerprint };
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		return { bytes, fingerprint };
	} finally {
		await handle.close();
	}
}

async function fingerprintRegularFile(target: string): Promise<string> {
	const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new Error("audit.reader.not_regular");
		const digest = createHash("sha256");
		const buffer = new Uint8Array(65_536);
		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			digest.update(buffer.subarray(0, bytesRead));
		}
		return digest.digest("hex");
	} finally {
		await handle.close();
	}
}

async function sqliteMetadata(
	target: string,
): Promise<Readonly<Record<string, string | number | boolean>>> {
	const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const header = new Uint8Array(100);
		const { bytesRead } = await handle.read(header, 0, header.length, 0);
		const signature = new TextDecoder().decode(header.slice(0, 16));
		if (bytesRead < 100 || signature !== "SQLite format 3\u0000")
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

async function inspectFile(
	home: string,
	definition: KnownSource,
	sources: AuditSource[],
	documents: Record<string, JsonRecord>,
	findings: AuditFinding[],
): Promise<void> {
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
	if (stat.isSymbolicLink()) {
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
	if (!stat.isFile()) {
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
	if (definition.parse_json) {
		let content:
			| { readonly fingerprint: string; readonly bytes?: Uint8Array }
			| undefined;
		try {
			content = await readRegularFile(target);
			const metadata = {
				fingerprint: content.fingerprint,
				size_bytes: stat.size,
				mode: modeOf(stat.mode),
			};
			if (!content.bytes) throw new Error("audit.reader.too_large");
			const parsed = asRecord(
				JSON.parse(new TextDecoder().decode(content.bytes)),
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
			return;
		} catch (error) {
			const code = errnoCode(error);
			const status: AuditSourceStatus =
				code === "ELOOP"
					? "unsafe"
					: code === "EACCES" || code === "EPERM"
						? "unreadable"
						: "malformed";
			const metadata = {
				size_bytes: stat.size,
				mode: modeOf(stat.mode),
				...(content ? { fingerprint: content.fingerprint } : {}),
			};
			sources.push(
				source(
					definition.id,
					definition.relative,
					definition.category,
					status,
					metadata,
				),
			);
			findings.push(
				finding(
					status === "unsafe"
						? "audit.source.symlink"
						: status === "unreadable"
							? "audit.source.unreadable"
							: content && !content.bytes
								? "audit.source.too_large"
								: "audit.source.malformed",
					"error",
					definition.id,
					definition.relative,
				),
			);
			return;
		}
	}
	let fingerprint: string;
	try {
		fingerprint = await fingerprintRegularFile(target);
	} catch (error) {
		const status: AuditSourceStatus =
			errnoCode(error) === "ELOOP" ? "unsafe" : "unreadable";
		sources.push(
			source(definition.id, definition.relative, definition.category, status),
		);
		findings.push(
			finding(
				status === "unsafe"
					? "audit.source.symlink"
					: "audit.source.unreadable",
				"error",
				definition.id,
				definition.relative,
			),
		);
		return;
	}
	let details: Readonly<Record<string, string | number | boolean>> | undefined;
	if (definition.sqlite_metadata) {
		try {
			details = await sqliteMetadata(target);
		} catch (error) {
			const status: AuditSourceStatus =
				errnoCode(error) === "ELOOP" ? "unsafe" : "unreadable";
			sources.push(
				source(
					definition.id,
					definition.relative,
					definition.category,
					status,
					{
						fingerprint,
						size_bytes: stat.size,
						mode: modeOf(stat.mode),
					},
				),
			);
			findings.push(
				finding(
					status === "unsafe"
						? "audit.source.symlink"
						: "audit.source.unreadable",
					"error",
					definition.id,
					definition.relative,
				),
			);
			return;
		}
	}
	sources.push(
		source(definition.id, definition.relative, definition.category, "present", {
			fingerprint,
			size_bytes: stat.size,
			mode: modeOf(stat.mode),
			...(details ? { details } : {}),
		}),
	);
}

async function inspectDirectory(
	home: string,
	definition: KnownSource,
	sources: AuditSource[],
	findings: AuditFinding[],
): Promise<void> {
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
	sources.push(
		source(definition.id, definition.relative, definition.category, "present", {
			mode: modeOf(stat.mode),
		}),
	);
	let count = 0;
	const scan = async (absolute: string, relative: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await readdir(absolute, { withFileTypes: true });
		} catch {
			findings.push(
				finding(
					"audit.source.unreadable",
					"error",
					definition.id,
					path.join(definition.relative, relative),
				),
			);
			return;
		}
		for (const entry of entries.sort((left, right) =>
			left.name.localeCompare(right.name),
		)) {
			count += 1;
			const nestedRelative = path.join(relative, entry.name);
			const childRelative = path.join(definition.relative, nestedRelative);
			const childId = `${definition.id}/${relativeId(nestedRelative)}`;
			if (count > maxInventoryEntries) {
				findings.push(
					finding(
						"audit.source.entry_limit",
						"error",
						definition.id,
						definition.relative,
					),
				);
				return;
			}
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
				await scan(path.join(absolute, entry.name), nestedRelative);
				continue;
			}
			if (!entry.isFile()) {
				sources.push(
					source(childId, childRelative, definition.category, "unsafe"),
				);
				findings.push(
					finding("audit.source.not_regular", "error", childId, childRelative),
				);
				continue;
			}
			try {
				const childStat = await lstat(path.join(absolute, entry.name));
				const fingerprint = await fingerprintRegularFile(
					path.join(absolute, entry.name),
				);
				sources.push(
					source(childId, childRelative, definition.category, "present", {
						fingerprint,
						size_bytes: childStat.size,
						mode: modeOf(childStat.mode),
					}),
				);
			} catch {
				sources.push(
					source(childId, childRelative, definition.category, "unreadable"),
				);
				findings.push(
					finding("audit.source.unreadable", "error", childId, childRelative),
				);
			}
		}
	};
	await scan(target, "");
}

/** Read a supplied home only; every lookup is lstat/no-follow and never creates a lock, DB connection, or output file. */
export async function readLegacyHome(
	homeInput: string,
): Promise<LegacyReadResult> {
	const home = path.resolve(homeInput);
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
	for (const definition of knownSources) {
		if (definition.recursive)
			await inspectDirectory(home, definition, sources, findings);
		else await inspectFile(home, definition, sources, documents, findings);
	}
	return { sources, documents, findings };
}
