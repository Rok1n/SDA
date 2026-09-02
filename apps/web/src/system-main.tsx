import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SystemMonitor } from "./SystemMonitor";
import "./system-monitor.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SystemMonitor />
  </StrictMode>,
);
