import * as React from "react";

export const themeStorageKey = "golem.ui.theme";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = Exclude<ThemePreference, "system">;

function isThemePreference(value: string | null): value is ThemePreference {
	return value === "system" || value === "light" || value === "dark";
}

function systemTheme(): ResolvedTheme {
	if (typeof window === "undefined") return "light";
	return window.matchMedia("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light";
}

export function readThemePreference(): ThemePreference {
	if (typeof window === "undefined") return "system";
	try {
		const stored = window.localStorage.getItem(themeStorageKey);
		return isThemePreference(stored) ? stored : "system";
	} catch {
		return "system";
	}
}

export function applyThemePreference(
	preference: ThemePreference,
): ResolvedTheme {
	const resolved = preference === "system" ? systemTheme() : preference;
	if (typeof document !== "undefined") {
		document.documentElement.dataset.theme = resolved;
		document.documentElement.dataset.themePreference = preference;
		document.documentElement.style.colorScheme = resolved;
	}
	return resolved;
}

export const themeBootstrapScript = `(() => {
  const key = ${JSON.stringify(themeStorageKey)};
  let stored = null;
  try { stored = window.localStorage.getItem(key); } catch {}
  const preference = stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  const resolved = preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : preference === "system" ? "light" : preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = resolved;
})();`;

type ThemeContextValue = {
	preference: ThemePreference;
	resolvedTheme: ResolvedTheme;
	setPreference: (preference: ThemePreference) => void;
};

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: React.PropsWithChildren) {
	const [preference, setPreferenceState] =
		React.useState<ThemePreference>(readThemePreference);
	const [resolvedTheme, setResolvedTheme] = React.useState<ResolvedTheme>(() =>
		applyThemePreference(readThemePreference()),
	);

	React.useEffect(() => {
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const sync = () => setResolvedTheme(applyThemePreference(preference));
		const syncStorage = (event: StorageEvent) => {
			if (event.key !== themeStorageKey) return;
			const next = isThemePreference(event.newValue)
				? event.newValue
				: "system";
			setPreferenceState(next);
		};
		sync();
		media.addEventListener("change", sync);
		window.addEventListener("storage", syncStorage);
		return () => {
			media.removeEventListener("change", sync);
			window.removeEventListener("storage", syncStorage);
		};
	}, [preference]);

	const setPreference = React.useCallback((next: ThemePreference) => {
		try {
			window.localStorage.setItem(themeStorageKey, next);
		} catch {
			// Sandboxed or privacy-restricted browsers still receive the in-memory
			// preference for this document.
		}
		setPreferenceState(next);
	}, []);

	return (
		<ThemeContext.Provider value={{ preference, resolvedTheme, setPreference }}>
			{children}
		</ThemeContext.Provider>
	);
}

export function useTheme(): ThemeContextValue {
	const value = React.useContext(ThemeContext);
	if (!value) throw new Error("useTheme must be used inside ThemeProvider");
	return value;
}
