import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const expectedWorkspaceNames = new Set([
	"@golem/adapter-claude",
	"@golem/adapter-codex",
	"@golem/adapter-opencode",
	"@golem/adapter-pi",
	"@golem/adapter-sdk",
	"@golem/api-client",
	"@golem/cli",
	"@golem/compat",
	"@golem/compiler",
	"@golem/contracts",
	"@golem/control-plane",
	"@golem/dashboard",
	"@golem/domain",
	"@golem/launcher",
	"@golem/mcp-adapter",
	"@golem/openapi-codegen",
	"@golem/persistence",
	"@golem/runtime",
	"@golem/testkit",
	"@golem/tracker",
	"@golem/ui",
]);

class BoundaryError extends Error {
	constructor(rule, owner, specifier, source) {
		super(`${rule}: ${owner} must not import ${specifier} (${source})`);
		this.rule = rule;
	}
}

async function exists(path) {
	try {
		await readFile(path);
		return true;
	} catch {
		return false;
	}
}

async function workspaceDirectories(root) {
	const directories = [];
	for (const prefix of ["apps", "packages", "tools"]) {
		const prefixRoot = join(root, prefix);
		for (const entry of await readdir(prefixRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const candidate = join(prefixRoot, entry.name);
			if (await exists(join(candidate, "package.json"))) {
				directories.push(candidate);
				continue;
			}
			for (const child of await readdir(candidate, { withFileTypes: true })) {
				if (
					child.isDirectory() &&
					(await exists(join(candidate, child.name, "package.json")))
				) {
					directories.push(join(candidate, child.name));
				}
			}
		}
	}
	return directories.sort();
}

async function sourceFiles(directory) {
	const files = [];
	const sourceRoot = join(directory, "src");
	if (!(await exists(join(directory, "package.json")))) return files;
	const isSourceFile = (name) => /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(name);
	async function visit(current) {
		for (const entry of await readdir(current, { withFileTypes: true })) {
			const target = join(current, entry.name);
			if (entry.isDirectory()) await visit(target);
			else if (isSourceFile(entry.name)) files.push(target);
		}
	}
	try {
		await visit(sourceRoot);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (entry.isFile() && isSourceFile(entry.name))
			files.push(join(directory, entry.name));
	}
	return files.sort();
}

function imports(source) {
	const matches = [];
	const matcher =
		/(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/gu;
	for (const match of source.matchAll(matcher)) matches.push(match[1]);
	return matches;
}

function workspacePackageSpecifier(specifier) {
	if (!specifier.startsWith("@golem/")) return specifier;
	const [scope, name] = specifier.split("/");
	return name ? `${scope}/${name}` : specifier;
}

function isAdapter(name) {
	return name.startsWith("@golem/adapter-") && name !== "@golem/adapter-sdk";
}

function isClient(name) {
	return new Set([
		"@golem/api-client",
		"@golem/cli",
		"@golem/dashboard",
		"@golem/mcp-adapter",
		"@golem/ui",
	]).has(name);
}

function forbiddenRule(owner, specifier) {
	const packageSpecifier = workspacePackageSpecifier(specifier);
	if (
		packageSpecifier === "@golem/control-plane" &&
		owner !== "@golem/control-plane"
	) {
		return "control-plane-composition-only";
	}
	if (
		specifier === "@golem/persistence/control-plane" &&
		owner !== "@golem/control-plane"
	) {
		return "persistence-writer-constructor";
	}
	if (
		specifier === "@golem/persistence/migration-compat" &&
		owner !== "@golem/compat"
	) {
		return "persistence-migration-composition-only";
	}
	if (
		owner !== "@golem/openapi-codegen" &&
		/(?:^|\/)tools(?:\/|$)/u.test(specifier)
	) {
		return "application-to-tool";
	}
	if (
		owner === "@golem/openapi-codegen" &&
		/(?:^|\/)(?:apps|packages)(?:\/|$)/u.test(specifier)
	) {
		return "tool-to-application";
	}
	if (owner === "@golem/domain") {
		if (
			packageSpecifier === "@golem/persistence" ||
			specifier === "better-sqlite3" ||
			specifier === "kysely"
		) {
			return "domain-to-persistence";
		}
		if (specifier === "fastify" || specifier.startsWith("@fastify/"))
			return "domain-to-fastify";
		if (specifier === "react" || specifier.startsWith("react/"))
			return "domain-to-react";
		if (
			packageSpecifier === "@golem/adapter-sdk" ||
			isAdapter(packageSpecifier)
		)
			return "domain-to-adapter";
	}
	if (
		isAdapter(owner) &&
		(packageSpecifier === "@golem/persistence" ||
			specifier === "better-sqlite3" ||
			specifier === "kysely")
	) {
		return "adapter-to-database";
	}
	if (
		isClient(owner) &&
		(packageSpecifier === "@golem/persistence" ||
			specifier === "better-sqlite3" ||
			specifier === "kysely")
	) {
		return "client-to-repository";
	}
	if (
		owner === "@golem/mcp-adapter" &&
		(packageSpecifier === "@golem/domain" ||
			packageSpecifier === "@golem/runtime" ||
			packageSpecifier === "@golem/tracker" ||
			packageSpecifier === "@golem/compat" ||
			isAdapter(packageSpecifier))
	) {
		return "mcp-adapter-to-domain";
	}
	if (owner !== "@golem/compat" && packageSpecifier === "@golem/compat")
		return "canonical-to-compat";
	if (
		owner !== "@golem/openapi-codegen" &&
		packageSpecifier === "@golem/openapi-codegen"
	)
		return "application-to-tool";
	if (
		owner === "@golem/openapi-codegen" &&
		packageSpecifier.startsWith("@golem/")
	)
		return "tool-to-application";
	return null;
}

function assertImportBoundary(owner, specifier, source) {
	const rule = forbiddenRule(owner, specifier);
	if (rule) throw new BoundaryError(rule, owner, specifier, source);
}

function packageDependencies(manifest) {
	return {
		...manifest.dependencies,
		...manifest.devDependencies,
		...manifest.optionalDependencies,
		...manifest.peerDependencies,
	};
}

function assertManifestBoundaries(manifest, source) {
	const dependencies = packageDependencies(manifest);
	for (const specifier of Object.keys(dependencies))
		assertImportBoundary(manifest.name, specifier, source);
	return dependencies;
}

async function loadWorkspace(directory) {
	const manifest = JSON.parse(
		await readFile(join(directory, "package.json"), "utf8"),
	);
	const files = await sourceFiles(directory);
	const sources = await Promise.all(
		files.map(async (file) => ({
			file,
			contents: await readFile(file, "utf8"),
		})),
	);
	return { directory, manifest, sources };
}

async function validateGraph(root) {
	const workspaces = await Promise.all(
		(await workspaceDirectories(root)).map(loadWorkspace),
	);
	const discoveredNames = new Set(
		workspaces.map(({ manifest }) => manifest.name),
	);
	const missing = [...expectedWorkspaceNames].filter(
		(name) => !discoveredNames.has(name),
	);
	const unexpected = [...discoveredNames].filter(
		(name) => !expectedWorkspaceNames.has(name),
	);
	if (missing.length || unexpected.length) {
		throw new Error(
			`workspace map mismatch: missing=${missing.join(",") || "none"} unexpected=${unexpected.join(",") || "none"}`,
		);
	}

	for (const { directory, manifest, sources } of workspaces) {
		if (!manifest.private || manifest.type !== "module") {
			throw new Error(
				`${relative(root, directory)} must be private native ESM`,
			);
		}
		const dependencies = assertManifestBoundaries(
			manifest,
			`${relative(root, directory)}/package.json`,
		);
		for (const source of sources) {
			for (const specifier of imports(source.contents)) {
				assertImportBoundary(
					manifest.name,
					specifier,
					relative(root, source.file),
				);
				const workspaceSpecifier = workspacePackageSpecifier(specifier);
				if (
					workspaceSpecifier.startsWith("@golem/") &&
					!dependencies[workspaceSpecifier]
				) {
					throw new Error(
						`${manifest.name} imports ${specifier} without declaring it in package metadata`,
					);
				}
			}
		}
	}
	return workspaces;
}

async function validateTopology(root) {
	const manifest = JSON.parse(
		await readFile(join(root, "package.json"), "utf8"),
	);
	const lock = JSON.parse(
		await readFile(join(root, "package-lock.json"), "utf8"),
	);
	const workspaces = manifest.workspaces?.join(",");
	if (workspaces !== "apps/*,packages/*,packages/adapters/*,tools/*") {
		throw new Error(
			"root workspace globs do not describe the canonical package map",
		);
	}
	if (
		manifest.packageManager !== "npm@11.16.0" ||
		manifest.devDependencies?.typescript !== "7.0.2"
	) {
		throw new Error("root TypeScript 7/npm 11 compiler contract is not pinned");
	}
	const codegen = lock.packages?.["tools/openapi-codegen"];
	const codegenTypescript =
		lock.packages?.["tools/openapi-codegen/node_modules/typescript"];
	const codegenGenerator =
		lock.packages?.["tools/openapi-codegen/node_modules/openapi-typescript"];
	if (
		codegen?.devDependencies?.typescript !== "5.9.3" ||
		codegen?.devDependencies?.["openapi-typescript"] !== "7.13.0" ||
		codegenTypescript?.version !== "5.9.3" ||
		codegenGenerator?.version !== "7.13.0"
	) {
		throw new Error(
			"OpenAPI codegen TypeScript 5 dependency boundary is not locked",
		);
	}
	const apiClient = lock.packages?.["packages/api-client"];
	if (apiClient?.dependencies?.["openapi-fetch"] !== "0.17.0") {
		throw new Error("api-client must own openapi-fetch 0.17.0 at runtime");
	}
	const additionalLocks = [];
	for (const directory of ["apps", "packages", "tools"]) {
		async function visit(current) {
			for (const entry of await readdir(current, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				const target = join(current, entry.name);
				if (entry.name === "node_modules") continue;
				if (entry.name === "dist") continue;
				if (await exists(join(target, "package-lock.json")))
					additionalLocks.push(
						relative(root, join(target, "package-lock.json")),
					);
				await visit(target);
			}
		}
		await visit(join(root, directory));
	}
	if (additionalLocks.length)
		throw new Error(
			`workspace paths must not own a second lock: ${additionalLocks.join(",")}`,
		);
}

async function validateFixtures(root) {
	const fixtureRoot = join(root, "test", "fixtures", "workspace-boundaries");
	const results = [];
	for (const entry of await readdir(fixtureRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const fixture = join(fixtureRoot, entry.name);
		const manifest = JSON.parse(
			await readFile(join(fixture, "package.json"), "utf8"),
		);
		const dependencies = packageDependencies(manifest);
		const sources = await Promise.all(
			(await sourceFiles(fixture)).map(async (file) => ({
				file,
				contents: await readFile(file, "utf8"),
			})),
		);
		let observed;
		try {
			for (const specifier of Object.keys(dependencies))
				assertImportBoundary(
					manifest.name,
					specifier,
					`${entry.name}/package.json`,
				);
			for (const source of sources) {
				for (const specifier of imports(source.contents))
					assertImportBoundary(manifest.name, specifier, entry.name);
			}
		} catch (error) {
			if (error instanceof BoundaryError) observed = error.rule;
			else throw error;
		}
		if (observed !== manifest.expectedBoundaryRule) {
			throw new Error(
				`${entry.name} expected ${manifest.expectedBoundaryRule}, observed ${observed ?? "no rejection"}`,
			);
		}
		results.push(entry.name);
	}
	return results.sort();
}

async function validateLegacyClientEntrypoints(root) {
	const roots = [join(root, "cli"), join(root, "mcp", "channel")];
	const forbidden = new Set([
		"@golem/persistence",
		"@golem/persistence/control-plane",
		"better-sqlite3",
		"kysely",
	]);
	const files = [];
	for (const entryRoot of roots) {
		async function visit(current) {
			for (const entry of await readdir(current, { withFileTypes: true })) {
				if (entry.name === "node_modules" || entry.name === "dist") continue;
				const target = join(current, entry.name);
				if (entry.isDirectory()) await visit(target);
				else if (/\.(?:[cm]?[jt]s|[jt]sx)$/u.test(entry.name))
					files.push(target);
			}
		}
		await visit(entryRoot);
	}
	for (const file of files) {
		const source = await readFile(file, "utf8");
		const specifiers = [
			...imports(source),
			...Array.from(
				source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/gu),
				(match) => match[1],
			),
		];
		for (const specifier of specifiers) {
			if (
				forbidden.has(specifier) ||
				specifier.includes("packages/persistence/src")
			)
				throw new Error(
					`legacy CLI/MCP entrypoint must not import a tracker repository: ${relative(root, file)} -> ${specifier}`,
				);
		}
	}
	return files.length;
}

await validateTopology(repositoryRoot);
const graph = await validateGraph(repositoryRoot);
const fixtures = await validateFixtures(repositoryRoot);
const legacyClientFiles = await validateLegacyClientEntrypoints(repositoryRoot);
process.stdout.write(
	`boundary check passed: ${graph.length} workspaces, ${fixtures.length} rejection fixtures, ${legacyClientFiles} legacy client sources\n`,
);
