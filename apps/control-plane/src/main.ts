import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveControlPlanePersistencePaths } from "@golem/persistence";
import {
	createRuntimeMaterializer,
	createRuntimeProjectionService,
	createSessionService,
	RuntimeEngineScheduler,
	RuntimeOutboxDrainer,
} from "@golem/runtime";
import { createBrowserPrincipalResolver } from "./auth.js";
import { createBrowserSettingsServices } from "./browser-settings-services.js";
import { createBrowserWorkServices } from "./browser-work-services.js";
import { openControlPlanePersistence } from "./persistence.js";
import {
	controlPlanePortFromEnvironment,
	startControlPlane,
} from "./server.js";
import {
	composeControlPlaneCommandGateway,
	composeControlPlaneEndpointEligibility,
	composeControlPlaneManagementServices,
	composeControlPlaneTicketDispatchService,
	composeControlPlaneTrackerCoreServices,
	composeControlPlaneTrackerServices,
} from "./tracker.js";

const configuredTokenFile = process.env.GOLEM_CONTROL_PLANE_TOKEN_FILE;
const tokenFromFile = configuredTokenFile
	? (() => {
			try {
				return fs.readFileSync(configuredTokenFile, "utf8").trim();
			} catch {
				return undefined;
			}
		})()
	: undefined;
const token = process.env.GOLEM_CONTROL_PLANE_TOKEN ?? tokenFromFile;
const golemHome = process.env.GOLEM_HOME;
const stateDirectory = golemHome
	? path.join(golemHome, "control-plane")
	: undefined;
const staticDirectory = process.env.GOLEM_CONTROL_PLANE_STATIC_ROOT;
const browserLocalOperatorBindingId =
	process.env.GOLEM_BROWSER_LOCAL_OPERATOR_BINDING_ID ??
	"principal_local_operator";
const replayWindowValue = Number(process.env.GOLEM_CONTROL_PLANE_REPLAY_WINDOW);
const replayWindowSize =
	Number.isInteger(replayWindowValue) && replayWindowValue >= 1
		? replayWindowValue
		: undefined;
// Test-only seam: omit the projection port unless a valid revision is
// explicitly supplied. Normal composition therefore keeps lifecycle's
// persisted/default projection path instead of replacing it with an empty
// fixture projection.
const projectionRevisionRaw =
	process.env.GOLEM_CONTROL_PLANE_PROJECTION_REVISION;
const projectionRevisionValue =
	projectionRevisionRaw === undefined
		? undefined
		: Number(projectionRevisionRaw);
const projectionFixtureRaw = process.env.GOLEM_CONTROL_PLANE_PROJECTION_FIXTURE;
let projectionFixture: Record<string, unknown> | undefined;
if (projectionFixtureRaw) {
	try {
		const parsed: unknown = JSON.parse(projectionFixtureRaw);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
			projectionFixture = parsed as Record<string, unknown>;
	} catch {
		// Invalid test fixtures fail closed to the normal lifecycle projection.
	}
}
const projectionRevision =
	projectionRevisionValue !== undefined &&
	Number.isInteger(projectionRevisionValue) &&
	projectionRevisionValue >= 0
		? projectionRevisionValue
		: 0;
const testProjection =
	projectionFixture !== undefined ||
	(projectionRevisionValue !== undefined &&
		Number.isInteger(projectionRevisionValue) &&
		projectionRevisionValue >= 0)
		? {
				projection: {
					read: () => projectionFixture ?? {},
					revision: () => projectionRevision,
				},
			}
		: {};

if (!token || !golemHome || !stateDirectory || !staticDirectory) {
	process.stderr.write(
		"GOLEM_CONTROL_PLANE_TOKEN, GOLEM_HOME, and GOLEM_CONTROL_PLANE_STATIC_ROOT are required\n",
	);
	process.exitCode = 64;
} else {
	const persistence = resolveControlPlanePersistencePaths(golemHome);
	const owner = openControlPlanePersistence({
		runtimePath: persistence.runtimePath,
		trackerPath: persistence.trackerPath,
		...(persistence.lockPath ? { lockPath: persistence.lockPath } : {}),
	});
	const clock = {
		now: () => new Date().toISOString(),
		after: (milliseconds: number) =>
			new Date(Date.now() + milliseconds).toISOString(),
	};
	const principals = owner.browserPrincipalStorage();
	const projectIds = [
		...new Set([
			...owner
				.runtimeProjectionStorage()
				.projects()
				.map((project) => project.projectId),
			...owner
				.trackerCoreStorage()
				.listWorkItems()
				.map((ticket) => ticket.projectId),
		]),
	].sort();
	if (projectIds.length === 0) projectIds.push("golem-local");
	const defaultProjectId = projectIds[0] ?? "golem-local";
	const timestamp = clock.now();
	const hasBoundToken = principals.resolveCredential({
		adapter: "bearer",
		credential: token,
		now: timestamp,
	});
	if (!hasBoundToken) {
		try {
			principals.provision({
				id: browserLocalOperatorBindingId,
				actorId: "human:local-operator",
				role: "operator",
				defaultProjectId,
				scopeProjectIds: projectIds,
			});
		} catch {
			// A stable binding survives service restarts. Credential resolution
			// below still fails closed if this was any error other than an
			// already-provisioned binding.
		}
	}
	for (const adapter of ["bearer", "mcp", "internal"] as const) {
		if (
			principals.resolveCredential({
				adapter,
				credential: token,
				now: timestamp,
			})
		)
			continue;
		principals.bindCredential({
			bindingId: browserLocalOperatorBindingId,
			adapter,
			credential: token,
		});
	}
	const trackerCore = composeControlPlaneTrackerCoreServices({
		writer: owner,
		clock,
	});
	const trackerServices = composeControlPlaneTrackerServices({
		writer: owner,
		clock,
		eligibility: composeControlPlaneEndpointEligibility({
			endpoints: owner.runtimeEndpointStorage(),
			clock,
		}),
	});
	const ticketDispatch = composeControlPlaneTicketDispatchService({
		writer: owner,
		core: trackerCore,
		services: trackerServices,
		eligibility: composeControlPlaneEndpointEligibility({
			endpoints: owner.runtimeEndpointStorage(),
			clock,
		}),
	});
	const management = composeControlPlaneManagementServices({
		writer: owner,
		clock,
		assetRoot: path.join(golemHome, "ticket-assets"),
		tickets: trackerCore.tickets,
	});
	const commandGateway = composeControlPlaneCommandGateway({
		writer: owner,
		clock,
		core: trackerCore,
	});
	const browserWork = createBrowserWorkServices({
		core: trackerCore,
		management,
		ticketDispatch,
		projectRevision: (projectId) =>
			owner.committedPublicationStorage().projectRevision(projectId),
	});
	const modulePath = fileURLToPath(import.meta.url);
	const workspaceRoot = path.resolve(path.dirname(modulePath), "../../..");
	const cliEntry = path.resolve(
		process.env.GOLEM_CLI_ENTRY ?? path.join(workspaceRoot, "cli", "golem.js"),
	);
	const serviceCredentialPath = path.join(stateDirectory, "service-token");
	const openCodeConfigPath = path.resolve(
		process.env.OPENCODE_CONFIG_PATH ??
			path.join(
				process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
				"opencode",
				"opencode.jsonc",
			),
	);
	const launchAgentDirectory = path.resolve(
		process.env.GOLEM_CONTROL_PLANE_LAUNCH_AGENT_DIR ??
			path.join(os.homedir(), "Library", "LaunchAgents"),
	);
	const serviceEnvironment = {
		GOLEM_HOME: golemHome,
		GOLEM_CONTROL_PLANE_STATIC_ROOT: staticDirectory,
		GOLEM_CONTROL_PLANE_TOKEN_FILE: serviceCredentialPath,
		...(process.env.GOLEM_CONTROL_PLANE_PORT
			? {
					GOLEM_CONTROL_PLANE_PORT: process.env.GOLEM_CONTROL_PLANE_PORT,
				}
			: {}),
		GOLEM_BROWSER_LOCAL_OPERATOR_BINDING_ID: browserLocalOperatorBindingId,
	};
	let cutoverScheduler: RuntimeEngineScheduler | undefined;
	let cutoverStop: (() => Promise<void>) | undefined;
	const browserSettings = createBrowserSettingsServices({
		home: golemHome,
		runtimeProjection: owner.runtimeProjectionStorage(),
		cliEntry,
		openCodeConfigPath,
		environment: process.env,
		beforeCutover: async () => {
			await cutoverScheduler?.stop();
		},
		afterCutover: () => {
			const timer = setTimeout(() => {
				void cutoverStop?.();
			}, 250);
			timer.unref();
		},
		service: {
			directory: launchAgentDirectory,
			uid: process.getuid?.() ?? 0,
			credentialPath: serviceCredentialPath,
			credential: token,
			definition: {
				label: "dev.golem.control-plane",
				program: process.execPath,
				arguments: [modulePath],
				workingDirectory: workspaceRoot,
				environment: serviceEnvironment,
			},
		},
	});
	const principalResolver = createBrowserPrincipalResolver({
		storage: principals,
		localOperatorBindingId: browserLocalOperatorBindingId,
	});
	// Native adapter lifecycle signals are materialized through the same typed
	// session service as every other runtime producer; the ingress itself never
	// obtains a SQLite handle.
	const sessions = createSessionService({
		projects: owner.runtimeProjectStorage(),
		sessions: owner.runtimeSessionStorage(),
	});
	const runtime = createRuntimeMaterializer({
		home: golemHome,
		writer: owner,
		sessions,
	});
	const runtimeProjection = createRuntimeProjectionService({
		storage: owner.runtimeProjectionStorage(),
		clock,
	});
	const controlProjection = {
		read: (stream: string, _projectId?: string) =>
			stream === "runtime.live" ||
			stream === "runtime.history" ||
			stream === "runtime.diagnostics"
				? runtimeProjection.read(stream)
				: {},
		revision: (stream: string, projectId?: string) =>
			stream === "runtime.live" ||
			stream === "runtime.history" ||
			stream === "runtime.diagnostics"
				? runtimeProjection.revision(stream)
				: projectId
					? owner.committedPublicationStorage().projectRevision(projectId)
					: 0,
	};
	const outbox = new RuntimeOutboxDrainer({
		writer: owner,
		workerId: `control-plane-${process.pid}`,
		destinations: {
			// Wave 5 intentionally has no tracker/management transport adapter.
			// The bounded durable scheduler records retry/permanent state rather
			// than pretending this cross-store delivery is already atomic.
			tracker: {
				deliver: async () => {
					throw new Error("runtime tracker destination is not configured");
				},
			},
			management: {
				deliver: async () => {
					throw new Error("runtime management destination is not configured");
				},
			},
		},
	});
	const scheduler = new RuntimeEngineScheduler({
		materializer: runtime.materializer,
		outbox,
		writer: owner,
	});
	cutoverScheduler = scheduler;
	try {
		await scheduler.start();
	} catch (error) {
		await owner.close();
		throw error;
	}
	let service: Awaited<ReturnType<typeof startControlPlane>>;
	try {
		service = await startControlPlane({
			token,
			stateDirectory,
			staticDirectory,
			port: controlPlanePortFromEnvironment(
				process.env.GOLEM_CONTROL_PLANE_PORT,
			),
			runtimeIngress: runtime.inbox,
			runtimeHealth: scheduler,
			projection: controlProjection,
			runtimeProjection,
			management,
			trackerCore,
			trackerServices,
			ticketDispatch,
			commandGateway,
			browserWork,
			browserSettings,
			committedPublications: owner.committedPublicationStorage(),
			principalResolver,
			...(replayWindowSize ? { replayWindowSize } : {}),
			...testProjection,
		});
	} catch (error) {
		await scheduler.stop();
		await owner.close();
		throw error;
	}
	process.stdout.write(
		`${JSON.stringify({ type: "ready", origin: service.origin, instance_id: service.instanceId })}\n`,
	);
	const dashboardRecordPath = path.join(golemHome, "dashboard.json");
	try {
		fs.mkdirSync(path.dirname(dashboardRecordPath), {
			recursive: true,
			mode: 0o700,
		});
		const temporary = `${dashboardRecordPath}.${process.pid}.tmp`;
		fs.writeFileSync(
			temporary,
			`${JSON.stringify(
				{
					schema_version: "golem.dashboard-discovery/v1",
					generated: true,
					authoritative: false,
					mode: persistence.authority.stage === "C4" ? "canonical" : "dark",
					canonical_revision: persistence.authority.canonical_revision ?? 0,
					authority_revision: persistence.authority.revision,
					url: service.origin.replace("127.0.0.1", "dashboard.golem.localhost"),
					host: "127.0.0.1",
					port: Number(new URL(service.origin).port),
					pid: process.pid,
					instance_id: service.instanceId,
					started_at: clock.now(),
				},
				null,
				2,
			)}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);
		fs.renameSync(temporary, dashboardRecordPath);
	} catch {
		// Discovery is generated compatibility state. Health remains the
		// authority if a read-only home prevents this optional projection.
	}
	let stopping = false;
	const stop = async () => {
		if (stopping) return;
		stopping = true;
		await scheduler.stop();
		await service.close();
		await owner.close();
	};
	cutoverStop = stop;
	process.once("SIGINT", () => void stop());
	process.once("SIGTERM", () => void stop());
}
