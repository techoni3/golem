import assert from "node:assert/strict";

import { acquireChrome } from "../../dashboard/scripts/_chrome.mjs";
import { createRuntimeDashboardHarness } from "./runtime-dashboard.mjs";

const routes = [
	{ path: "/", heading: "Runtime overview", navigation: "Overview" },
	{ path: "/sessions", heading: "Sessions", navigation: "Sessions" },
	{ path: "/projects", heading: "Projects", navigation: "Projects" },
	{ path: "/history", heading: "History", navigation: "History" },
	{
		path: "/diagnostics",
		heading: "Diagnostics",
		navigation: "Diagnostics",
	},
	{ path: "/tracker", heading: "Work board", navigation: "Tracker" },
	{
		path: "/specs",
		heading: "Specs and decisions",
		navigation: "Specs",
	},
	{
		path: "/review",
		heading: "Review and operations",
		navigation: "Review",
	},
	{
		path: "/settings",
		heading: "Settings and capabilities",
		navigation: "Settings",
	},
];

const viewports = [
	{ width: 360, height: 800 },
	{ width: 768, height: 900 },
	{ width: 1280, height: 900 },
	{ width: 1600, height: 1000 },
];

async function waitForRoute(page, route) {
	await page.getByTestId("dashboard-shell").waitFor();
	try {
		await page
			.getByRole("heading", { level: 1, name: route.heading })
			.waitFor({ timeout: 8_000 });
	} catch (error) {
		throw new Error(
			`${route.path} did not render ${route.heading}; body=${JSON.stringify(await page.locator("body").innerText())}; cause=${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function auditAccessibility(page, route) {
	const issues = await page.evaluate(() => {
		const findings = [];
		const visible = (element) => {
			const style = getComputedStyle(element);
			return (
				style.display !== "none" &&
				style.visibility !== "hidden" &&
				element.getClientRects().length > 0
			);
		};
		const referencedText = (element, attribute) =>
			(element.getAttribute(attribute) ?? "")
				.split(/\s+/u)
				.filter(Boolean)
				.map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
				.filter(Boolean)
				.join(" ");
		const looseName = (element) =>
			element.getAttribute("aria-label")?.trim() ||
			referencedText(element, "aria-labelledby") ||
			("labels" in element
				? [...element.labels]
						.map((label) => label.textContent?.trim() ?? "")
						.filter(Boolean)
						.join(" ")
				: "") ||
			element.getAttribute("alt")?.trim() ||
			element.getAttribute("title")?.trim() ||
			element.textContent?.trim() ||
			"";

		const ids = new Map();
		for (const element of document.querySelectorAll("[id]")) {
			const id = element.id;
			ids.set(id, (ids.get(id) ?? 0) + 1);
		}
		for (const [id, count] of ids)
			if (count > 1) findings.push(`duplicate id: ${id}`);

		for (const attribute of ["aria-labelledby", "aria-describedby"]) {
			for (const element of document.querySelectorAll(`[${attribute}]`)) {
				for (const id of (element.getAttribute(attribute) ?? "")
					.split(/\s+/u)
					.filter(Boolean))
					if (!document.getElementById(id))
						findings.push(`${attribute} references missing #${id}`);
			}
		}

		const main = [...document.querySelectorAll("main")].filter(visible);
		const h1 = [...document.querySelectorAll("h1")].filter(visible);
		if (main.length !== 1)
			findings.push(`expected one visible main landmark, found ${main.length}`);
		if (h1.length !== 1)
			findings.push(`expected one visible h1, found ${h1.length}`);
		if (
			![...document.querySelectorAll("nav")]
				.filter(visible)
				.some((element) => looseName(element))
		)
			findings.push("visible navigation has no accessible name");

		for (const heading of document.querySelectorAll("h1, h2, h3, h4, h5, h6"))
			if (visible(heading) && !heading.textContent?.trim())
				findings.push(`empty visible ${heading.tagName.toLowerCase()}`);

		for (const element of document.querySelectorAll(
			"button, a[href], input:not([type='hidden']), select, textarea, [role='button'], [role='tab'], [role='menuitem'], [role='option']",
		))
			if (visible(element) && !looseName(element))
				findings.push(
					`unnamed interactive ${element.tagName.toLowerCase()}${element.getAttribute("role") ? `[role=${element.getAttribute("role")}]` : ""}`,
				);

		for (const image of document.querySelectorAll("img"))
			if (!image.hasAttribute("alt"))
				findings.push("image is missing an alt attribute");

		for (const hidden of document.querySelectorAll('[aria-hidden="true"]')) {
			const candidates = [
				hidden,
				...hidden.querySelectorAll(
					"button, a[href], input, select, textarea, [tabindex]",
				),
			];
			if (
				candidates.some(
					(element) =>
						element instanceof HTMLElement &&
						element.tabIndex >= 0 &&
						!("disabled" in element && element.disabled),
				)
			)
				findings.push("aria-hidden subtree contains a focusable control");
		}
		return findings;
	});
	assert.deepEqual(
		issues,
		[],
		`${route.path} has no serious landmark, name, relationship, or focus-hiding accessibility defects`,
	);
}

async function assertNoPageOverflow(page, width, route) {
	const layout = await page.evaluate(() => ({
		documentWidth: document.documentElement.scrollWidth,
		viewportWidth: window.innerWidth,
	}));
	assert.equal(
		layout.documentWidth <= layout.viewportWidth + 1,
		true,
		`${route.path} contains horizontal scrolling at ${width}px`,
	);
}

async function chooseTheme(page, name) {
	const theme = page.getByTestId("dashboard-theme");
	await theme.getByRole("button").click();
	await page.getByRole("option", { name, exact: true }).click();
}

export async function exerciseAccessibilityResponsiveThemes() {
	const harness = await createRuntimeDashboardHarness(
		"golem-gol58-accessibility-responsive-",
	);
	let chrome;
	try {
		chrome = await acquireChrome();
		const context = await chrome.browser.newContext();
		const page = await context.newPage();
		const browserErrors = [];
		const failedRequests = [];
		page.on("console", (message) => {
			if (
				message.type() === "error" &&
				!/Failed to load resource/iu.test(message.text())
			)
				browserErrors.push(message.text());
		});
		page.on("pageerror", (error) => browserErrors.push(error.message));
		page.on("response", (response) => {
			if (
				response.status() >= 400 &&
				!response.url().endsWith("/favicon.ico")
			)
				failedRequests.push(`${response.status()} ${response.url()}`);
		});
		page.setDefaultTimeout(8_000);
		try {
			await page.emulateMedia({
				colorScheme: "light",
				contrast: "no-preference",
				forcedColors: "none",
				reducedMotion: "no-preference",
			});
			await page.goto(`${harness.origin}/`, {
				waitUntil: "domcontentloaded",
			});
			await waitForRoute(page, routes[0]);

			await page.evaluate(() =>
				window.localStorage.setItem("golem.ui.theme", "system"),
			);
			await page.reload({ waitUntil: "domcontentloaded" });
			await waitForRoute(page, routes[0]);
			assert.equal(
				await page.locator("html").getAttribute("data-theme"),
				"light",
				"system theme resolves light media before the production shell mounts",
			);

			await page.emulateMedia({ colorScheme: "dark" });
			await page.reload({ waitUntil: "domcontentloaded" });
			await waitForRoute(page, routes[0]);
			assert.equal(
				await page.locator("html").getAttribute("data-theme"),
				"dark",
				"system theme follows dark media in the production shell",
			);
			const darkTokens = await page.locator("html").evaluate((element) => {
				const style = getComputedStyle(element);
				return {
					canvas: style.getPropertyValue("--g-canvas").trim(),
					text: style.getPropertyValue("--g-text").trim(),
				};
			});

			await chooseTheme(page, "Light");
			assert.equal(
				await page.locator("html").getAttribute("data-theme"),
				"light",
				"explicit light theme overrides dark system media",
			);
			const lightTokens = await page.locator("html").evaluate((element) => {
				const style = getComputedStyle(element);
				return {
					canvas: style.getPropertyValue("--g-canvas").trim(),
					text: style.getPropertyValue("--g-text").trim(),
				};
			});
			assert.notDeepEqual(
				lightTokens,
				darkTokens,
				"light and dark themes resolve distinct semantic canvas and text tokens",
			);
			await chooseTheme(page, "Dark");
			assert.equal(
				await page.locator("html").getAttribute("data-theme"),
				"dark",
				"explicit dark theme is immediately reflected",
			);

			const skip = page.getByRole("link", { name: "Skip to main content" });
			await skip.focus();
			await page.keyboard.press("Enter");
			assert.equal(
				await page
					.locator("#dashboard-content")
					.evaluate((element) => document.activeElement === element),
				true,
				"skip navigation moves keyboard focus to the main landmark",
			);
			const sessionsLink = page.getByRole("link", { name: "Sessions" });
			await sessionsLink.focus();
			await page.keyboard.press("Enter");
			await waitForRoute(page, routes[1]);
			assert.equal(
				await sessionsLink.getAttribute("aria-current"),
				"page",
				"keyboard navigation exposes the active route",
			);

			await page.emulateMedia({
				contrast: "more",
				forcedColors: "active",
				reducedMotion: "reduce",
			});
			await page.reload({ waitUntil: "domcontentloaded" });
			await waitForRoute(page, routes[1]);
			assert.equal(
				await page.evaluate(
					() =>
						matchMedia("(forced-colors: active)").matches &&
						matchMedia("(prefers-reduced-motion: reduce)").matches,
				),
				true,
				"forced colors and reduced motion reach the production document",
			);
			assert.equal(
				Number.parseFloat(
					await page.locator("html").evaluate((element) =>
						getComputedStyle(element)
							.getPropertyValue("--g-motion-fast")
							.trim(),
					),
				),
				0,
				"reduced motion resolves the shared semantic motion token to zero",
			);
			await sessionsLink.focus();
			assert.notEqual(
				await sessionsLink.evaluate(
					(element) => getComputedStyle(element).outlineStyle,
				),
				"none",
				"forced-colors keyboard focus remains visibly outlined",
			);

			await page.emulateMedia({
				colorScheme: "light",
				contrast: "no-preference",
				forcedColors: "none",
				reducedMotion: "no-preference",
			});
			await chooseTheme(page, "System");

			for (const viewport of viewports) {
				await page.setViewportSize(viewport);
				for (const route of routes) {
					await page.goto(`${harness.origin}${route.path}`, {
						waitUntil: "domcontentloaded",
					});
					await waitForRoute(page, route);
					assert.equal(
						await page
							.getByRole("link", { name: route.navigation })
							.getAttribute("aria-current"),
						"page",
						`${route.path} identifies its active navigation item`,
					);
					await assertNoPageOverflow(page, viewport.width, route);
					await auditAccessibility(page, route);
				}
			}

			await page.goto(`${harness.origin}/`, {
				waitUntil: "domcontentloaded",
			});
			await waitForRoute(page, routes[0]);
			assert.equal(
				await page
					.getByTestId("passport-card")
					.evaluate((card) => card.getBoundingClientRect().width <= 520),
				true,
				"the production PassportCard remains bounded at its 520px contract",
			);
			assert.deepEqual(
				browserErrors,
				[],
				"production theme and responsive journeys produce no browser errors",
			);
			assert.deepEqual(
				failedRequests,
				[],
				"all typed production routes load without failed application requests",
			);
		} finally {
			await context.close();
		}
		return "real control-plane routes pass named-landmark, keyboard, active-navigation, system/light/dark, forced-colors, reduced-motion, and 360/768/1280/wide containment matrices";
	} finally {
		if (chrome) await chrome.cleanup();
		await harness.close();
	}
}
