import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app";
import { followWindowInset } from "@/lib/window-inset";
import { nameFirstStep } from "@/nav/place";
import { WindowStrip } from "@/ui/window-strip";
import "@/styles/index.css";

// Before the router reads the history: see nav/place.ts.
nameFirstStep();
// Before the first paint: the window may have no title bar.
followWindowInset();

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
    <WindowStrip />
  </StrictMode>,
);
