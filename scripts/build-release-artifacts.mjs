import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build, transform } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(root, "dist", "release");
const packageDocument = JSON.parse(
	fs.readFileSync(path.join(root, "package.json"), "utf8"),
);

const entries = [
	["golem-cli.mjs", "apps/cli/src/golem.ts", ["jsonc-parser"]],
	[
		"control-plane.mjs",
		"apps/control-plane/src/main.ts",
		[
			"@clack/prompts",
			"@fastify/static",
			"@fastify/swagger",
			"@fastify/websocket",
			"commander",
			"fastify",
			"fastify-type-provider-zod",
			"jsonc-parser",
			"kysely",
			"openapi-fetch",
			"zod",
		],
	],
	[
		"managed-codex-host.mjs",
		"apps/control-plane/src/managed-codex-host.ts",
		[],
	],
	[
		"migration-plan.mjs",
		"packages/compat/bin/migration-plan.mjs",
		["kysely", "zod"],
	],
	["legacy-dashboard.mjs", "dashboard/server/index.js", ["jsonc-parser"]],
];

fs.mkdirSync(outputDirectory, { recursive: true });

for (const [name, entry, dependencies] of entries) {
	const legacyAliases =
		name === "legacy-dashboard.mjs"
			? {
					"@fastify/static": "@fastify/static-legacy",
					"@fastify/websocket": "@fastify/websocket-legacy",
					fastify: "fastify-legacy",
				}
			: undefined;
	await build({
		entryPoints: [path.join(root, entry)],
		outfile: path.join(outputDirectory, name),
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node24",
		external: ["better-sqlite3", "fsevents", "node:*", ...dependencies],
		...(legacyAliases ? { alias: legacyAliases } : {}),
		legalComments: "none",
		logLevel: "warning",
	});
}

const piExtension = await transform(
	fs.readFileSync(path.join(root, "shims", "pi", "golem.ts"), "utf8"),
	{
		loader: "ts",
		format: "esm",
		target: "node24",
		legalComments: "none",
	},
);
fs.writeFileSync(
	path.join(outputDirectory, "pi-extension.mjs"),
	piExtension.code,
);

const sha256 = (file) =>
	crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const artifacts = Object.fromEntries(
	entries.map(([name]) => [name, sha256(path.join(outputDirectory, name))]),
);
artifacts["pi-extension.mjs"] = sha256(
	path.join(outputDirectory, "pi-extension.mjs"),
);
artifacts["golem-mcp.mjs"] = sha256(
	path.join(root, "packages", "mcp-adapter", "dist", "golem-mcp.mjs"),
);

fs.writeFileSync(
	path.join(outputDirectory, "manifest.json"),
	`${JSON.stringify(
		{
			schema: "golem.release/v1",
			package: packageDocument.name,
			version: packageDocument.version,
			node: ">=24.18.0",
			native: { "better-sqlite3": "12.11.1" },
			artifacts,
		},
		null,
		2,
	)}\n`,
);
