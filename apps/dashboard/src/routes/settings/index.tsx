import type {
	BrowserSettingsCommandRequest,
	BrowserSettingsSnapshot,
} from "@golem/api-client";
import {
	Button,
	DialogSurface,
	InlineAlert,
	OperatorTabs,
	Select,
	Skeleton,
	StatePanel,
	StatusBadge,
	TextField,
	Toast,
} from "@golem/ui";
import * as React from "react";

import {
	useRefreshSettings,
	useSettingsCommand,
	useSettingsSnapshot,
} from "./data.js";
import styles from "./settings.module.css";

type Confirmation = Readonly<{
	title: string;
	description: string;
	command: BrowserSettingsCommandRequest;
	affected: readonly string[];
	planHash?: string;
	blocked?: boolean;
}>;

function idempotencyKey(kind: string): string {
	return `settings-${kind}-${crypto.randomUUID()}`;
}

function statusTone(
	value: string,
): "success" | "warning" | "danger" | "info" | "neutral" {
	if (
		[
			"ready",
			"running",
			"clean",
			"healthy",
			"supported",
			"configured",
			"completed",
			"available",
		].includes(value)
	)
		return "success";
	if (
		[
			"drift",
			"held",
			"experimental",
			"unknown",
			"review_required",
			"pull_only",
			"next_turn",
			"degraded",
			"pending",
		].includes(value)
	)
		return "warning";
	if (
		[
			"error",
			"tamper",
			"failed",
			"unavailable",
			"unsupported",
			"ineligible",
		].includes(value)
	)
		return "danger";
	return "neutral";
}

function Facts({
	rows,
}: {
	readonly rows: readonly (readonly [string, React.ReactNode])[];
}) {
	return (
		<dl className={styles.facts}>
			{rows.map(([label, value]) => (
				<div key={label}>
					<dt>{label}</dt>
					<dd>{value}</dd>
				</div>
			))}
		</dl>
	);
}

function SettingsHeader({
	onRefresh,
	refreshing,
	revision,
}: {
	readonly onRefresh: () => void;
	readonly refreshing: boolean;
	readonly revision: number;
}) {
	return (
		<header className={styles.header}>
			<div>
				<p className={styles.eyebrow}>Typed control surface</p>
				<h1>Settings and capabilities</h1>
				<p>
					Review exact plans before changing services, rendered integrations,
					providers, presets, or migration state.
				</p>
				<span className={styles.revision}>Snapshot revision {revision}</span>
			</div>
			<Button isDisabled={refreshing} onPress={onRefresh} variant="secondary">
				Refresh truth
			</Button>
		</header>
	);
}

function SettingsContent({
	snapshot,
}: {
	readonly snapshot: BrowserSettingsSnapshot;
}) {
	const command = useSettingsCommand();
	const refresh = useRefreshSettings();
	const [selectedTab, setSelectedTab] = React.useState("service");
	const [confirmation, setConfirmation] = React.useState<Confirmation | null>(
		null,
	);
	const [notice, setNotice] = React.useState<string>();
	const [preset, setPreset] = React.useState({
		name: "my-preset",
		harness: "codex",
		backend: "openai",
		model_selector: "gpt-*",
		delivery_mode: "managed_app_server",
	});

	const preview = React.useCallback(
		async (
			request: BrowserSettingsCommandRequest,
			apply: (hash: string) => BrowserSettingsCommandRequest,
			title: string,
			description: string,
			blocked = false,
		) => {
			setNotice(undefined);
			try {
				const response = await command.mutateAsync(request);
				const result = response.result;
				if (response.status !== "completed" || !result?.plan_hash) {
					setNotice(
						"The durable preview is still pending. Refresh before confirming.",
					);
					return;
				}
				setConfirmation({
					title,
					description,
					command: apply(result.plan_hash),
					affected: result.affected,
					planHash: result.plan_hash,
					blocked,
				});
			} catch {
				setNotice(
					"The preview was rejected or unavailable. Draft values were preserved.",
				);
			}
		},
		[command],
	);

	const confirmRollback = React.useCallback(
		(
			title: string,
			description: string,
			request: BrowserSettingsCommandRequest,
			affected: readonly string[],
		) =>
			setConfirmation({
				title,
				description,
				command: request,
				affected,
			}),
		[],
	);

	const applyConfirmation = async () => {
		if (!confirmation || confirmation.blocked) return;
		try {
			const response = await command.mutateAsync(confirmation.command);
			setNotice(
				response.status === "completed"
					? (response.result?.summary ?? "Settings command completed.")
					: "The durable command is pending. Refresh to inspect current truth.",
			);
			setConfirmation(null);
		} catch {
			setNotice(
				"The confirmed command did not complete. Current drafts and server truth were left visible.",
			);
		}
	};

	const servicePanel = (
		<div className={styles.stack}>
			<section className={styles.card}>
				<div className={styles.cardHeader}>
					<div>
						<h2>Control-plane service</h2>
						<p>Process, API, and delivery are reported independently.</p>
					</div>
					<StatusBadge
						label={snapshot.service.process}
						tone={statusTone(snapshot.service.process)}
					/>
				</div>
				<Facts
					rows={[
						["Installed", snapshot.service.installed ? "Yes" : "No"],
						[
							"API",
							<StatusBadge
								key="api"
								label={snapshot.service.api}
								tone={statusTone(snapshot.service.api)}
							/>,
						],
						[
							"Delivery",
							<StatusBadge
								key="delivery"
								label={snapshot.service.delivery}
								tone={statusTone(snapshot.service.delivery)}
							/>,
						],
					]}
				/>
				<div className={styles.actions}>
					{snapshot.service.actions.map((action) => (
						<Button
							isDisabled={command.isPending}
							key={action}
							onPress={() =>
								void preview(
									{
										kind: "service.preview",
										action,
										idempotency_key: idempotencyKey(
											`service-preview-${action}`,
										),
									},
									(hash) => ({
										kind: "service.apply",
										action,
										plan_hash: hash,
										confirm: true,
										idempotency_key: idempotencyKey(`service-apply-${action}`),
									}),
									`Confirm service ${action}`,
									`Apply the reviewed ${action} plan to the managed control-plane service.`,
								)
							}
							variant={action === "stop" ? "danger" : "secondary"}
						>
							Preview {action}
						</Button>
					))}
				</div>
			</section>

			<section className={styles.card}>
				<div className={styles.cardHeader}>
					<div>
						<h2>Rendered integrations</h2>
						<p>
							Managed files are compiler-owned. Tamper is never overwritten
							without a separate recovery path.
						</p>
					</div>
				</div>
				<div className={styles.tableScroll}>
					<table>
						<thead>
							<tr>
								<th scope="col">Target</th>
								<th scope="col">Truth</th>
								<th scope="col">Version</th>
								<th scope="col">Files</th>
								<th scope="col">Actions</th>
							</tr>
						</thead>
						<tbody>
							{snapshot.renders.map((render) => (
								<tr key={render.target}>
									<th scope="row">{render.target}</th>
									<td>
										<StatusBadge
											label={render.status}
											tone={statusTone(render.status)}
										/>
									</td>
									<td>{render.version ?? "Not rendered"}</td>
									<td>{render.managed_files.length}</td>
									<td>
										<div className={styles.actions}>
											<Button
												isDisabled={command.isPending}
												onPress={() =>
													void preview(
														{
															kind: "render.preview",
															target: render.target,
															idempotency_key: idempotencyKey(
																`render-preview-${render.target}`,
															),
														},
														(hash) => ({
															kind: "render.apply",
															target: render.target,
															plan_hash: hash,
															confirm: true,
															idempotency_key: idempotencyKey(
																`render-apply-${render.target}`,
															),
														}),
														`Compile ${render.target}`,
														"Compile this target from canonical substrate after rechecking the exact preview.",
														render.status === "tamper" ||
															render.status === "error",
													)
												}
												variant="secondary"
											>
												Preview compile
											</Button>
											{render.rollback_available ? (
												<Button
													isDisabled={command.isPending}
													onPress={() =>
														confirmRollback(
															`Roll back ${render.target}`,
															"Restore the last managed render backup.",
															{
																kind: "render.rollback",
																target: render.target,
																confirm: true,
																idempotency_key: idempotencyKey(
																	`render-rollback-${render.target}`,
																),
															},
															[`render:${render.target}`],
														)
													}
													variant="danger"
												>
													Roll back
												</Button>
											) : null}
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</section>
		</div>
	);

	const capabilitiesPanel = (
		<div className={styles.stack}>
			<section className={styles.card}>
				<div className={styles.cardHeader}>
					<div>
						<h2>Capability matrix</h2>
						<p>
							Binary, provider, model, qualification, endpoint, and delivery
							facts stay separate.
						</p>
					</div>
				</div>
				<div className={styles.tableScroll}>
					<table>
						<thead>
							<tr>
								<th scope="col">Harness / backend</th>
								<th scope="col">Binary</th>
								<th scope="col">Provider</th>
								<th scope="col">Model</th>
								<th scope="col">Qualification</th>
								<th scope="col">Endpoint</th>
								<th scope="col">Delivery</th>
								<th scope="col">Evidence</th>
								<th scope="col">Remedy</th>
							</tr>
						</thead>
						<tbody>
							{snapshot.capabilities.map((capability) => (
								<tr key={capability.opaque_id}>
									<th scope="row">
										{capability.harness} / {capability.backend}
										<small>{capability.model_pattern}</small>
									</th>
									<td>
										<StatusBadge
											label={capability.binary}
											tone={statusTone(capability.binary)}
										/>
									</td>
									<td>{capability.provider}</td>
									<td>{capability.model}</td>
									<td>
										<StatusBadge
											label={capability.qualification}
											tone={statusTone(capability.qualification)}
										/>
									</td>
									<td>{capability.endpoint}</td>
									<td>{capability.delivery}</td>
									<td>
										{capability.evidence_version ?? "No version"}
										{capability.evidence_at ? (
											<small>
												<time dateTime={capability.evidence_at}>
													{capability.evidence_at}
												</time>
											</small>
										) : (
											<small>No observed evidence</small>
										)}
									</td>
									<td>{capability.remedy}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</section>

			<section className={styles.card}>
				<div className={styles.cardHeader}>
					<div>
						<h2>OpenCode providers</h2>
						<p>Managed setup never asks for or serializes credential values.</p>
					</div>
				</div>
				<div className={styles.grid}>
					{snapshot.providers.map((provider) => (
						<article className={styles.subcard} key={provider.provider}>
							<h3>{provider.provider.replaceAll("_", " ")}</h3>
							<Facts
								rows={[
									["Configured", provider.configured ? "Yes" : "No"],
									["Qualification", provider.qualification],
									["Delivery", provider.delivery_ready ? "Ready" : "Not ready"],
								]}
							/>
							<div className={styles.actions}>
								<Button
									isDisabled={command.isPending}
									onPress={() =>
										void preview(
											{
												kind: "provider.preview",
												provider: provider.provider,
												idempotency_key: idempotencyKey(
													`provider-preview-${provider.provider}`,
												),
											},
											(hash) => ({
												kind: "provider.apply",
												provider: provider.provider,
												plan_hash: hash,
												confirm: true,
												idempotency_key: idempotencyKey(
													`provider-apply-${provider.provider}`,
												),
											}),
											`Apply ${provider.provider} setup`,
											"Update only Golem's managed OpenCode provider region and preserve every other provider.",
										)
									}
									variant="secondary"
								>
									Preview setup
								</Button>
								{provider.rollback_available ? (
									<Button
										onPress={() =>
											confirmRollback(
												"Roll back OpenCode provider setup",
												"Restore the prior OpenCode configuration backup.",
												{
													kind: "provider.rollback",
													provider: provider.provider,
													confirm: true,
													idempotency_key: idempotencyKey(
														`provider-rollback-${provider.provider}`,
													),
												},
												[`provider:opencode/${provider.provider}`],
											)
										}
										variant="danger"
									>
										Roll back
									</Button>
								) : null}
							</div>
						</article>
					))}
				</div>
			</section>
		</div>
	);

	const presetsPanel = (
		<div className={styles.stack}>
			<section className={styles.card}>
				<div className={styles.cardHeader}>
					<div>
						<h2>Launcher preset editor</h2>
						<p>
							The preview resolves through the redacted canonical LaunchPlan.
						</p>
					</div>
				</div>
				<div className={styles.formGrid}>
					<TextField
						description="Lowercase letters, numbers, and hyphens."
						label="Preset name"
						onChange={(name) => setPreset((current) => ({ ...current, name }))}
						value={preset.name}
					/>
					<Select
						label="Harness"
						onChange={(harness) =>
							setPreset((current) => ({ ...current, harness }))
						}
						options={[
							{ id: "codex", label: "Codex" },
							{ id: "opencode", label: "OpenCode" },
							{ id: "claude", label: "Claude" },
							{ id: "pi", label: "Pi" },
						]}
						value={preset.harness}
					/>
					<Select
						label="Backend"
						onChange={(backend) =>
							setPreset((current) => ({ ...current, backend }))
						}
						options={[
							{ id: "openai", label: "OpenAI" },
							{ id: "anthropic", label: "Anthropic" },
							{ id: "ollama_local", label: "Ollama local" },
							{ id: "ollama_cloud", label: "Ollama cloud" },
							{ id: "native", label: "Native" },
						]}
						value={preset.backend}
					/>
					<TextField
						label="Model selector"
						onChange={(model_selector) =>
							setPreset((current) => ({ ...current, model_selector }))
						}
						value={preset.model_selector}
					/>
					<Select
						label="Delivery mode"
						onChange={(delivery_mode) =>
							setPreset((current) => ({ ...current, delivery_mode }))
						}
						options={[
							{ id: "managed_app_server", label: "Managed app server" },
							{ id: "native_channel", label: "Native channel" },
							{ id: "prompt_bridge", label: "Prompt bridge" },
							{ id: "pull", label: "Pull" },
							{ id: "next_turn", label: "Next turn" },
						]}
						value={preset.delivery_mode}
					/>
				</div>
				<div className={styles.actions}>
					<Button
						isDisabled={command.isPending || !preset.name.trim()}
						onPress={() =>
							void preview(
								{
									kind: "preset.preview",
									preset: {
										name: preset.name,
										harness: preset.harness as
											| "claude"
											| "codex"
											| "opencode"
											| "pi",
										backend: preset.backend as
											| "openai"
											| "anthropic"
											| "ollama_local"
											| "ollama_cloud"
											| "native",
										model_selector: preset.model_selector,
										delivery_mode: preset.delivery_mode as
											| "pull"
											| "native_channel"
											| "prompt_bridge"
											| "managed_app_server"
											| "next_turn",
									},
									idempotency_key: idempotencyKey("preset-preview"),
								},
								(hash) => ({
									kind: "preset.apply",
									preset: {
										name: preset.name,
										harness: preset.harness as
											| "claude"
											| "codex"
											| "opencode"
											| "pi",
										backend: preset.backend as
											| "openai"
											| "anthropic"
											| "ollama_local"
											| "ollama_cloud"
											| "native",
										model_selector: preset.model_selector,
										delivery_mode: preset.delivery_mode as
											| "pull"
											| "native_channel"
											| "prompt_bridge"
											| "managed_app_server"
											| "next_turn",
									},
									plan_hash: hash,
									confirm: true,
									idempotency_key: idempotencyKey("preset-apply"),
								}),
								`Save preset ${preset.name}`,
								"Save this reviewed launcher preset while preserving every unknown user-owned configuration key.",
							)
						}
						variant="primary"
					>
						Preview preset
					</Button>
					{snapshot.presets.some((entry) => entry.source === "user") ? (
						<Button
							onPress={() =>
								confirmRollback(
									"Roll back launcher presets",
									"Restore the prior launcher JSONC backup.",
									{
										kind: "preset.rollback",
										confirm: true,
										idempotency_key: idempotencyKey("preset-rollback"),
									},
									["preset:launcher"],
								)
							}
							variant="danger"
						>
							Roll back last save
						</Button>
					) : null}
				</div>
				<InlineAlert tone="info">
					{snapshot.unknown_config_keys_preserved
						? `${snapshot.unknown_config_key_count} user-owned top-level configuration keys will be preserved.`
						: "Launcher configuration is invalid; fix it before saving a preset."}
				</InlineAlert>
			</section>

			<section className={styles.card}>
				<h2>Resolved presets</h2>
				<div className={styles.tableScroll}>
					<table>
						<thead>
							<tr>
								<th scope="col">Name</th>
								<th scope="col">Harness</th>
								<th scope="col">Backend</th>
								<th scope="col">Model</th>
								<th scope="col">Source</th>
							</tr>
						</thead>
						<tbody>
							{snapshot.presets.map((entry) => (
								<tr key={`${entry.harness}:${entry.name}`}>
									<th scope="row">{entry.name}</th>
									<td>{entry.harness}</td>
									<td>{entry.backend}</td>
									<td>{entry.model_selector}</td>
									<td>{entry.source}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</section>
		</div>
	);

	const migrationPanel = (
		<div className={styles.stack}>
			<section className={styles.card}>
				<div className={styles.cardHeader}>
					<div>
						<h2>Legacy migration</h2>
						<p>
							A dry-run hash is mandatory. Review and quarantine actions block
							apply until resolved outside this bounded surface.
						</p>
					</div>
					<StatusBadge
						label={snapshot.migration.status}
						tone={statusTone(snapshot.migration.status)}
					/>
				</div>
				<Facts
					rows={[
						["Create", snapshot.migration.create],
						["Attach", snapshot.migration.attach],
						["Review", snapshot.migration.review],
						["Quarantine", snapshot.migration.quarantine],
						[
							"Backup",
							snapshot.migration.backup_available ? "Available" : "None",
						],
					]}
				/>
				{snapshot.migration.status === "review_required" ? (
					<InlineAlert tone="warning">
						Apply remains disabled because the canonical plan contains
						unresolved review or quarantine actions.
					</InlineAlert>
				) : null}
				<div className={styles.actions}>
					<Button
						isDisabled={command.isPending}
						onPress={() =>
							void preview(
								{
									kind: "migration.preview",
									idempotency_key: idempotencyKey("migration-preview"),
								},
								(hash) => ({
									kind: "migration.apply",
									plan_hash: hash,
									confirm: true,
									idempotency_key: idempotencyKey("migration-apply"),
								}),
								"Apply legacy migration",
								"Re-audit and apply only the exact reviewed migration plan with canonical backups.",
								snapshot.migration.status === "review_required",
							)
						}
						variant="primary"
					>
						Preview dry-run
					</Button>
					{snapshot.migration.rollback_available ? (
						<Button
							onPress={() =>
								confirmRollback(
									"Roll back legacy migration",
									"Restore canonical state from the migration backup.",
									{
										kind: "migration.rollback",
										confirm: true,
										idempotency_key: idempotencyKey("migration-rollback"),
									},
									["migration:canonical-state"],
								)
							}
							variant="danger"
						>
							Roll back migration
						</Button>
					) : null}
				</div>
			</section>

			<section className={styles.card}>
				<div className={styles.cardHeader}>
					<div>
						<h2>Canonical C4 cutover</h2>
						<p>
							One exact-hash switch fences legacy writers, selects canonical
							runtime state, and retains an audited rollback.
						</p>
					</div>
					<StatusBadge
						label={snapshot.cutover.status}
						tone={statusTone(snapshot.cutover.status)}
					/>
				</div>
				<Facts
					rows={[
						["Canonical revision", snapshot.cutover.canonical_revision],
						["Failed gates", snapshot.cutover.failed_gates.length],
						[
							"Rollback",
							snapshot.cutover.rollback_available ? "Available" : "Not active",
						],
					]}
				/>
				{snapshot.cutover.failed_gates.length ? (
					<InlineAlert tone="warning">
						C4 remains blocked: {snapshot.cutover.failed_gates.join(", ")}.
						Resolve the named server gates and preview again.
					</InlineAlert>
				) : null}
				<div className={styles.actions}>
					{!["soaking", "stable", "rollback_required"].includes(
						snapshot.cutover.status,
					) ? (
						<Button
							isDisabled={command.isPending}
							onPress={() =>
								void preview(
									{
										kind: "cutover.preview",
										idempotency_key: idempotencyKey("cutover-preview"),
									},
									(hash) => ({
										kind: "cutover.apply",
										plan_hash: hash,
										confirm: true,
										idempotency_key: idempotencyKey("cutover-apply"),
									}),
									"Apply canonical C4 cutover",
									"Recheck the exact preflight, checkpoint both authorities, fence legacy writers, and atomically enter the soak window.",
									snapshot.cutover.failed_gates.length > 0,
								)
							}
							variant="primary"
						>
							Preview C4 cutover
						</Button>
					) : null}
					{snapshot.cutover.status === "soaking" ? (
						<Button
							onPress={() =>
								confirmRollback(
									"Complete cutover soak",
									"Recheck health, parity, backlog, and owner uniqueness before marking C4 stable.",
									{
										kind: "cutover.soak",
										confirm: true,
										idempotency_key: idempotencyKey("cutover-soak"),
									},
									["cutover:soak"],
								)
							}
							variant="secondary"
						>
							Complete soak
						</Button>
					) : null}
					{snapshot.cutover.rollback_available ? (
						<Button
							onPress={() =>
								confirmRollback(
									"Roll back canonical cutover",
									"Audit and preserve canonical facts, then atomically restore the C3 authority pointer.",
									{
										kind: "cutover.rollback",
										confirm: true,
										idempotency_key: idempotencyKey("cutover-rollback"),
									},
									["cutover:authority", "cutover:rollback-audit"],
								)
							}
							variant="danger"
						>
							Roll back C4
						</Button>
					) : null}
				</div>
			</section>

			<section className={styles.card}>
				<h2>Settings audit</h2>
				{snapshot.audit.length ? (
					<ol className={styles.audit}>
						{snapshot.audit.map((entry) => (
							<li key={entry.command_id}>
								<div>
									<strong>{entry.command_kind}</strong>
									<small>{entry.command_id}</small>
								</div>
								<StatusBadge
									label={entry.status}
									tone={statusTone(entry.status)}
								/>
							</li>
						))}
					</ol>
				) : (
					<p>No settings commands have been recorded.</p>
				)}
			</section>
		</div>
	);

	return (
		<section className={styles.route} data-testid="settings-controls">
			<SettingsHeader
				onRefresh={() => void refresh()}
				refreshing={command.isPending}
				revision={snapshot.revision}
			/>
			{notice ? <Toast tone="info">{notice}</Toast> : null}
			{command.isError ? (
				<InlineAlert tone="danger">
					The last command was rejected. No secret or raw configuration value
					was returned.
				</InlineAlert>
			) : null}
			<OperatorTabs
				onSelectionChange={setSelectedTab}
				selectedKey={selectedTab}
				tabs={[
					{ id: "service", label: "Service & renders", panel: servicePanel },
					{
						id: "capabilities",
						label: "Capabilities & providers",
						panel: capabilitiesPanel,
					},
					{ id: "presets", label: "Presets", panel: presetsPanel },
					{
						id: "migration",
						label: "Migration & audit",
						panel: migrationPanel,
					},
				]}
			/>

			<DialogSurface
				isOpen={confirmation !== null}
				onOpenChange={(open) => !open && setConfirmation(null)}
				title={confirmation?.title ?? "Confirm settings command"}
			>
				<div className={styles.dialogBody}>
					<p>{confirmation?.description}</p>
					{confirmation?.planHash ? (
						<code>Plan {confirmation.planHash.slice(0, 23)}…</code>
					) : null}
					{confirmation?.affected.length ? (
						<>
							<h3>Affected managed resources</h3>
							<ul>
								{confirmation.affected.slice(0, 12).map((entry) => (
									<li key={entry}>{entry}</li>
								))}
							</ul>
						</>
					) : null}
					{confirmation?.blocked ? (
						<InlineAlert tone="warning">
							This plan is review-blocked and cannot be applied from the
							settings surface.
						</InlineAlert>
					) : null}
					<div className={styles.actions}>
						<Button onPress={() => setConfirmation(null)} variant="secondary">
							Cancel
						</Button>
						<Button
							isDisabled={Boolean(confirmation?.blocked)}
							loading={command.isPending}
							onPress={() => void applyConfirmation()}
							variant="primary"
						>
							Confirm exact plan
						</Button>
					</div>
				</div>
			</DialogSurface>
		</section>
	);
}

export function SettingsRoute() {
	const settings = useSettingsSnapshot();
	if (settings.isPending)
		return (
			<section className={styles.loading} aria-label="Loading settings">
				<Skeleton width="16rem" />
				<Skeleton />
				<Skeleton />
			</section>
		);
	if (settings.isError || !settings.data)
		return (
			<StatePanel
				description="The bounded settings authority could not be loaded. No legacy settings data was substituted."
				kind="error"
				title="Settings unavailable"
			/>
		);
	return <SettingsContent snapshot={settings.data} />;
}
