import { dashboardEntryPoint } from "./index.js";

const root = document.querySelector<HTMLDivElement>("#root");
if (root) root.textContent = dashboardEntryPoint;
