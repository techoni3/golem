import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const major = Number(process.versions.node.split(".")[0]);
if (major < 24) {
	throw new Error(`Golem requires Node 24 or newer; found ${process.version}`);
}

const manifest = JSON.parse(
	fs.readFileSync(path.join(root, "dist", "release", "manifest.json"), "utf8"),
);
const sourceCheckout = fs.existsSync(
	path.join(root, "apps", "control-plane", "src"),
);
if (!sourceCheckout) {
	for (const [name, expected] of Object.entries(manifest.artifacts)) {
		const file =
			name === "golem-mcp.mjs"
				? path.join(root, "packages", "mcp-adapter", "dist", name)
				: path.join(root, "dist", "release", name);
		const actual = crypto
			.createHash("sha256")
			.update(fs.readFileSync(file))
			.digest("hex");
		if (actual !== expected)
			throw new Error(`release artifact checksum mismatch: ${name}`);
	}
}

const require = createRequire(import.meta.url);
const sqlitePackage = require("better-sqlite3/package.json");
if (sqlitePackage.version !== manifest.native["better-sqlite3"]) {
	throw new Error(
		`better-sqlite3 ${manifest.native["better-sqlite3"]} required; found ${sqlitePackage.version}`,
	);
}
const Database = require("better-sqlite3");
const database = new Database(":memory:");
database.prepare("select 1 as ok").get();
database.close();

process.stdout.write(
	`golem ${manifest.version} validated for ${process.version} ${process.platform}/${process.arch}; ${sourceCheckout ? "release checksums deferred until build; " : ""}service remains stopped\n`,
);
