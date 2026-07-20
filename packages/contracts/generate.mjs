import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	ContractSchemaRegistry,
	compatibilityFixtures,
	jsonSchemaDocument,
	schemaManifest,
	stableJson,
} from "./dist/registry.js";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const outputRoot = join(packageRoot, "generated", "json-schema");
const checkOnly = process.argv.includes("--check");
const outputFiles = new Map(
	ContractSchemaRegistry.map((entry) => [
		entry.fileName,
		stableJson(jsonSchemaDocument(entry)),
	]),
);
outputFiles.set("index.json", stableJson(schemaManifest()));
outputFiles.set(
	"compatibility-fixtures.json",
	stableJson(compatibilityFixtures()),
);

async function actualContents(file) {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

async function generatedFileNames() {
	try {
		return (await readdir(outputRoot)).filter((name) => name.endsWith(".json"));
	} catch (error) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}
}

const changed = [];
for (const [name, expected] of outputFiles) {
	const actual = await actualContents(join(outputRoot, name));
	if (actual !== expected) changed.push(name);
}
const unexpected = (await generatedFileNames()).filter(
	(name) => !outputFiles.has(name),
);

if (checkOnly) {
	if (changed.length || unexpected.length) {
		throw new Error(
			`contract schema output drift: changed=${changed.join(",") || "none"} unexpected=${unexpected.join(",") || "none"}`,
		);
	}
	process.stdout.write(
		`contract schema check passed: ${ContractSchemaRegistry.length} schemas, ${outputFiles.size} generated files\n`,
	);
	process.exit(0);
}

await mkdir(outputRoot, { recursive: true });
for (const [name, contents] of outputFiles) {
	const destination = join(outputRoot, name);
	await mkdir(dirname(destination), { recursive: true });
	await writeFile(destination, contents, "utf8");
}
if (unexpected.length) {
	throw new Error(
		`unexpected generated schema files require explicit review: ${unexpected.join(",")}`,
	);
}
process.stdout.write(
	`contract schemas generated: ${ContractSchemaRegistry.length} schemas, ${outputFiles.size} files\n`,
);
