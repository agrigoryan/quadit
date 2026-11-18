// The menu-bar panel (src/main/panel.ts): per workspace a server's window
// shows, the decisions waiting on the person with their buttons, and the
// agents with what they are doing. A button is carried out by that
// workspace's own page; when it cannot be, the window opens there instead.

import { button, element, make } from "@/pages/dom";
import type { AgentState, DesktopAction, DesktopSummary } from "@/shared/bridge";
import type { PagesApi, SummaryView } from "@/shared/pages-api";

const api = window.quaditPages as PagesApi;
const root = element<HTMLElement>("panel");

const STATES: Record<AgentState, string> = {
  working: "Working",
  waiting: "Waiting on someone",
  has_work: "Has work",
  idle: "Idle",
};

function decision(view: SummaryView, item: DesktopSummary["waiting"][number]): HTMLLIElement {
  const row = make("li", "", "item");
  row.append(
    button(item.title, () => void api.openPath(view.serverId, item.path), "link"),
    ...(item.detail ? [make("span", item.detail, "status")] : []),
  );
  const actions = make("div", "", "actions");
  const said = make("p", "", "error");
  const press = async (action: DesktopAction) => {
    for (const b of actions.querySelectorAll("button")) b.disabled = true;
    const outcome = await api.act(view.serverId, view.summary.workspace.id, { request: action.request });
    if (outcome.ok) return;
    said.textContent = outcome.message;
    for (const b of actions.querySelectorAll("button")) b.disabled = false;
    void api.openPath(view.serverId, outcome.path ?? item.path);
  };
  actions.append(...item.actions.map((action) => button(action.label, () => void press(action))));
  row.append(actions, said);
  return row;
}

function agent(view: SummaryView, a: DesktopSummary["agents"][number]): HTMLLIElement {
  const row = make("li", "", "item");
  const name = button(`${a.name} @${a.handle}`, () => void api.openPath(view.serverId, a.path), "link");
  row.append(name, make("span", [STATES[a.state], a.detail].filter(Boolean).join(" · "), `status state-${a.state}`));
  return row;
}

function workspace(view: SummaryView): HTMLElement {
  const section = make("section", "", "workspace");
  section.append(make("h2", `${view.serverName} · ${view.summary.workspace.name}`));
  if (!view.listening) {
    section.append(
      make("p", "This server's web app is older than the app: open it to see.", "hint"),
      button("Open", () => void api.openPath(view.serverId, `/${view.summary.workspace.slug}`)),
    );
    return section;
  }
  const { waiting, agents } = view.summary;
  section.append(make("h3", "Waiting on you"));
  if (waiting.length === 0) section.append(make("p", "Nothing.", "hint"));
  else section.append(list(waiting.map((item) => decision(view, item))));
  section.append(make("h3", "Agents"));
  if (agents.length === 0) section.append(make("p", "None.", "hint"));
  else section.append(list(agents.map((a) => agent(view, a))));
  return section;
}

function list(items: HTMLLIElement[]): HTMLUListElement {
  const ul = make("ul", "", "list");
  ul.append(...items);
  return ul;
}

async function render() {
  const [servers, summaries] = await Promise.all([api.listServers(), api.summaries()]);
  const shown = new Set(summaries.map((s) => s.serverId));
  const others = servers.filter((server) => !shown.has(server.id));
  root.replaceChildren(
    ...summaries.map(workspace),
    ...others.map((server) => {
      const section = make("section", "", "workspace");
      section.append(
        make("h2", server.name),
        make("p", "No window shows a workspace of it now: open it to see.", "hint"),
        button("Open", () => void api.openServer(server.id), "", `Open ${server.name}`),
      );
      return section;
    }),
  );
  if (servers.length === 0) root.append(make("p", "No servers yet. Add one in File → Servers.", "hint"));
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") window.close();
});
api.onChanged(() => void render());
void render();
