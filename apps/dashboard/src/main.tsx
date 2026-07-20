import { ThemeProvider } from "@golem/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import "@golem/ui/tokens.css";

import { DashboardShell } from "./shell.js";

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

const root = document.querySelector<HTMLDivElement>("#root");
if (root)
	createRoot(root).render(
		<QueryClientProvider client={queryClient}>
			<ThemeProvider>
				<DashboardShell />
			</ThemeProvider>
		</QueryClientProvider>,
	);
