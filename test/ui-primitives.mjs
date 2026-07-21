import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";

import { acquireChrome } from "../dashboard/scripts/_chrome.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
// `@golem/dashboard`'s vite config (`apps/dashboard/vite.config.ts`) emits the
// typed control-plane shell under `dashboard/dist/control-plane` — not under
// `apps/dashboard/dist/assets`. Serving any other path makes the runner either
// 404 before the design lab mounts or pass from stale files left by a previous
// build. Keep this in sync with the vite `build.outDir`.
const dashboardOutput = join(root, "dashboard", "dist", "control-plane");
const fixtureRoot = join(root, "test", "fixtures", "ui-primitives");
const mimeTypes = {
	".css": "text/css",
	".html": "text/html",
	".js": "text/javascript",
	".map": "application/json",
};

async function pathExists(candidate) {
	try {
		await access(candidate);
		return true;
	} catch {
		return false;
	}
}

async function assertBuiltArtifact(output, label) {
	const indexPath = join(output, "index.html");
	const assetsPath = join(output, "assets");
	assert.ok(
		await pathExists(indexPath),
		`${label} is missing at ${indexPath}; run "npm run build -w @golem/dashboard" and confirm "apps/dashboard/vite.config.ts" still emits to dashboard/dist/control-plane`,
	);
	const assetsStat = await stat(assetsPath).catch(() => undefined);
	assert.ok(
		assetsStat?.isDirectory(),
		`built dashboard assets directory is missing at ${assetsPath}; the vite outDir must emit index.html and assets/`,
	);
	const indexHtml = await readFile(indexPath, "utf8");
	// The built index.html references its entry chunk via a hashed module
	// script. Proving the referenced asset exists on disk proves the runner
	// is serving the current build, not a stale sibling directory.
	const entryMatch = indexHtml.match(/<script[^>]*src="([^"]+\.js)"/u);
	assert.ok(entryMatch, `built index.html must reference a module entry script; got:\n${indexHtml}`);
	const entryHref = entryMatch[1];
	assert.ok(
		entryHref.startsWith("/assets/"),
		`built entry script must live under /assets/; got ${entryHref}`,
	);
	const entryDiskPath = join(output, entryHref.slice(1));
	assert.ok(
		await pathExists(entryDiskPath),
		`built entry script ${entryHref} is referenced by index.html but missing on disk at ${entryDiskPath}`,
	);
	return { indexPath, output };
}

let labArtifactRoot;
let labOutput;

// The product shell deliberately has no design-lab runtime route. Build the
// lab from its real source into a disposable test artifact instead of changing
// dashboard routing or legacy stylesheet behavior merely to reach this test.
before(async () => {
	await assertBuiltArtifact(dashboardOutput, "built dashboard artifact");
	labArtifactRoot = await mkdtemp(join(tmpdir(), "golem-ui-primitives-"));
	labOutput = join(labArtifactRoot, "dist");
	await build({
		configFile: false,
		publicDir: false,
		resolve: {
			alias: {
				react: join(root, "apps", "dashboard", "node_modules", "react"),
				"react-dom": join(root, "apps", "dashboard", "node_modules", "react-dom"),
			},
			dedupe: ["react", "react-dom"],
		},
		root: fixtureRoot,
		build: {
			emptyOutDir: true,
			minify: "esbuild",
			outDir: labOutput,
			sourcemap: false,
		},
		logLevel: "error",
	});
	await assertBuiltArtifact(labOutput, "isolated design-lab test artifact");
});

after(async () => {
	if (labArtifactRoot) await rm(labArtifactRoot, { force: true, recursive: true });
});

test("ui primitive runner validates the current dashboard output and clean lab artifact", async () => {
	await assertBuiltArtifact(dashboardOutput, "built dashboard artifact");
	assert.ok(labOutput, "the isolated design-lab artifact must be built before browser assertions");
	await assertBuiltArtifact(labOutput, "isolated design-lab test artifact");
});

function relativeLuminance(color) {
	const channels = color.match(/\d+(?:\.\d+)?/gu)?.slice(0, 3).map(Number);
	assert.equal(channels?.length, 3, `expected an RGB computed color, received ${color}`);
	return channels
		.map((channel, index) => {
			const value = channel / 255;
			const linear = value <= 0.04045
				? value / 12.92
				: ((value + 0.055) / 1.055) ** 2.4;
			return linear * [0.2126, 0.7152, 0.0722][index];
		})
		.reduce((sum, channel) => sum + channel, 0);
}

function contrastRatio(foreground, background) {
	const [lighter, darker] = [
		relativeLuminance(foreground),
		relativeLuminance(background),
	].sort((left, right) => right - left);
	return (lighter + 0.05) / (darker + 0.05);
}

function assertWcagAa(colors, theme) {
	for (const [name, [foreground, background]] of Object.entries(colors)) {
		const ratio = contrastRatio(foreground, background);
		assert.ok(ratio >= 4.5, `${theme} ${name} contrast must meet WCAG AA; observed ${ratio.toFixed(2)}:1`);
	}
}

async function representativeColors(page) {
	return page.evaluate(() => {
		const button = document.querySelector("#dialog-trigger");
		if (!button) throw new Error("primary design-lab button is unavailable");
		const body = getComputedStyle(document.body);
		const primary = getComputedStyle(button);
		return {
			body: [body.color, body.backgroundColor],
			primary: [primary.color, primary.backgroundColor],
		};
	});
}

function startStaticOutput(output) {
	const indexPath = join(output, "index.html");
	const sockets = new Set();
	const server = createServer(async (request, response) => {
		const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
		if (pathname === "/favicon.ico") {
			response.writeHead(204).end();
			return;
		}
		const localPath = pathname === "/" || pathname.startsWith("/design-lab")
			? "index.html"
			: pathname.slice(1);
		const target = resolve(output, normalize(localPath));
		if (!target.startsWith(`${output}/`) && target !== indexPath) {
			response.writeHead(403).end();
			return;
		}

		try {
			const content = await readFile(target);
			response.writeHead(200, {
				"content-type": mimeTypes[extname(target)] ?? "application/octet-stream",
			});
			response.end(content);
		} catch {
			response.writeHead(404).end();
		}
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});

	return new Promise((resolveServer, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("ephemeral lab server did not expose a loopback port"));
				return;
			}
			resolveServer({
				close: async () => {
					server.closeAllConnections?.();
					for (const socket of sockets) socket.destroy();
					if (!server.listening) return;
					await new Promise((done) => server.close(done));
				},
				url: `http://127.0.0.1:${address.port}`,
			});
		});
	});
}

test("design lab preserves keyboard, theme, and passport-card containment contracts", async () => {
	assert.ok(labOutput, "the isolated design-lab artifact must be ready before serving it");
	const server = await startStaticOutput(labOutput);
	const chrome = await acquireChrome();
	const context = chrome.browser.contexts()[0];
	if (!context) throw new Error("headless Chrome did not expose a browser context");
	const page = await context.newPage();
	const browserErrors = [];
	page.on("console", (message) => {
		if (message.type() === "error") browserErrors.push(message.text());
	});
	page.on("pageerror", (error) => browserErrors.push(error.message));
	page.setDefaultTimeout(5_000);

	try {
		await page.emulateMedia({
			colorScheme: "light",
			contrast: "no-preference",
			reducedMotion: "no-preference",
		});
		await page.addInitScript(() => {
			const snapshots = [];
			window.__golemThemeSnapshots = snapshots;
			new MutationObserver(() => {
				const theme = document.documentElement?.dataset.theme;
				if (theme) snapshots.push(theme);
			}).observe(document, {
				attributes: true,
				attributeFilter: ["data-theme"],
				childList: true,
				subtree: true,
			});
		});
		await page.goto(`${server.url}/design-lab`, { waitUntil: "domcontentloaded" });
		await page.evaluate(() => localStorage.removeItem("golem.ui.theme"));
		await page.reload({ waitUntil: "domcontentloaded" });
		try {
			await page.getByTestId("design-lab").waitFor();
		} catch (error) {
			throw new Error(`design lab did not mount: ${browserErrors.join(" | ") || error.message}`);
		}
		assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
		assert.equal(await page.locator("html").getAttribute("data-theme-preference"), "system");
		assert.equal(
			await page.evaluate(() => window.__golemThemeSnapshots.filter(Boolean)[0]),
			"light",
			"system preference resolves before the design lab mounts",
		);
		assertWcagAa(await representativeColors(page), "light");

		await page.emulateMedia({ colorScheme: "dark" });
		await page.evaluate(() => localStorage.setItem("golem.ui.theme", "invalid-theme"));
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.getByTestId("design-lab").waitFor();
		assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
		assert.equal(await page.locator("html").getAttribute("data-theme-preference"), "system");
		assert.equal(
			await page.evaluate(() => window.__golemThemeSnapshots.filter(Boolean)[0]),
			"dark",
			"invalid stored values fall back to the system theme before the app mounts",
		);

		await page.getByTestId("theme-select").getByRole("button").focus();
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Enter");
		assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
		assert.equal(await page.evaluate(() => localStorage.getItem("golem.ui.theme")), "dark");
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.getByTestId("design-lab").waitFor();
		assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
		assert.equal(await page.locator("html").getAttribute("data-theme-preference"), "dark");
		assert.equal(
			await page.evaluate(() => window.__golemThemeSnapshots.filter(Boolean)[0]),
			"dark",
			"the pre-module bootstrap sets the persisted theme before the app mounts",
		);
		assertWcagAa(await representativeColors(page), "dark");
		const computedSurface = await page.evaluate(() => {
			const root = getComputedStyle(document.documentElement);
			const group = document.querySelector("[class*='group']");
			return {
				radius: root.getPropertyValue("--g-radius-pill").trim(),
				shadow: getComputedStyle(group).boxShadow,
				space: root.getPropertyValue("--g-space-5").trim(),
				surface: getComputedStyle(group).backgroundColor,
				surfaceToken: root.getPropertyValue("--g-surface-raised").trim(),
			};
		});
		assert.equal(computedSurface.radius, "999rem");
		assert.equal(computedSurface.space, "1.25rem");
		assert.notEqual(computedSurface.shadow, "none");
		assert.notEqual(computedSurface.surfaceToken, "", "semantic raised-surface token must be defined");
		assert.match(computedSurface.surface, /^rgba?\(/u);
		assert.notEqual(computedSurface.surface, "transparent");
		const surfaceChannels = computedSurface.surface.match(/\d+(?:\.\d+)?/gu)?.map(Number);
		assert.ok(surfaceChannels && (surfaceChannels.length === 3 || surfaceChannels.length === 4));
		assert.ok(
			(surfaceChannels.length === 4 ? surfaceChannels[3] : 1) > 0,
			"computed raised surface must not have a transparent alpha channel",
		);

		const descriptionIds = await page.getByRole("textbox", { name: "Queue name" }).evaluate((input) => input.getAttribute("aria-describedby")?.split(" ") ?? []);
		assert.ok(
			await page.evaluate((ids) => ids.some((id) => document.getElementById(id)?.textContent === "Visible text label and description."), descriptionIds),
			"text-field descriptions are programmatically associated",
		);
		const errorField = page.getByRole("textbox", { name: "Required queue" });
		assert.equal(await errorField.getAttribute("aria-invalid"), "true");
		const errorIds = await errorField.evaluate((input) => input.getAttribute("aria-describedby")?.split(" ") ?? []);
		assert.ok(
			await page.evaluate((ids) => ids.some((id) => document.getElementById(id)?.textContent === "Queue name is required."), errorIds),
			"field errors are programmatically associated",
		);

		await page.locator("#menu-trigger").focus();
		await page.keyboard.press("Enter");
		await page.getByRole("menu", { name: "Actions" }).waitFor();
		await page.keyboard.press("Escape");
		await page.waitForFunction(() => document.activeElement?.id === "menu-trigger");

		await page.locator("#dialog-trigger").focus();
		assert.equal(await page.evaluate(() => document.activeElement?.id), "dialog-trigger");
		await page.keyboard.press("Enter");
		await page.getByRole("dialog", { name: "Keyboard dialog" }).waitFor();
		await page.keyboard.press("Escape");
		await page.getByRole("dialog", { name: "Keyboard dialog" }).waitFor({ state: "hidden" });
		await page.waitForFunction(() => document.activeElement?.id === "dialog-trigger");
		assert.equal(await page.evaluate(() => document.activeElement?.id), "dialog-trigger");
		await page.locator("#drawer-trigger").focus();
		assert.equal(
			await page.locator("#drawer-trigger").evaluate((element) => getComputedStyle(element).outlineStyle),
			"solid",
		);
		await page.keyboard.press("Enter");
		await page.getByRole("dialog", { name: "Operator drawer" }).waitFor();
		await page.keyboard.press("Escape");
		await page.getByRole("dialog", { name: "Operator drawer" }).waitFor({ state: "hidden" });
		await page.waitForFunction(() => document.activeElement?.id === "drawer-trigger");

		await page.getByRole("tab", { name: "Foundation" }).focus();
		await page.keyboard.press("ArrowRight");
		assert.equal(await page.getByRole("tab", { name: "States" }).getAttribute("aria-selected"), "true");
		await page.getByText("No queued work").waitFor();
		await page.getByText("Queue unavailable").waitFor();
		await page.getByText("Connection paused").waitFor();
		await page.getByRole("status", { name: "Loading" }).waitFor();
		await page.getByRole("option", { name: "Ready queue" }).focus();
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Space");
		assert.equal(await page.getByRole("option", { name: "Review queue" }).getAttribute("aria-selected"), "true");

		await page.getByTestId("passport-role").getByRole("button").focus();
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Enter");
		assert.equal(await page.getByTestId("passport-open-count").textContent(), "0");
		await page.getByTestId("passport-surface").click();
		assert.equal(await page.getByTestId("passport-open-count").textContent(), "1");
		assert.ok(
			await page.getByTestId("passport-card").evaluate((card) => card.getBoundingClientRect().width <= 520),
			"passport card stays at the explicit 520px maximum",
		);

		await page.setViewportSize({ height: 800, width: 360 });
		assert.equal(
			await page.getByTestId("passport-card").evaluate((card) => {
				const grid = card.querySelector("[class*='passportContent']");
				return grid ? getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/u).length : 0;
			}),
			1,
			"passport role layout collapses to one column at the narrow width",
		);

		await page.emulateMedia({ contrast: "more", reducedMotion: "reduce" });
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.getByTestId("design-lab").waitFor();
		await page.locator("#dialog-trigger").focus();
		assert.equal(
			await page.locator("#dialog-trigger").evaluate((element) => getComputedStyle(element).outlineWidth),
			"4px",
			"high-contrast media preference enlarges the visible semantic focus ring",
		);
		assert.equal(
			Number.parseFloat(await page.locator("html").evaluate((element) => getComputedStyle(element).getPropertyValue("--g-motion-fast").trim())),
			0,
			"reduced motion resolves the semantic transition token to zero",
		);
		assert.deepEqual(browserErrors, [], "the rendered lab has no console or page errors");
	} finally {
		await page.close();
		await chrome.cleanup();
		await server.close();
	}
});
