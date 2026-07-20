import * as React from "react";
import {
	Button as AriaButton,
	Checkbox as AriaCheckbox,
	ComboBox as AriaComboBox,
	Link as AriaLink,
	SearchField as AriaSearchField,
	Select as AriaSelect,
	Switch as AriaSwitch,
	TextField as AriaTextField,
	Cell,
	Column,
	ComboBoxValue,
	Dialog,
	FieldError,
	Input,
	Label,
	ListBox,
	ListBoxItem,
	Menu,
	MenuItem,
	MenuTrigger,
	Modal,
	ModalOverlay,
	Popover,
	Row,
	SelectValue,
	Tab,
	TabList,
	Table,
	TableBody,
	TableHeader,
	TabPanel,
	TabPanels,
	Tabs,
	Text,
	Tooltip,
	TooltipTrigger,
} from "react-aria-components";

import styles from "./primitives.module.css";

type Tone = "accent" | "neutral" | "success" | "warning" | "danger" | "info";
type Option = { id: string; label: string; description?: string };

const buttonClass = {
	danger: styles.buttondanger,
	primary: styles.buttonprimary,
	quiet: styles.buttonquiet,
	secondary: styles.buttonsecondary,
};

const toneClass = {
	accent: styles.toneaccent,
	danger: styles.tonedanger,
	info: styles.toneinfo,
	neutral: styles.toneneutral,
	success: styles.tonesuccess,
	warning: styles.tonewarning,
};

function classes(...values: Array<string | undefined | false>) {
	return values.filter(Boolean).join(" ");
}

function stopCardActivation(event: React.SyntheticEvent) {
	event.stopPropagation();
}

export type ButtonProps = Omit<
	React.ComponentProps<typeof AriaButton>,
	"className" | "children"
> & {
	children: React.ReactNode;
	loading?: boolean;
	variant?: "primary" | "secondary" | "quiet" | "danger";
};

export function Button({
	children,
	loading = false,
	variant = "secondary",
	isDisabled,
	...props
}: ButtonProps) {
	return (
		<AriaButton
			{...props}
			className={classes(styles.button, buttonClass[variant])}
			isDisabled={isDisabled || loading}
		>
			{loading ? "Loading…" : children}
		</AriaButton>
	);
}

export type IconButtonProps = Omit<ButtonProps, "children"> & {
	children: React.ReactNode;
	"aria-label": string;
};

export function IconButton({ children, ...props }: IconButtonProps) {
	return (
		<Button {...props}>
			<span aria-hidden="true">{children}</span>
		</Button>
	);
}

export function Link({
	children,
	...props
}: Omit<React.ComponentProps<typeof AriaLink>, "className">) {
	return (
		<AriaLink {...props} className={styles.link}>
			{children}
		</AriaLink>
	);
}

type FieldProps = {
	description?: string;
	errorMessage?: string;
	id?: string;
	isDisabled?: boolean;
	isInvalid?: boolean;
	label: string;
	name?: string;
	onChange?: (value: string) => void;
	placeholder?: string;
	value?: string;
};

export function TextField({
	description,
	errorMessage,
	isInvalid = false,
	label,
	...props
}: FieldProps) {
	return (
		<AriaTextField
			{...props}
			className={styles.field}
			isInvalid={isInvalid || Boolean(errorMessage)}
		>
			<Label>{label}</Label>
			<Input className={styles.input} />
			{description ? (
				<Text className={styles.description} slot="description">
					{description}
				</Text>
			) : null}
			{errorMessage ? (
				<FieldError className={styles.error}>{errorMessage}</FieldError>
			) : null}
		</AriaTextField>
	);
}

export function SearchField({
	description,
	errorMessage,
	isInvalid = false,
	label,
	...props
}: FieldProps) {
	return (
		<AriaSearchField
			{...props}
			className={styles.field}
			isInvalid={isInvalid || Boolean(errorMessage)}
		>
			<Label>{label}</Label>
			<Input className={styles.input} />
			{description ? (
				<Text className={styles.description} slot="description">
					{description}
				</Text>
			) : null}
			{errorMessage ? (
				<FieldError className={styles.error}>{errorMessage}</FieldError>
			) : null}
		</AriaSearchField>
	);
}

type SelectProps = {
	disabled?: boolean;
	label: string;
	onChange: (value: string) => void;
	options: readonly Option[];
	testId?: string;
	value: string;
};

export function Select({
	disabled = false,
	label,
	onChange,
	options,
	testId,
	value,
}: SelectProps) {
	return (
		<AriaSelect
			className={styles.field}
			data-testid={testId}
			isDisabled={disabled}
			onSelectionChange={(key) => onChange(String(key))}
			selectedKey={value}
		>
			<Label>{label}</Label>
			<AriaButton className={styles.selectButton}>
				<SelectValue />
				<span aria-hidden="true">▾</span>
			</AriaButton>
			<Popover className={styles.popover}>
				<ListBox className={styles.listBox}>
					{options.map((option) => (
						<ListBoxItem
							id={option.id}
							key={option.id}
							textValue={option.label}
						>
							<span>{option.label}</span>
							{option.description ? <small>{option.description}</small> : null}
						</ListBoxItem>
					))}
				</ListBox>
			</Popover>
		</AriaSelect>
	);
}

export function ComboBox({
	label,
	onChange,
	options,
	value,
}: Omit<SelectProps, "disabled" | "testId">) {
	return (
		<AriaComboBox
			className={styles.field}
			onSelectionChange={(key) => onChange(String(key))}
			selectedKey={value}
		>
			<Label>{label}</Label>
			<div className={styles.comboRow}>
				<Input className={styles.input} />
				<AriaButton className={styles.selectButton}>
					<ComboBoxValue />
					<span aria-hidden="true">▾</span>
				</AriaButton>
			</div>
			<Popover className={styles.popover}>
				<ListBox className={styles.listBox}>
					{options.map((option) => (
						<ListBoxItem
							id={option.id}
							key={option.id}
							textValue={option.label}
						>
							{option.label}
						</ListBoxItem>
					))}
				</ListBox>
			</Popover>
		</AriaComboBox>
	);
}

type ToggleProps = {
	disabled?: boolean;
	isSelected: boolean;
	label: string;
	onChange: (value: boolean) => void;
};

export function Checkbox({
	disabled = false,
	isSelected,
	label,
	onChange,
}: ToggleProps) {
	return (
		<AriaCheckbox
			className={styles.toggle}
			isDisabled={disabled}
			isSelected={isSelected}
			onChange={onChange}
		>
			<span aria-hidden="true" className={styles.checkboxMark}>
				✓
			</span>
			{label}
		</AriaCheckbox>
	);
}

export function Switch({
	disabled = false,
	isSelected,
	label,
	onChange,
}: ToggleProps) {
	return (
		<AriaSwitch
			className={styles.switch}
			isDisabled={disabled}
			isSelected={isSelected}
			onChange={onChange}
		>
			<span aria-hidden="true" className={styles.switchTrack} />
			{label}
		</AriaSwitch>
	);
}

export function OperatorTabs({
	selectedKey,
	onSelectionChange,
	tabs,
}: {
	onSelectionChange: (key: string) => void;
	selectedKey: string;
	tabs: readonly { id: string; label: string; panel: React.ReactNode }[];
}) {
	return (
		<Tabs
			className={styles.tabs}
			onSelectionChange={(key) => onSelectionChange(String(key))}
			selectedKey={selectedKey}
		>
			<TabList aria-label="Design lab sections" className={styles.tabList}>
				{tabs.map((tab) => (
					<Tab id={tab.id} key={tab.id}>
						{tab.label}
					</Tab>
				))}
			</TabList>
			<TabPanels className={styles.tabPanels}>
				{tabs.map((tab) => (
					<TabPanel id={tab.id} key={tab.id}>
						{tab.panel}
					</TabPanel>
				))}
			</TabPanels>
		</Tabs>
	);
}

type OverlayProps = {
	children: React.ReactNode;
	isOpen: boolean;
	onOpenChange: (isOpen: boolean) => void;
	returnFocusRef?: React.RefObject<HTMLElement | null>;
	title: string;
};

function Overlay({
	children,
	isOpen,
	onOpenChange,
	returnFocusRef,
	title,
	drawer = false,
}: OverlayProps & { drawer?: boolean }) {
	const returnFocus = React.useRef<HTMLElement | null>(null);
	// Overlays can mount from a resumable URL already open. Start closed so
	// that first render captures the invoking element as well as later opens.
	const wasOpen = React.useRef(false);
	if (isOpen && !wasOpen.current) {
		returnFocus.current =
			returnFocusRef?.current ??
			(document.activeElement instanceof HTMLElement
				? document.activeElement
				: null);
		wasOpen.current = true;
	}

	React.useEffect(() => {
		if (!isOpen && wasOpen.current && returnFocus.current?.isConnected) {
			const trigger = returnFocus.current;
			const frame = requestAnimationFrame(() => trigger.focus());
			wasOpen.current = isOpen;
			return () => cancelAnimationFrame(frame);
		}
		wasOpen.current = isOpen;
	}, [isOpen]);

	return (
		<ModalOverlay
			className={styles.modalOverlay}
			isOpen={isOpen}
			onOpenChange={onOpenChange}
		>
			<Modal className={classes(styles.modal, drawer && styles.drawer)}>
				<Dialog aria-label={title} className={styles.dialog}>
					<header>
						<h2>{title}</h2>
						<Button
							aria-label={`Close ${title}`}
							onPress={() => onOpenChange(false)}
							variant="quiet"
						>
							×
						</Button>
					</header>
					{children}
				</Dialog>
			</Modal>
		</ModalOverlay>
	);
}

export function DialogSurface(props: OverlayProps) {
	return <Overlay {...props} />;
}

export function Drawer(props: OverlayProps) {
	return <Overlay {...props} drawer />;
}

export function ActionMenu({
	onAction,
	triggerId,
}: {
	onAction: (key: string) => void;
	triggerId?: string;
}) {
	return (
		<MenuTrigger>
			<Button {...(triggerId ? { id: triggerId } : {})} variant="secondary">
				Actions
			</Button>
			<Popover className={styles.popover}>
				<Menu
					aria-label="Actions"
					className={styles.menu}
					onAction={(key) => onAction(String(key))}
				>
					<MenuItem id="open">Open details</MenuItem>
					<MenuItem id="archive">Archive draft</MenuItem>
				</Menu>
			</Popover>
		</MenuTrigger>
	);
}

export function Hint({ children }: { children: React.ReactNode }) {
	return (
		<TooltipTrigger delay={0}>
			<Button aria-label="More information" variant="quiet">
				?
			</Button>
			<Tooltip className={styles.tooltip}>{children}</Tooltip>
		</TooltipTrigger>
	);
}

export function Toast({
	children,
	tone = "info",
}: {
	children: React.ReactNode;
	tone?: Tone;
}) {
	return (
		<div className={classes(styles.toast, toneClass[tone])} role="status">
			{children}
		</div>
	);
}

export function InlineAlert({
	children,
	tone = "info",
}: {
	children: React.ReactNode;
	tone?: Tone;
}) {
	return (
		<div className={classes(styles.alert, toneClass[tone])} role="alert">
			<span aria-hidden="true">
				{tone === "danger" ? "×" : tone === "warning" ? "!" : "i"}
			</span>
			{children}
		</div>
	);
}

export function ChoiceList({
	onChange,
	options,
	selectedKey,
}: {
	onChange: (key: string) => void;
	options: readonly Option[];
	selectedKey: string;
}) {
	return (
		<ListBox
			aria-label="Queue choices"
			className={styles.listBox}
			onSelectionChange={(keys) => {
				const key = [...keys][0];
				if (key) onChange(String(key));
			}}
			selectedKeys={[selectedKey]}
			selectionMode="single"
		>
			{options.map((option) => (
				<ListBoxItem id={option.id} key={option.id} textValue={option.label}>
					{option.label}
				</ListBoxItem>
			))}
		</ListBox>
	);
}

export function OperatorTable() {
	return (
		<Table aria-label="Operator status" className={styles.table}>
			<TableHeader>
				<Column isRowHeader>Session</Column>
				<Column>Delivery</Column>
			</TableHeader>
			<TableBody>
				<Row id="primary">
					<Cell>Primary session</Cell>
					<Cell>Ready</Cell>
				</Row>
			</TableBody>
		</Table>
	);
}

export function StatusBadge({
	detail,
	label,
	tone = "info",
}: {
	detail?: string;
	label: string;
	tone?: Tone;
}) {
	const symbol =
		tone === "success"
			? "✓"
			: tone === "warning"
				? "!"
				: tone === "danger"
					? "×"
					: "i";
	return (
		<span className={classes(styles.badge, toneClass[tone])}>
			<span aria-hidden="true">{symbol}</span>
			<span>{label}</span>
			{detail ? <small>{detail}</small> : null}
		</span>
	);
}

export function Skeleton({ width = "100%" }: { width?: string }) {
	return (
		<span
			aria-label="Loading"
			className={styles.skeleton}
			role="status"
			style={{ width }}
		/>
	);
}

export function StatePanel({
	description,
	kind,
	title,
}: {
	description: string;
	kind: "empty" | "error" | "disconnected";
	title: string;
}) {
	const tone =
		kind === "error"
			? "danger"
			: kind === "disconnected"
				? "warning"
				: "neutral";
	return (
		<section className={classes(styles.statePanel, toneClass[tone])}>
			<strong>{title}</strong>
			<p>{description}</p>
		</section>
	);
}

export function PassportCard({
	onOpen,
	onRoleChange,
	role,
	roleOptions,
}: {
	onOpen: () => void;
	onRoleChange: (role: string) => void;
	role: string;
	roleOptions: readonly Option[];
}) {
	return (
		<article className={styles.passport} data-testid="passport-card">
			<Button
				aria-label="Open primary session details"
				data-testid="passport-surface"
				onPress={onOpen}
				variant="quiet"
			>
				<span className={styles.srOnly}>Open primary session details</span>
			</Button>
			<div className={styles.passportContent}>
				<div>
					<StatusBadge
						detail="Claude · ready"
						label="Primary session"
						tone="success"
					/>
					<h3>Control-plane steward</h3>
					<p>Live session · delivery ready</p>
				</div>
				<fieldset
					aria-label="Role controls"
					className={styles.passportRole}
					data-testid="passport-role"
					onClick={stopCardActivation}
					onKeyDown={stopCardActivation}
					onPointerDown={stopCardActivation}
				>
					<Select
						label="Role"
						onChange={onRoleChange}
						options={roleOptions}
						value={role}
					/>
				</fieldset>
			</div>
		</article>
	);
}
