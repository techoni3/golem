import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { acquireChrome } from "../dashboard/scripts/_chrome.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = join(root, "apps", "dashboard", "dist", "assets");
const mimeTypes = {
	".css": "text/css",
	".html": "text/html",
	".js": "text/javascript",
	".map": "application/json",
};

function startStaticOutput() {
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
		if (!target.startsWith(`${output}/`) && target !== join(output, "index.html")) {
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
	const server = await startStaticOutput();
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
		await page.goto(`${server.url}/design-lab`, { waitUntil: "domcontentloaded" });
		try {
			await page.getByTestId("design-lab").waitFor();
		} catch (error) {
			throw new Error(`design lab did not mount: ${browserErrors.join(" | ") || error.message}`);
		}
		assert.match(await page.locator("html").getAttribute("data-theme"), /^(dark|light)$/);

		await page.getByTestId("theme-select").getByRole("button").focus();
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Enter");
		assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
		assert.equal(await page.evaluate(() => localStorage.getItem("golem.ui.theme")), "dark");
		await page.addInitScript(() => {
			const snapshots = [];
			const observer = new MutationObserver(() => {
				if (document.documentElement.dataset.theme) snapshots.push(document.documentElement.dataset.theme);
			});
			observer.observe(document, {
				attributes: true,
				attributeFilter: ["data-theme"],
				childList: true,
				subtree: true,
			});
			window.__golemThemeSnapshots = snapshots;
		});
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.getByTestId("design-lab").waitFor();
		assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
		assert.equal(
			await page.evaluate(() => window.__golemThemeSnapshots.filter(Boolean)[0]),
			"dark",
			"the pre-module bootstrap sets the persisted theme before the app mounts",
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

		await page.emulateMedia({ reducedMotion: "reduce" });
		await page.reload({ waitUntil: "domcontentloaded" });
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
