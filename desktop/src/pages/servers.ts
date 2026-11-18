// The server list page: every added server with what it answered just now,
// and the form that adds one. All work is done by the app (src/main/server-list.ts)
// through window.quaditPages.

import type { PagesApi, ServerStatus, ServerView } from "@/shared/pages-api";

const api = window.quaditPages as PagesApi;
const list = element<HTMLUListElement>("list");
const empty = element<HTMLParagraphElement>("empty");
const form = element<HTMLFormElement>("add");
const addError = element<HTMLParagraphElement>("add-error");
const addInsecure = element<HTMLButtonElement>("add-insecure");
const invitation = element<HTMLParagraphElement>("invitation");

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`the page has no #${id}`);
  return found as T;
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = ""): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  if (text) made.textContent = text;
  if (className) made.className = className;
  return made;
}

/** What a person should know about a server's answer, in a line. */
function describe(status: ServerStatus): { text: string; signIn: boolean; warn: boolean } {
  if (!status.reachable) return { text: status.reason, signIn: false, warn: true };
  const version = status.version ? `Quadit ${status.version}` : "Quadit";
  if (status.fit === "old-server") {
    return {
      text: `${version}. This server is older than the app: sign in with your password in its window.`,
      signIn: false,
      warn: true,
    };
  }
  if (status.fit === "new-server") {
    return {
      text: `${version}. This server needs a newer Quadit app to sign in through the browser.`,
      signIn: false,
      warn: true,
    };
  }
  return { text: version, signIn: true, warn: false };
}

/** What a person should know about how the server's address carries their work, or "" when it is encrypted. */
function transportNote(server: ServerView): string {
  if (server.transport === "local")
    return "Not encrypted (http), which is fine on this computer or a network of your own.";
  if (server.transport === "insecure")
    return "Not encrypted (http): anyone on the networks between can read and change what you do here.";
  return "";
}

function row(server: ServerView): HTMLLIElement {
  const item = make("li", "", "server");
  const about = make("div", "", "about");
  about.append(make("strong", server.name), make("span", server.origin, "origin"));
  const note = transportNote(server);
  if (note) about.append(make("span", note, server.transport === "insecure" ? "status warn" : "status"));
  const status = make("span", "Checking…", "status");
  about.append(status);

  const actions = make("div", "", "actions");
  const open = make("button", "Open", "primary");
  open.type = "button";
  open.setAttribute("aria-label", `Open ${server.name}`);
  open.addEventListener("click", () => void api.openServer(server.id));
  const signIn = make("button", "Sign in with browser");
  signIn.type = "button";
  signIn.disabled = true;
  signIn.setAttribute("aria-label", `Sign in to ${server.name} with your browser`);
  signIn.addEventListener("click", () => void api.signIn(server.id));
  const remove = make("button", "Remove", "quiet");
  remove.type = "button";
  remove.setAttribute("aria-label", `Remove ${server.name}`);
  actions.append(open, signIn, remove);

  // Removing asks once more in the row itself: the app forgets the sign-in.
  const confirming = make("div", "", "actions confirm");
  confirming.hidden = true;
  confirming.append(make("span", `Remove ${server.name}? Its window closes and the app forgets its sign-in.`));
  const yes = make("button", "Remove", "danger");
  yes.type = "button";
  yes.setAttribute("aria-label", `Yes, remove ${server.name}`);
  yes.addEventListener("click", () => void api.removeServer(server.id));
  const no = make("button", "Keep");
  no.type = "button";
  no.addEventListener("click", () => {
    confirming.hidden = true;
    actions.hidden = false;
    remove.focus();
  });
  confirming.append(yes, no);
  remove.addEventListener("click", () => {
    actions.hidden = true;
    confirming.hidden = false;
    no.focus();
  });
  item.append(about, actions, confirming);

  void api.checkServer(server.id).then((answer) => {
    const said = describe(answer);
    status.textContent = said.text;
    status.classList.toggle("warn", said.warn);
    signIn.disabled = !said.signIn;
  });
  return item;
}

async function render() {
  const servers = await api.listServers();
  list.replaceChildren(...servers.map(row));
  empty.hidden = servers.length > 0;
  const invited = await api.takeInvitation();
  if (invited) {
    invitation.textContent = `A link asked to open ${invited.origin}, which is not in your list. Add it below to open the link's server.`;
    invitation.hidden = false;
    const address = form.elements.namedItem("address") as HTMLInputElement;
    address.value = invited.origin;
    address.focus();
  }
}

/** Adds what the form holds; `allowInsecure` is the person's yes to a plain http address. */
function add(allowInsecure: boolean) {
  const address = (form.elements.namedItem("address") as HTMLInputElement).value;
  const name = (form.elements.namedItem("name") as HTMLInputElement).value;
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
  addError.textContent = "";
  addInsecure.hidden = true;
  if (button) button.disabled = true;
  void api
    .addServer(address, name, allowInsecure)
    .then((result) => {
      if (!result.ok) {
        addError.textContent = result.error;
        addInsecure.hidden = !result.insecure;
        return;
      }
      form.reset();
      invitation.hidden = true;
    })
    .finally(() => {
      if (button) button.disabled = false;
    });
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  add(false);
});
addInsecure.addEventListener("click", () => add(true));
// The yes was for the address shown: another address asks again.
form.addEventListener("input", () => (addInsecure.hidden = true));

api.onChanged(() => void render());
void render();
