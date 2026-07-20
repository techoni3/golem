import {
	ActionMenu,
	Button,
	Checkbox,
	ChoiceList,
	ComboBox,
	DialogSurface,
	Drawer,
	Hint,
	InlineAlert,
	Link,
	OperatorTable,
	OperatorTabs,
	PassportCard,
	SearchField,
	Select,
	Skeleton,
	StatePanel,
	StatusBadge,
	Switch,
	TextField,
	Toast,
	useTheme,
} from "@golem/ui";
import * as React from "react";

import styles from "./design-lab.module.css";

const themeOptions = [
	{ id: "system", label: "System" },
	{ id: "light", label: "Light" },
	{ id: "dark", label: "Dark" },
] as const;

const roleOptions = [
	{ id: "operator", label: "Operator" },
	{ id: "reviewer", label: "Reviewer" },
	{ id: "explorer", label: "Explorer" },
] as const;

const queueOptions = [
	{ id: "ready", label: "Ready queue" },
	{ id: "review", label: "Review queue" },
] as const;

export function DesignLab() {
	const { preference, setPreference } = useTheme();
	const [dialogOpen, setDialogOpen] = React.useState(false);
	const [drawerOpen, setDrawerOpen] = React.useState(false);
	const [activeTab, setActiveTab] = React.useState("foundation");
	const [role, setRole] = React.useState("operator");
	const [cardActivations, setCardActivations] = React.useState(0);
	const [choice, setChoice] = React.useState("ready");
	const [notify, setNotify] = React.useState(false);
	const [switchEnabled, setSwitchEnabled] = React.useState(false);
	const dialogTrigger = React.useRef<HTMLElement | null>(null);
	const drawerTrigger = React.useRef<HTMLElement | null>(null);

	return (
		<main className={styles.lab} data-testid="design-lab">
			<header className={styles.hero}>
				<div>
					<p className={styles.eyebrow}>Golem interface foundation</p>
					<h1>Semantic tokens and accessible primitives</h1>
					<p>
						A local component lab for keyboard, focus, state, and responsive
						containment behavior. It does not replace a production dashboard
						page.
					</p>
				</div>
				<Select
					label="Theme preference"
					onChange={(value) =>
						setPreference(value as "system" | "light" | "dark")
					}
					options={themeOptions}
					testId="theme-select"
					value={preference}
				/>
			</header>

			<OperatorTabs
				onSelectionChange={setActiveTab}
				selectedKey={activeTab}
				tabs={[
					{
						id: "foundation",
						label: "Foundation",
						panel: (
							<Foundation
								dialogTrigger={dialogTrigger}
								drawerTrigger={drawerTrigger}
								notify={notify}
								onDialogOpen={() => setDialogOpen(true)}
								onDrawerOpen={() => setDrawerOpen(true)}
								onNotifyChange={setNotify}
								onRoleChange={setRole}
								onSwitchChange={setSwitchEnabled}
								role={role}
								switchEnabled={switchEnabled}
							/>
						),
					},
					{
						id: "states",
						label: "States",
						panel: <States choice={choice} onChoiceChange={setChoice} />,
					},
					{ id: "keyboard", label: "Keyboard", panel: <Keyboard /> },
				]}
			/>

			<section className={styles.section} aria-labelledby="passport-heading">
				<div className={styles.sectionHeading}>
					<div>
						<p className={styles.eyebrow}>Responsive containment</p>
						<h2 id="passport-heading">Passport card</h2>
					</div>
					<output data-testid="passport-open-count">{cardActivations}</output>
				</div>
				<PassportCard
					onOpen={() => setCardActivations((count) => count + 1)}
					onRoleChange={setRole}
					role={role}
					roleOptions={roleOptions}
				/>
			</section>

			{notify ? <Toast tone="success">Preference saved locally.</Toast> : null}
			<DialogSurface
				isOpen={dialogOpen}
				onOpenChange={setDialogOpen}
				returnFocusRef={dialogTrigger}
				title="Keyboard dialog"
			>
				<p>Escape returns focus to the dialog trigger.</p>
				<Button onPress={() => setDialogOpen(false)} variant="primary">
					Close dialog
				</Button>
			</DialogSurface>
			<Drawer
				isOpen={drawerOpen}
				onOpenChange={setDrawerOpen}
				returnFocusRef={drawerTrigger}
				title="Operator drawer"
			>
				<p>A bounded overlay with a labeled close action.</p>
				<Button onPress={() => setDrawerOpen(false)}>Close drawer</Button>
			</Drawer>
		</main>
	);
}

function Foundation({
	dialogTrigger,
	drawerTrigger,
	notify,
	onDialogOpen,
	onDrawerOpen,
	onNotifyChange,
	onRoleChange,
	onSwitchChange,
	role,
	switchEnabled,
}: {
	dialogTrigger: React.RefObject<HTMLElement | null>;
	drawerTrigger: React.RefObject<HTMLElement | null>;
	notify: boolean;
	onDialogOpen: () => void;
	onDrawerOpen: () => void;
	onNotifyChange: (value: boolean) => void;
	onRoleChange: (value: string) => void;
	onSwitchChange: (value: boolean) => void;
	role: string;
	switchEnabled: boolean;
}) {
	return (
		<section className={styles.grid} aria-label="Foundation primitives">
			<div className={styles.group}>
				<h2>Actions and overlays</h2>
				<div className={styles.actions}>
					<Button
						id="dialog-trigger"
						onFocus={(event) => {
							if (event.currentTarget instanceof HTMLElement)
								dialogTrigger.current = event.currentTarget;
						}}
						onPress={onDialogOpen}
						variant="primary"
					>
						Open dialog
					</Button>
					<Button
						id="drawer-trigger"
						onFocus={(event) => {
							if (event.currentTarget instanceof HTMLElement)
								drawerTrigger.current = event.currentTarget;
						}}
						onPress={onDrawerOpen}
					>
						Open drawer
					</Button>
					<ActionMenu
						triggerId="menu-trigger"
						onAction={() => onNotifyChange(true)}
					/>
					<Hint>Uses the same semantic focus ring.</Hint>
				</div>
				<div className={styles.actions}>
					<Button loading>Loading action</Button>
					<Button isDisabled>Unavailable action</Button>
					<Link href="#passport-heading">Passport card anchor</Link>
				</div>
			</div>
			<div className={styles.group}>
				<h2>Inputs</h2>
				<TextField
					description="Visible text label and description."
					label="Queue name"
					placeholder="night-shift"
				/>
				<TextField
					errorMessage="Queue name is required."
					isInvalid
					label="Required queue"
				/>
				<SearchField label="Search sessions" placeholder="Find a session" />
				<ComboBox
					label="Assign role"
					onChange={onRoleChange}
					options={roleOptions}
					value={role}
				/>
				<Checkbox
					isSelected={notify}
					label="Show confirmation toast"
					onChange={onNotifyChange}
				/>
				<Switch
					isSelected={switchEnabled}
					label="Compact density"
					onChange={onSwitchChange}
				/>
			</div>
		</section>
	);
}

function States({
	choice,
	onChoiceChange,
}: {
	choice: string;
	onChoiceChange: (value: string) => void;
}) {
	return (
		<section className={styles.grid} aria-label="State primitives">
			<div className={styles.group}>
				<h2>State communication</h2>
				<div className={styles.badges}>
					<StatusBadge label="Ready" tone="success" />
					<StatusBadge label="Waiting" tone="warning" />
					<StatusBadge label="Blocked" tone="danger" />
					<StatusBadge label="Running" tone="info" />
				</div>
				<InlineAlert tone="warning">
					Doctor reports a local-only compatibility check.
				</InlineAlert>
				<Skeleton width="100%" />
				<StatePanel
					description="No operator task matches the current view."
					kind="empty"
					title="No queued work"
				/>
				<StatePanel
					description="The last status refresh could not be completed."
					kind="error"
					title="Queue unavailable"
				/>
				<StatePanel
					description="No live transport is started by this design lab."
					kind="disconnected"
					title="Connection paused"
				/>
			</div>
			<div className={styles.group}>
				<h2>Selectable work</h2>
				<ChoiceList
					onChange={onChoiceChange}
					options={queueOptions}
					selectedKey={choice}
				/>
				<OperatorTable />
			</div>
		</section>
	);
}

function Keyboard() {
	return (
		<section className={styles.group} aria-label="Keyboard contracts">
			<h2>Keyboard contracts</h2>
			<ul className={styles.contracts}>
				<li>
					Tab controls work in order; arrow keys switch the primitive sections.
				</li>
				<li>
					Menu, dialog, and drawer close with Escape and restore the trigger
					focus.
				</li>
				<li>
					Theme, role, and state controls expose visible labels and selected
					values.
				</li>
				<li>
					Motion is disabled when the operating system requests reduced motion.
				</li>
			</ul>
		</section>
	);
}
