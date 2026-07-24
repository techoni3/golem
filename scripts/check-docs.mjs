import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const packageDocument = JSON.parse(read("package.json"));
const codegenPackage = JSON.parse(read("tools/openapi-codegen/package.json"));

assert.equal(packageDocument.engines.node, ">=24.18.0 <25");
assert.equal(packageDocument.packageManager, "npm@11.16.0");
assert.equal(packageDocument.devDependencies.typescript, "7.0.2");
assert.equal(codegenPackage.devDependencies.typescript, "5.9.3");
assert.equal(codegenPackage.devDependencies["openapi-typescript"], "7.13.0");
assert.equal(packageDocument.dependencies["better-sqlite3"], "12.11.1");
assert.equal(packageDocument.dependencies["openapi-fetch"], "0.17.0");
assert.ok(packageDocument.files.includes("dist/release/"));
assert.ok(!packageDocument.files.some((entry) => entry.startsWith("apps/")));
assert.ok(!packageDocument.files.some((entry) => entry.startsWith("tools/")));
assert.equal(
	packageDocument.scripts.postinstall,
	"node scripts/postinstall-validate.mjs",
);

const expectations = {
	"README.md": [
		"Node.js 24.18.x",
		"validation-only postinstall",
		"golem-mcp.mjs",
	],
	"CONTRIBUTING.md": [
		"npm 11.16.x",
		"TypeScript 7.0.2",
		"TypeScript 5.9.3",
		"npm run docs:check",
	],
	"REPO-MAP.md": [
		"GOL-59 packaged release boundary",
		"scripts/build-release-artifacts.mjs",
		"better-sqlite3` 12.11.1",
	],
	"cli/README.md": [
		"never starts a service",
		"npm install -g @laveesingh/golem@<previous-version>",
		"LaunchAgent install/status/start/stop/update/rollback",
	],
	"substrate/README.md": [
		"mcp/golem-mcp.mjs",
		"never starts a service",
		"without `NODE_PATH` or nested dependencies",
	],
	"docs/architecture/release-package.md": [
		"Postinstall is validation-only",
		"install-update-rollback",
		"Air-gapped native installation is unsupported",
	],
	"docs/contributing/development.md": [
		"npm run api:check",
		"Never hand-edit",
		"REPO-MAP.md",
	],
};

for (const [relative, needles] of Object.entries(expectations)) {
	const text = read(relative);
	for (const needle of needles)
		assert.ok(text.includes(needle), `${relative} must document: ${needle}`);
}

for (const relative of Object.keys(expectations)) {
	const text = read(relative);
	assert.doesNotMatch(
		text,
		/Node(?:\.js)? 20(?:\s|$)/u,
		`${relative} has stale Node 20 guidance`,
	);
	assert.doesNotMatch(
		text,
		/npm ci --prefix mcp\/channel/u,
		`${relative} has stale nested MCP install guidance`,
	);
}

process.stdout.write(
	`docs check PASS: ${Object.keys(expectations).length} documents, Node 24/npm 11, TS7+isolated TS5, release allowlist\n`,
);
