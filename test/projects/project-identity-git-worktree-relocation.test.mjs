import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { composeControlPlaneProjectService } from "@golem/control-plane";
import { createTemporaryHome } from "@golem/testkit";
import { openControlPlanePersistence } from "../../apps/control-plane/dist/persistence.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

function runGit(cwd, ...args) {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initGit(root) {
	fs.mkdirSync(root, { recursive: true });
	runGit(root, "init", "-q");
	runGit(root, "config", "user.email", "journey@example.test");
	runGit(root, "config", "user.name", "Journey Fixture");
	fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
	runGit(root, "add", "README.md");
	runGit(root, "commit", "-qm", "fixture");
}

test("J2 project identity follows Git roots, worktrees, relocation, and explicit registration", async () => {
	const home = createTemporaryHome("golem-j2-project-identity-");
	let owner;
	try {
		owner = openControlPlanePersistence({ runtimePath: home.runtimeDb, trackerPath: home.trackerDb });
		const service = composeControlPlaneProjectService(owner, { golemHome: home.golemHome, homeDirectory: home.home });
		const repo = path.join(home.root, "repo");
		initGit(repo);
		const nested = path.join(repo, "packages", "nested");
		fs.mkdirSync(nested, { recursive: true });
		const first = service.resolve(nested);
		assert.equal(first.status, "registered");
		assert.equal(first.evidence.projectRoot, fs.realpathSync(repo));
		assert.equal(first.view?.locations.length, 1);
		const rootAgain = service.resolve(repo);
		assert.equal(rootAgain.view?.projectId, first.view?.projectId, "nested and root paths share one opaque project UUID");
		assert.equal(rootAgain.view?.nameSource, "git");

		const worktree = path.join(home.root, "repo-worktree");
		runGit(repo, "worktree", "add", "-q", "-b", "linked-fixture", worktree);
		fs.mkdirSync(path.join(worktree, "nested"), { recursive: true });
		const linked = service.resolve(path.join(worktree, "nested"));
		assert.equal(linked.status, "registered");
		assert.equal(linked.view?.projectId, first.view?.projectId, "linked worktree groups by Git common-dir evidence");
		assert(linked.view?.locations.some((location) => location.relation === "worktree"));
		assert.equal(linked.evidence.isWorktree, true);

		const relocated = path.join(home.root, "repo-relocated");
		runGit(repo, "clone", "-q", repo, relocated);
		const relocatedView = service.register({ cwd: relocated, projectId: first.view.projectId, name: "Manual project name", retireLocationId: first.view.locations[0].locationId });
		assert.equal(relocatedView.projectId, first.view.projectId, "strong explicit project identity survives relocation");
		assert.equal(relocatedView.name, "Manual project name");
		assert(relocatedView.locations.some((location) => location.status === "retired"));
		assert(relocatedView.locations.some((location) => location.canonicalPath === fs.realpathSync(relocated) && location.status === "active"));
		assert.equal(service.resolve(relocated).view?.name, "Manual project name", "hook/discovery metadata cannot overwrite a manual name");
		assert.equal(service.rename(first.view.projectId, "Renamed project").name, "Renamed project");

		const unregistered = path.join(home.root, "unregistered", "nested");
		fs.mkdirSync(unregistered, { recursive: true });
		const unresolved = service.resolve(unregistered);
		assert.equal(unresolved.status, "unregistered");
		assert.match(unresolved.diagnostic.remedy, /golem project register/);
		fs.writeFileSync(path.join(home.root, "unregistered", ".golem-project"), JSON.stringify({ name: "Marked project" }));
		const marked = service.resolve(unregistered);
		assert.equal(marked.status, "registered", "a non-Git marker is explicit registration evidence");
		assert.equal(marked.view?.name, "Marked project");
		assert.throws(() => service.resolve(home.home), /broad_root_rejected/);

		const database = new Database(home.runtimeDb, { readonly: true });
		try {
			assert.equal(database.prepare("SELECT COUNT(*) AS count FROM projects").get().count, 2);
			assert(database.prepare("SELECT COUNT(*) AS count FROM project_locations").get().count >= 3);
			assert(database.prepare("SELECT COUNT(*) AS count FROM location_aliases").get().count >= 3);
			assert(database.prepare("SELECT COUNT(*) AS count FROM runtime_outbox WHERE destination = 'management'").get().count >= 3);
			const projectEvents = database.prepare("SELECT event_id, event_kind FROM runtime_events WHERE event_kind LIKE 'project.%' ORDER BY rowid").all();
			assert(projectEvents.some((row) => row.event_kind === "project.observed"));
			assert(projectEvents.some((row) => row.event_kind === "project.location.attached"));
			assert(projectEvents.some((row) => row.event_kind === "project.location.retired"));
			assert(projectEvents.some((row) => row.event_kind === "project.renamed"));
			const outboxEvents = database.prepare("SELECT payload_json FROM runtime_outbox WHERE destination = 'management'").all().map((row) => JSON.parse(row.payload_json).event_id).filter(Boolean);
			for (const event of projectEvents) assert(outboxEvents.includes(event.event_id), `management outbox retains audit event ${event.event_id}`);
		} finally {
			database.close();
		}
	} finally {
		if (owner) await owner.close();
		home.cleanup();
		assert.equal(fs.existsSync(home.root), false);
	}
});
