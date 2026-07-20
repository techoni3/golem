import * as React from "react";

export const themeStorageKey = "golem.ui.theme";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = Exclude<ThemePreference, "system">;

function isThemePreference(value: string | null): value is ThemePreference {
	return value === "system" || value === "light" || value === "dark";
}

function systemTheme(): ResolvedTheme {
	return window.matchMedia("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light";
}

export function readThemePreference(): ThemePreference {
	if (typeof window === "undefined") return "system";
	const stored = window.localStorage.getItem(themeStorageKey);
	return isThemePreference(stored) ? stored : "system";
}

export function applyThemePreference(
	preference: ThemePreference,
): ResolvedTheme {
	const resolved = preference === "system" ? systemTheme() : preference;
	document.documentElement.dataset.theme = resolved;
	document.documentElement.dataset.themePreference = preference;
	document.documentElement.style.colorScheme = resolved;
	return resolved;
}

export const themeBootstrapScript = `(() => {
  const key = ${JSON.stringify(themeStorageKey)};
  const stored = window.localStorage.getItem(key);
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
		sync();
		media.addEventListener("change", sync);
		return () => media.removeEventListener("change", sync);
	}, [preference]);

	const setPreference = React.useCallback((next: ThemePreference) => {
		window.localStorage.setItem(themeStorageKey, next);
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
