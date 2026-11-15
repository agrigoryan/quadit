import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app";
import { nameFirstStep } from "@/nav/place";
import "@/styles/index.css";

// Before the router reads the history: see nav/place.ts.
nameFirstStep();

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
