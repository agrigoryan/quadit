// The setup page (src/main/setup-page.ts): five steps, each showing
// where it stands and each skippable.

import { button, element, make } from "@/pages/dom";
import type { PagesApi, SetupState } from "@/shared/pages-api";

const api = window.quaditPages as PagesApi;
const servers = element<HTMLUListElement>("servers");
const signIn = element<HTMLUListElement>("sign-in");
const form = element<HTMLFormElement>("add");
const addError = element<HTMLParagraphElement>("add-error");
const shortcut = element<HTMLInputElement>("shortcut");
const shortcutLabel = element<HTMLSpanElement>("shortcut-label");
const shortcutError = element<HTMLParagraphElement>("shortcut-error");
const settingsButton = element<HTMLButtonElement>("notification-settings");

/** An Electron accelerator as this system writes keys: ⌥⌘N on a Mac, Ctrl+Alt+N elsewhere. */
function keyName(accelerator: string): string {
  const mac = navigator.userAgent.includes("Mac");
  const words: Record<string, string> = mac
    ? { Alt: "⌥", CommandOrControl: "⌘", Shift: "⇧" }
    : { Alt: "Alt+", CommandOrControl: "Ctrl+", Shift: "Shift+" };
  const parts = accelerator.split("+");
  const key = parts.pop() ?? "";
  return parts.map((p) => words[p] ?? `${p}+`).join("") + key;
}

function showState(state: SetupState) {
  shortcut.checked = state.captureShortcut;
  shortcutLabel.textContent = `Open quick capture from anywhere with ${keyName(state.shortcut)}`;
  shortcutError.textContent = state.captureShortcut ? (state.shortcutError ?? "") : "";
}

async function render() {
  const [list, state] = await Promise.all([api.listServers(), api.setupState()]);
  servers.replaceChildren(
    ...list.map((server) => {
      const row = make("li", "", "item");
      row.append(make("strong", server.name), make("span", `${server.origin} · added`, "status"));
      return row;
    }),
  );
  signIn.replaceChildren(
    ...list.map((server) => {
      const row = make("li", "", "item");
      const done = state.signedIn.includes(server.id);
      row.append(make("strong", server.name));
      if (done) row.append(make("span", "Signed in", "status"));
      else
        row.append(button("Sign in with browser", () => void api.signIn(server.id), "", `Sign in to ${server.name}`));
      return row;
    }),
  );
  if (list.length === 0) signIn.append(make("li", "Add a server first.", "hint"));
  showState(state);
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const address = (form.elements.namedItem("address") as HTMLInputElement).value;
  addError.textContent = "";
  void api.addServer(address, "").then((result) => {
    if (result.ok) form.reset();
    else addError.textContent = result.error;
  });
});
element("test-notification").addEventListener("click", () => void api.testNotification());
settingsButton.addEventListener("click", () => {
  void api.openNotificationSettings().then((opened) => {
    if (!opened) {
      settingsButton.disabled = true;
      settingsButton.textContent = "Open your desktop's notification settings";
    }
  });
});
element("connect").addEventListener("click", () => void api.openConnect());
shortcut.addEventListener("change", () => void api.saveSetup({ captureShortcut: shortcut.checked }).then(showState));
element("done").addEventListener("click", () => window.close());

api.onChanged(() => void render());
void render();
