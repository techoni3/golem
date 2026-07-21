import { ThemeProvider } from "@golem/ui";
import { createRoot } from "react-dom/client";
import * as React from "react";
import "@golem/ui/tokens.css";

import { DesignLab } from "../../../../apps/dashboard/src/design-lab/index.js";

const root = document.querySelector<HTMLDivElement>("#root");
if (root)
	createRoot(root).render(
		<ThemeProvider>
			<DesignLab />
		</ThemeProvider>,
	);
