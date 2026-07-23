import type {
	BrowserControlPlaneClient,
	BrowserSettingsCommandRequest,
} from "@golem/api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

const settingsKey = ["browser-settings", "snapshot"] as const;

type SettingsDataContextValue = Readonly<{
	client: BrowserControlPlaneClient;
	enabled: boolean;
}>;

const SettingsDataContext = React.createContext<
	SettingsDataContextValue | undefined
>(undefined);

export function SettingsDataProvider({
	children,
	client,
	enabled,
}: React.PropsWithChildren<{
	readonly client: BrowserControlPlaneClient;
	readonly enabled: boolean;
}>) {
	const value = React.useMemo(() => ({ client, enabled }), [client, enabled]);
	return (
		<SettingsDataContext.Provider value={value}>
			{children}
		</SettingsDataContext.Provider>
	);
}

function useSettingsData(): SettingsDataContextValue {
	const context = React.useContext(SettingsDataContext);
	if (!context)
		throw new Error("settings route rendered outside SettingsDataProvider");
	return context;
}

export function useSettingsSnapshot() {
	const { client, enabled } = useSettingsData();
	return useQuery({
		queryKey: settingsKey,
		queryFn: () => client.browserSettings(),
		enabled,
		retry: 1,
		staleTime: 15_000,
	});
}

export function useSettingsCommand() {
	const { client } = useSettingsData();
	const queryClient = useQueryClient();
	return useMutation({
		retry: false,
		mutationFn: (command: BrowserSettingsCommandRequest) =>
			client.browserSettingsCommand(command),
		onSettled: () =>
			queryClient.invalidateQueries({
				queryKey: settingsKey,
			}),
	});
}

export function useRefreshSettings() {
	const queryClient = useQueryClient();
	return React.useCallback(
		() => queryClient.invalidateQueries({ queryKey: settingsKey }),
		[queryClient],
	);
}
