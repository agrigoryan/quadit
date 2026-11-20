// Welcome (src/main/welcome-page.ts): set Quadit up on this computer with
// a name, or connect to a server elsewhere. It shows one of five things at
// a time: the name form, the start under way, why it failed, the address
// form, or, once set up where agent tools are found, the step that
// connects them; where the app has no server to run (Windows) only the
// address form.

import { button, element, make } from "@/pages/dom";
import type { FoundToolView, PagesApi } from "@/shared/pages-api";

const api = window.quaditPages as PagesApi;
const here = element<HTMLFormElement>("here");
const nameInput = here.elements.namedItem("name") as HTMLInputElement;
const nameError = element<HTMLParagraphElement>("name-error");
const kept = element<HTMLParagraphElement>("kept");
const progress = element<HTMLElement>("progress");
const failed = element<HTMLElement>("failed");
const failedReason = element<HTMLParagraphElement>("failed-reason");
const toConnect = element<HTMLButtonElement>("to-connect");
const connect = element<HTMLFormElement>("connect");
const address = connect.elements.namedItem("address") as HTMLInputElement;
const connectError = element<HTMLParagraphElement>("connect-error");
const addInsecure = element<HTMLButtonElement>("add-insecure");
const back = element<HTMLButtonElement>("back");
const tools = element<HTMLElement>("tools");
const toolList = element<HTMLUListElement>("tool-list");
const toolsDone = element<HTMLButtonElement>("tools-done");

type Step = "here" | "progress" | "failed" | "connect" | "tools";

/** Whether this app can run Quadit here; until the app has said, it is taken that it can. */
let canSetUpHere = true;

function show(step: Step) {
  here.hidden = step !== "here";
  progress.hidden = step !== "progress";
  failed.hidden = step !== "failed";
  connect.hidden = step !== "connect";
  tools.hidden = step !== "tools";
  // The small way to a server elsewhere stays under the main choice; Back leads to it again.
  toConnect.hidden = step === "connect" || step === "progress" || step === "tools";
  back.hidden = step !== "connect" || !canSetUpHere;
}

async function setUp() {
  const name = nameInput.value.trim();
  nameError.textContent = name ? "" : "Type your name first.";
  if (!name) {
    nameInput.focus();
    return;
  }
  show("progress");
  const result = await api.setUpHere(name);
  if (result.ok && result.tools.length > 0) {
    toolList.replaceChildren(...result.tools.map(toolRow));
    show("tools");
    toolsDone.focus();
    return;
  }
  if (result.ok) {
    window.close();
    return;
  }
  failedReason.textContent = result.error;
  show("failed");
}

/** A found tool's row: its name, Connect, then Connected or why not with Try again, and what connecting changes. */
function toolRow(tool: FoundToolView): HTMLLIElement {
  const row = make("li", "", "tool");
  const status = make("span", "", "status");
  status.setAttribute("role", "status");
  const error = make("p", "", "error");
  error.setAttribute("role", "alert");
  const changes = make("div", "", "changes");
  changes.hidden = true;
  const connectIt = async () => {
    error.textContent = "";
    connectButton.disabled = true;
    retry.disabled = true;
    status.textContent = "Connecting…";
    const done = await api.connectFoundTool(tool.id);
    connectButton.disabled = false;
    retry.disabled = false;
    connectButton.hidden = true;
    retry.hidden = done.ok;
    status.textContent = done.ok ? "Connected" : "";
    if (!done.ok) {
      error.textContent = done.error;
      return;
    }
    toolsDone.textContent = "Done";
    if (!changes.hidden) void showChanges();
  };
  const showChanges = async () => {
    changes.replaceChildren(make("p", "Looking…", "fine"));
    changes.hidden = false;
    const planned = await api.foundToolChanges(tool.id);
    if (!planned.ok) {
      changes.replaceChildren(make("p", planned.error, "error"));
      return;
    }
    changes.replaceChildren(
      ...planned.plan.files.map((file) => {
        const box = make("div", "", "file");
        box.append(make("strong", file.path));
        if (file.note) box.append(make("p", file.note, "fine"));
        if (file.diff) box.append(make("pre", file.diff, "diff"));
        return box;
      }),
    );
  };
  const connectButton = button("Connect", () => void connectIt(), "primary", `Connect ${tool.name}`);
  const retry = button("Try again", () => void connectIt(), "", `Try connecting ${tool.name} again`);
  retry.hidden = true;
  const see = button(
    "See what this changes",
    () => (changes.hidden ? void showChanges() : (changes.hidden = true)),
    "quiet",
    `See what connecting ${tool.name} changes`,
  );
  const top = make("div", "", "tool-top");
  const about = make("div", "", "about");
  about.append(make("strong", tool.name), status);
  top.append(about, connectButton, retry);
  row.append(top, error, see, changes);
  return row;
}

/** Adds the address the form holds; `allowInsecure` is the person's yes to a plain http address. */
async function add(allowInsecure: boolean) {
  const button = connect.querySelector<HTMLButtonElement>("button[type=submit]");
  connectError.textContent = "";
  addInsecure.hidden = true;
  if (button) button.disabled = true;
  const result = await api.addServer(address.value, "", allowInsecure);
  if (button) button.disabled = false;
  if (result.ok) {
    // Its window is open, on its sign-in page.
    window.close();
    return;
  }
  connectError.textContent = result.error;
  addInsecure.hidden = !result.insecure;
}

here.addEventListener("submit", (event) => {
  event.preventDefault();
  void setUp();
});
element("retry").addEventListener("click", () => void setUp());
toConnect.addEventListener("click", () => {
  show("connect");
  address.focus();
});
back.addEventListener("click", () => {
  show("here");
  nameInput.focus();
});
connect.addEventListener("submit", (event) => {
  event.preventDefault();
  void add(false);
});
addInsecure.addEventListener("click", () => void add(true));
element("more-options").addEventListener("click", () => void api.openConnect());
// Skipped or done, the step is over (the app ends it when Welcome closes).
toolsDone.addEventListener("click", () => window.close());
// The yes was for the address shown: another address asks again.
connect.addEventListener("input", () => (addInsecure.hidden = true));

async function start() {
  const [local, name] = await Promise.all([api.localServer(), api.accountName().catch(() => "")]);
  canSetUpHere = local.available;
  if (!canSetUpHere) {
    show("connect");
    address.focus();
    return;
  }
  nameInput.value = name;
  kept.hidden = !local.dataKept;
  show("here");
  nameInput.focus();
}

void start();
