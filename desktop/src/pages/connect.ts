// The Connect page (src/main/connections.ts): the agent tools on this
// computer with what each has connected, the choice of how and as whom to
// connect one, and the plan to review (every file as a diff) before Apply.

import { button, element, make } from "@/pages/dom";
import type { ConnectChoice, ConnectView, HarnessView, PagesApi, PlanView, SummaryView } from "@/shared/pages-api";

const api = window.quaditPages as PagesApi;
const harnessList = element<HTMLUListElement>("harnesses");
const cli = element<HTMLParagraphElement>("cli");
const notices = element<HTMLUListElement>("notices");
const choose = element<HTMLElement>("choose");
const form = element<HTMLFormElement>("choice");
const workspaces = element<HTMLSelectElement>("workspace");
const agents = element<HTMLSelectElement>("agent");
const newAgent = element<HTMLDivElement>("new-agent");
const identity = element<HTMLParagraphElement>("identity");
const choiceError = element<HTMLParagraphElement>("choice-error");
const planSection = element<HTMLElement>("plan");
const planError = element<HTMLParagraphElement>("plan-error");
const result = element<HTMLParagraphElement>("result");
const NEW_AGENT = "";

let views: SummaryView[] = [];
let harness: HarnessView | null = null;
let plan: {
  view: PlanView;
  apply: (id: string) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
} | null = null;

const keyOf = (v: SummaryView) => JSON.stringify([v.serverId, v.summary.workspace.id]);
const checked = (name: string) => (form.elements.namedItem(name) as HTMLInputElement).checked;
const value = (id: string) => element<HTMLInputElement>(id).value;

function chosen(): SummaryView | undefined {
  return views.find((v) => keyOf(v) === workspaces.value);
}

function describeCli(view: ConnectView): string {
  if (view.cli.found) return `quadit ${view.cli.version} is on your PATH at ${view.cli.found}.`;
  if (view.cli.linkInto)
    return `quadit is not on your PATH: connecting links the app's own copy into ${view.cli.linkInto}.`;
  return `quadit is not on your PATH, and the app cannot put it there. Install it first: ${view.cli.manual ?? ""}`;
}

function harnessRow(h: HarnessView): HTMLLIElement {
  const row = make("li", "", "server");
  const about = make("div", "", "about");
  about.append(make("strong", h.name));
  if (h.connected) {
    const how = h.connected.methods.map((m) => (m === "cli" ? "quadit command" : "MCP")).join(" and ");
    const where = [h.connected.server, h.connected.workspace].filter(Boolean).join(" · ");
    about.append(make("span", `Connected (${how}) to ${where} as ${h.connected.agent}`, "status"));
  } else about.append(make("span", h.installed ? "Installed" : "Not found on this computer", "status"));
  const actions = make("div", "", "actions");
  if (h.connected) actions.append(button("Disconnect…", () => void disconnect(h), "", `Disconnect ${h.name}`));
  else actions.append(button("Connect…", () => startChoice(h), "", `Connect ${h.name}`));
  row.append(about, actions);
  return row;
}

async function render() {
  const view = await api.connectState();
  element("unsupported").hidden = view.supported;
  cli.textContent = view.supported ? describeCli(view) : "";
  notices.replaceChildren(
    ...(view.defaultLogin
      ? [
          make(
            "li",
            `This computer's default quadit login is for ${view.defaultLogin}. Connect leaves it as it is.`,
            "hint",
          ),
        ]
      : []),
    ...(view.claudePlugin
      ? [
          make(
            "li",
            "The Quadit plugin for Claude Code is installed. It needs QUADIT_URL and QUADIT_TOKEN, which Connect does not set: turn it off when you connect Claude Code here.",
            "status warn",
          ),
        ]
      : []),
  );
  harnessList.replaceChildren(...(view.supported ? view.harnesses.map(harnessRow) : []));
  if (harness) harness = view.harnesses.find((h) => h.id === harness?.id) ?? null;
  await fillWorkspaces();
}

/** The workspaces to connect to (those a window shows now), keeping the one chosen. */
async function fillWorkspaces() {
  const previous = workspaces.value;
  views = (await api.summaries()).filter((v) => v.listening);
  workspaces.replaceChildren(
    ...views.map((v) => {
      const option = make("option", `${v.serverName} · ${v.summary.workspace.name}`);
      option.value = keyOf(v);
      return option;
    }),
  );
  if (views.some((v) => keyOf(v) === previous)) workspaces.value = previous;
  fillAgents();
}

function fillAgents() {
  const previous = agents.value;
  const summary = chosen()?.summary;
  const options = (summary?.agents ?? [])
    .filter((a) => a.usable)
    .map((a) => {
      const option = make("option", `${a.name} @${a.handle}`);
      option.value = a.id;
      return option;
    });
  if (summary?.me.canCreateAgents) {
    const option = make("option", "New agent…");
    option.value = NEW_AGENT;
    options.push(option);
  }
  agents.replaceChildren(...options);
  if (options.some((o) => o.value === previous)) agents.value = previous;
  newAgent.hidden = agents.value !== NEW_AGENT || options.length === 0;
}

function startChoice(h: HarnessView) {
  harness = h;
  result.hidden = true;
  planSection.hidden = true;
  choiceError.textContent = "";
  element("choose-title").textContent = `Connect ${h.name}`;
  element("mcp-option").hidden = !h.mcp;
  (form.elements.namedItem("mcp") as HTMLInputElement).checked = false;
  identity.textContent =
    h.cliIdentity === "own"
      ? `With the quadit command, ${h.name} gets a login of its own, as the agent chosen here.`
      : `${h.name} has no setting the app can use to give the quadit command its own login: there it works as this computer's default login.` +
        (h.mcp ? " Connect it by MCP to give it an agent of its own." : "");
  if (views.length === 0) choiceError.textContent = "Open a workspace in one of Quadit's windows first.";
  choose.hidden = false;
}

async function review() {
  const view = chosen();
  if (!harness || !view) return;
  const create = agents.value === NEW_AGENT;
  const choice: ConnectChoice = {
    harness: harness.id,
    serverId: view.serverId,
    workspaceId: view.summary.workspace.id,
    methods: [...(checked("cli") ? ["cli" as const] : []), ...(checked("mcp") && harness.mcp ? ["mcp" as const] : [])],
    agent: create ? { create: { name: value("agent-name"), handle: value("agent-handle") } } : { id: agents.value },
    allowUnattended: checked("unattended"),
  };
  choiceError.textContent = "";
  const planned = await api.planConnect(choice);
  if (!planned.ok) {
    choiceError.textContent = planned.error;
    return;
  }
  showPlan(planned.plan, async (id) => {
    const applied = await api.applyConnect(id);
    return applied.ok ? { ok: true, text: `Connected. ${applied.hint}` } : applied;
  });
}

async function disconnect(h: HarnessView) {
  result.hidden = true;
  choose.hidden = true;
  const planned = await api.planDisconnect(h.id);
  if (!planned.ok) {
    result.textContent = planned.error;
    result.hidden = false;
    return;
  }
  showPlan(planned.plan, async (id) => {
    const applied = await api.applyDisconnect(id);
    return applied.ok ? { ok: true, text: ["Disconnected.", ...applied.notes].join(" ") } : applied;
  });
}

function showPlan(view: PlanView, apply: NonNullable<typeof plan>["apply"]) {
  plan = { view, apply };
  planError.textContent = "";
  element("warnings").replaceChildren(...view.warnings.map((w) => make("li", w, "status warn")));
  element("files").replaceChildren(
    ...view.files.map((file) => {
      const box = make("div", "", "file");
      box.append(make("strong", file.path));
      if (file.note) box.append(make("p", file.note, "hint"));
      if (file.diff) box.append(make("pre", file.diff, "diff"));
      return box;
    }),
  );
  if (view.files.length === 0) element("files").append(make("p", "No file changes.", "hint"));
  element("backup-dir").textContent = `Every file that is there now is copied first to ${view.backupDir}.`;
  planSection.hidden = false;
  element("apply").focus();
}

element<HTMLButtonElement>("apply").addEventListener("click", () => {
  if (!plan) return;
  const { view, apply } = plan;
  const applyButton = element<HTMLButtonElement>("apply");
  applyButton.disabled = true;
  void apply(view.id)
    .then((done) => {
      if (!done.ok) {
        planError.textContent = done.error;
        return;
      }
      plan = null;
      planSection.hidden = true;
      choose.hidden = true;
      result.textContent = done.text;
      result.hidden = false;
      void render();
    })
    .finally(() => (applyButton.disabled = false));
});
element("cancel-plan").addEventListener("click", () => {
  plan = null;
  planSection.hidden = true;
});
element("cancel-choice").addEventListener("click", () => {
  choose.hidden = true;
  planSection.hidden = true;
});
element("backups").addEventListener("click", () => void api.showBackups());
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void review();
});
workspaces.addEventListener("change", fillAgents);
agents.addEventListener("change", () => (newAgent.hidden = agents.value !== NEW_AGENT));

// The workspaces change as windows come and go; the harnesses only when the page asks again.
api.onChanged(() => void fillWorkspaces());
void render();
