// The menu-bar panel (src/main/panel.ts), what a person opens it for, per
// workspace a server's window shows: what waits on them first (questions
// asked of them with their buttons, tasks that wait on them, runs of their
// agents that need them; or that nothing does), then the runs open now with
// Stop where they may stop them, then the agents with the first line of
// their card; and, under all, New task and Open Quadit. A button is carried
// out by that workspace's own page; when it cannot be, the window opens
// there instead. The panel is as tall as what it shows (fitPanel).

import { button, element, make } from "@/pages/dom";
import { headingOf, openFor, waitsWords } from "@/pages/panel-words";
import type { AgentState, DesktopAction, DesktopSummary } from "@/shared/bridge";
import type { PagesApi, ServerView, SummaryView } from "@/shared/pages-api";

const api = window.quaditPages as PagesApi;
const root = element<HTMLElement>("panel");

/** An agent's state in words, for a page from before the card's line was published. */
const STATES: Record<AgentState, string> = {
  working: "Working",
  waiting: "Waiting on someone",
  has_work: "Has work",
  idle: "Idle",
};

/** A row that opens a page of the workspace, with a line under it. */
function opening(view: SummaryView, title: string, path: string, line: string, tone = ""): HTMLLIElement {
  const row = make("li", "", "item");
  row.append(
    button(title, () => void api.openPath(view.serverId, path), "link"),
    ...(line ? [make("span", line, `status ${tone}`.trim())] : []),
  );
  return row;
}

/** Buttons the workspace's page carries out; a refusal is said, and the window opens at `path` instead. */
function buttons(view: SummaryView, actions: DesktopAction[], path: string, label?: (a: DesktopAction) => string) {
  const box = make("div", "", "actions");
  const said = make("p", "", "error");
  const press = async (action: DesktopAction) => {
    for (const b of box.querySelectorAll("button")) b.disabled = true;
    const outcome = await api.act(view.serverId, view.summary.workspace.id, { request: action.request });
    if (outcome.ok) return;
    said.textContent = outcome.message;
    for (const b of box.querySelectorAll("button")) b.disabled = false;
    void api.openPath(view.serverId, outcome.path ?? path);
  };
  box.append(...actions.map((action) => button(action.label, () => void press(action), "", label?.(action) ?? "")));
  return [box, said];
}

function decision(view: SummaryView, item: DesktopSummary["waiting"][number]): HTMLLIElement {
  const row = opening(view, item.title, item.path, item.detail);
  row.append(...buttons(view, item.actions, item.path));
  return row;
}

/** "and 3 more", for a list cut short. */
function more(count: number): HTMLElement[] {
  return count > 0 ? [make("p", `and ${count} more`, "hint more")] : [];
}

/** What waits on the person: always said, first; nothing, in one quiet line. */
function waitingOnYou(view: SummaryView): HTMLElement[] {
  const { waiting, waitingMore = 0, tasks, runs } = view.summary;
  const rows = [
    ...waiting.map((item) => decision(view, item)),
    ...(tasks?.items ?? []).map((task) =>
      opening(view, `${task.key} ${task.title}`, task.path, waitsWords(task.who), "warn"),
    ),
    ...(runs?.items ?? []).map((run) => opening(view, `${run.key} ${run.title}`, run.path, run.line, "warn")),
  ];
  const rest = waitingMore + (tasks?.more ?? 0) + (runs?.more ?? 0);
  if (rows.length === 0) return [make("h3", "Waiting on you"), make("p", "Nothing waits on you.", "hint")];
  return [make("h3", "Waiting on you"), list(rows), ...more(rest)];
}

/** The runs open now, with Stop where the person may stop one. */
function workingNow(view: SummaryView, now: number): HTMLElement[] {
  const working = view.summary.working;
  if (!working || working.items.length === 0) return [];
  const rows = working.items.map((run) => {
    const row = opening(
      view,
      `${run.agent} ${run.key} ${run.title}`,
      run.path,
      `${run.state}, ${openFor(run.since, now)}`,
    );
    if (run.stop) row.append(...buttons(view, [run.stop], run.path, () => `Stop ${run.agent} on ${run.key}`));
    return row;
  });
  return [make("h3", "Working now"), list(rows), ...more(working.more)];
}

/**
 * An agent, with the first line of its card; a click opens the Agents page,
 * or, for one not connected or that nothing hears, the app's sheet of it.
 */
function agent(view: SummaryView, a: DesktopSummary["agents"][number]): HTMLLIElement {
  const row = make("li", "", "item agent");
  const open = () => {
    if (a.reach === "not_connected") void api.openAgent(view.serverId, a.id, "connect");
    else if (a.reach === "not_listening") void api.openAgent(view.serverId, a.id);
    else void api.openPath(view.serverId, `/${view.summary.workspace.slug}/agents`);
  };
  const name = button("", open, "link", `${a.name} @${a.handle}`);
  name.append(document.createTextNode(a.name), " ", make("span", `@${a.handle}`, "handle"));
  const line = a.line
    ? make("span", a.line.text, `status tone-${a.line.tone}`)
    : make("span", a.detail || STATES[a.state], `status state-${a.state}`);
  row.append(name, line);
  return row;
}

function workspace(view: SummaryView, servers: ServerView[], now: number): HTMLElement {
  const section = make("section", "", "workspace");
  const server = servers.find((s) => s.id === view.serverId)?.name ?? "";
  section.append(make("h2", headingOf(view.summary.workspace.name, server, servers.length)));
  if (!view.listening) {
    section.append(
      make("p", "This server's web app is older than the app: open it to see.", "hint"),
      button("Open", () => void api.openPath(view.serverId, `/${view.summary.workspace.slug}`)),
    );
    return section;
  }
  section.append(...waitingOnYou(view), ...workingNow(view, now));
  const { agents } = view.summary;
  if (agents.length > 0) section.append(make("h3", "Agents"), list(agents.map((a) => agent(view, a))));
  return section;
}

function list(items: HTMLLIElement[]): HTMLUListElement {
  const ul = make("ul", "", "list");
  ul.append(...items);
  return ul;
}

/** New task and Open Quadit, under everything. */
function footer(summaries: SummaryView[], servers: ServerView[]): HTMLElement {
  const row = make("footer", "", "panel-foot");
  const first = summaries[0];
  const open = () => {
    if (first) void api.openPath(first.serverId, `/${first.summary.workspace.slug}`);
    else if (servers[0]) void api.openServer(servers[0].id);
  };
  row.append(
    button("New task", () => void api.openCapture()),
    button("Open Quadit", open),
  );
  return row;
}

async function render() {
  const [servers, summaries] = await Promise.all([api.listServers(), api.summaries()]);
  const shown = new Set(summaries.map((s) => s.serverId));
  const others = servers.filter((server) => !shown.has(server.id));
  const now = Date.now();
  root.replaceChildren(
    ...summaries.map((view) => workspace(view, servers, now)),
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
  else root.append(footer(summaries, servers));
  // As tall as what it shows, its border with it.
  void api.fitPanel(Math.ceil(root.getBoundingClientRect().height) + 2);
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") window.close();
});
api.onChanged(() => void render());
// How long each run has been open moves on while the panel is open.
setInterval(() => {
  if (document.visibilityState === "visible") void render();
}, 30_000);
void render();
