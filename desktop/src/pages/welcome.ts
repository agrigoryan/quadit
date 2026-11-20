// Welcome (src/main/welcome-page.ts): set Quadit up on this computer with
// a name, or connect to a server elsewhere. It shows one of four things at
// a time: the name form, the start under way, why it failed, or the
// address form; where the app has no server to run (Windows) only the last.

import { element } from "@/pages/dom";
import type { PagesApi } from "@/shared/pages-api";

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

type Step = "here" | "progress" | "failed" | "connect";

/** Whether this app can run Quadit here; until the app has said, it is taken that it can. */
let canSetUpHere = true;

function show(step: Step) {
  here.hidden = step !== "here";
  progress.hidden = step !== "progress";
  failed.hidden = step !== "failed";
  connect.hidden = step !== "connect";
  // The small way to a server elsewhere stays under the main choice; Back leads to it again.
  toConnect.hidden = step === "connect" || step === "progress";
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
  if (result.ok) {
    window.close();
    return;
  }
  failedReason.textContent = result.error;
  show("failed");
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
