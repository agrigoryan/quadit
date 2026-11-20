// The server the app runs on this computer, as the server list and setup
// show it (src/main/local-server.ts): the choice to run it, and its state
// and controls once it is in the list.

import { button, make } from "@/pages/dom";
import type { LocalServerView, LocalState, PagesApi } from "@/shared/pages-api";

const api = window.quaditPages as PagesApi;

/** What a person should know about the server's state, in a line. */
export function describeLocal(state: LocalState): { text: string; warn: boolean } {
  switch (state.kind) {
    case "starting":
      return { text: "Starting…", warn: false };
    case "running":
      return { text: "Running on this computer while the app is open", warn: false };
    case "stopped":
      return { text: "Stopped", warn: true };
    case "failed":
      return { text: state.reason, warn: true };
  }
}

/**
 * The choice to run Quadit on this computer, under the page's own heading:
 * a button, or one sentence where this build cannot. Empty once the server
 * is in the list, where its row has its controls.
 */
export function runLocalChoice(view: LocalServerView): HTMLElement[] {
  if (view.serverId) return [];
  if (!view.available)
    return [
      make(
        "p",
        "Not available in this copy of the app: only the macOS and Linux apps carry a Quadit server to run.",
        "hint",
      ),
    ];
  const hint = make(
    "p",
    view.dataKept
      ? `Starts the server here again, with the data it kept in ${view.dataDir}.`
      : "No server to set up elsewhere: the app runs Quadit here, while it is open, for you and the agents on this computer.",
    "hint",
  );
  const error = make("p", "", "error");
  error.setAttribute("role", "alert");
  const run = button(
    "Run Quadit on this computer",
    () => {
      run.disabled = true;
      error.textContent = "";
      void api.runLocalServer().then((result) => {
        run.disabled = false;
        if (!result.ok) error.textContent = result.error;
      });
    },
    "primary",
  );
  return [hint, run, error];
}

/** The server's state, the reason and last log lines when it failed, and its controls. */
export function localDetails(view: LocalServerView): HTMLElement[] {
  const { state } = view;
  const said = describeLocal(state);
  const parts: HTMLElement[] = [make("span", said.text, said.warn ? "status warn" : "status")];
  if (state.kind === "failed" && state.log.length) {
    const log = make("pre", state.log.join("\n"), "diff");
    log.setAttribute("aria-label", "The server's last log lines");
    parts.push(log);
  }
  const up = state.kind === "starting" || state.kind === "running";
  const controls = make("div", "", "actions");
  const control = (text: string, which: "start" | "stop" | "restart", enabled: boolean) => {
    const made = button(text, () => void api.controlLocalServer(which), "", `${text} the server on this computer`);
    made.disabled = !enabled;
    return made;
  };
  controls.append(
    control("Start", "start", !up),
    control("Stop", "stop", up),
    control("Restart", "restart", state.kind === "running"),
    button("Show Data Folder", () => void api.showLocalServerFiles("data"), "quiet"),
    button("Show Log", () => void api.showLocalServerFiles("log"), "quiet"),
  );
  parts.push(controls);
  if (view.openAtLogin !== null) {
    const label = make("label", "", "check");
    const box = make("input");
    box.type = "checkbox";
    box.checked = view.openAtLogin;
    box.addEventListener("change", () => void api.setOpenAtLogin(box.checked));
    label.append(box, make("span", "Start Quadit when I log in, without a window"));
    parts.push(label);
  }
  return parts;
}
