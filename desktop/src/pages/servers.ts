// The server list page: every added server with what it answered just now,
// and the form that adds one. All work is done by the app (src/main/server-list.ts)
// through window.quaditPages. The list is drawn again whenever anything the
// app shows changes (a window's page publishing, the server here starting):
// a removal being asked about, and the button in focus, stay as they were.

import { element, make } from "@/pages/dom";
import { localDetails, runLocalChoice } from "@/pages/local";
import type { LocalServerView, PagesApi, ServerStatus, ServerView } from "@/shared/pages-api";

const api = window.quaditPages as PagesApi;
const list = element<HTMLUListElement>("list");
const empty = element<HTMLParagraphElement>("empty");
const form = element<HTMLFormElement>("add");
const addError = element<HTMLParagraphElement>("add-error");
const addInsecure = element<HTMLButtonElement>("add-insecure");
const invitation = element<HTMLParagraphElement>("invitation");
const runLocal = element<HTMLElement>("run-local");
const runLocalBox = element<HTMLDivElement>("run-local-choice");
/** The server whose removal the person is being asked about; written by its row's Remove, Keep and Yes. */
let confirmingId: string | null = null;

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

function row(server: ServerView, local: LocalServerView): HTMLLIElement {
  const item = make("li", "", "server");
  item.dataset.server = server.id;
  const about = make("div", "", "about");
  about.append(make("strong", server.name), make("span", server.origin, "origin"));
  const note = server.local ? "" : transportNote(server);
  if (note) about.append(make("span", note, server.transport === "insecure" ? "status warn" : "status"));
  const status = make("span", "Checking…", "status");
  // The server on this computer says how it runs instead, and has its controls.
  about.append(...(server.local ? localDetails(local) : [status]));

  const actions = make("div", "", "actions");
  const open = make("button", "Open", "primary");
  open.type = "button";
  open.setAttribute("aria-label", `Open ${server.name}`);
  open.dataset.control = "open";
  open.addEventListener("click", () => void api.openServer(server.id));
  const signIn = make("button", "Sign in with browser");
  signIn.type = "button";
  signIn.disabled = true;
  signIn.setAttribute("aria-label", `Sign in to ${server.name} with your browser`);
  signIn.dataset.control = "sign-in";
  signIn.addEventListener("click", () => void api.signIn(server.id));
  const remove = make("button", "Remove", "quiet");
  remove.type = "button";
  remove.setAttribute("aria-label", `Remove ${server.name}`);
  remove.dataset.control = "remove";
  actions.append(open, signIn, remove);

  // Removing asks once more in the row itself: the app forgets the sign-in.
  const confirming = make("div", "", "actions confirm");
  confirming.hidden = true;
  confirming.append(
    make(
      "span",
      server.local
        ? `Remove ${server.name}? The server on this computer stops, its window closes and the app forgets its sign-in. ` +
            `Its data stays in ${local.dataDir}: set Quadit up on this computer again to use it.`
        : `Remove ${server.name}? Its window closes and the app forgets its sign-in.`,
    ),
  );
  const yes = make("button", "Remove", "danger");
  yes.type = "button";
  yes.setAttribute("aria-label", `Yes, remove ${server.name}`);
  yes.dataset.control = "yes";
  yes.addEventListener("click", () => {
    confirmingId = null;
    void api.removeServer(server.id);
  });
  const no = make("button", "Keep");
  no.type = "button";
  no.setAttribute("aria-label", `Keep ${server.name}`);
  no.dataset.control = "keep";
  no.addEventListener("click", () => {
    confirmingId = null;
    confirming.hidden = true;
    actions.hidden = false;
    remove.focus();
  });
  confirming.append(yes, no);
  remove.addEventListener("click", () => {
    confirmingId = server.id;
    actions.hidden = true;
    confirming.hidden = false;
    no.focus();
  });
  actions.hidden = confirmingId === server.id;
  confirming.hidden = confirmingId !== server.id;
  item.append(about, actions, confirming);

  // Signing in to the server on this computer happens in its own window.
  if (server.local) {
    signIn.remove();
    return item;
  }
  void api.checkServer(server.id).then((answer) => {
    const said = describe(answer);
    status.textContent = said.text;
    status.classList.toggle("warn", said.warn);
    signIn.disabled = !said.signIn;
  });
  return item;
}

/**
 * A control of the list in focus, as rows drawn anew find it again: its
 * server's id and what it is (its data-control; the controls of the server
 * on this computer, which have none, by their name, unique in that row).
 */
function focusOf(active: Element | null): { server: string; control: string } | null {
  if (!(active instanceof HTMLElement) || !list.contains(active)) return null;
  const server = active.closest<HTMLElement>("li[data-server]")?.dataset.server;
  const control = active.dataset.control ?? active.getAttribute("aria-label");
  return server && control ? { server, control } : null;
}

/**
 * Focuses that control in the rows drawn anew; one drawn disabled (the
 * browser sign-in, until its server answers again) leaves focus on its
 * row's Open, so it stays in the row the person was in.
 */
function refocus(focused: { server: string; control: string }) {
  const row = list.querySelector<HTMLElement>(`li[data-server="${CSS.escape(focused.server)}"]`);
  const control =
    row?.querySelector<HTMLButtonElement>(`[data-control="${CSS.escape(focused.control)}"]`) ??
    row?.querySelector<HTMLButtonElement>(`[aria-label="${CSS.escape(focused.control)}"]`);
  if (control && !control.disabled) control.focus();
  else row?.querySelector<HTMLElement>('[data-control="open"]')?.focus();
}

async function render() {
  const [servers, local] = await Promise.all([api.listServers(), api.localServer()]);
  const focused = focusOf(document.activeElement);
  if (!servers.some((server) => server.id === confirmingId)) confirmingId = null;
  list.replaceChildren(...servers.map((server) => row(server, local)));
  if (focused) refocus(focused);
  empty.hidden = servers.length > 0;
  const choice = runLocalChoice(local);
  runLocalBox.replaceChildren(...choice);
  runLocal.hidden = choice.length === 0;
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
