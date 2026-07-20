import { ThemeProvider } from "@golem/ui";
import { createRoot } from "react-dom/client";
import "@golem/ui/tokens.css";

import { DesignLab } from "./design-lab/index.js";
import "./design-lab/design-lab.module.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (root)
	createRoot(root).render(
		<ThemeProvider>
			<DesignLab />
		</ThemeProvider>,
	);
