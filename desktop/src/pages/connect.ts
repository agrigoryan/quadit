// The Connect window (src/main/connections.ts): the agent tools on this
// computer as the same cards and the same sheet as the first run's tools step
// (tool-card.ts, files-sheet.ts; desktop contract §10), for the workspace
// chosen at the top. A card's Connect uses the defaults and asks nothing;
// "See the files" shows what it changes first; "More options" holds the
// technical choices (MCP, which agent, without asking each time), whose plan
// the sheet shows before anything is written. A connected tool's card says
// where it is connected, and Disconnect shows what taking it back does first.

import { button, element, make } from "@/pages/dom";
import { openSheet } from "@/pages/files-sheet";
import { tile, ToolCard } from "@/pages/tool-card";
import { defaultChoice, handleOf } from "@/shared/default-choice";
import type { ConnectChoice, ConnectView, HarnessView, PagesApi, Planned, SummaryView } from "@/shared/pages-api";

const api = window.quaditPages as PagesApi;
const workspaces = element<HTMLSelectElement>("workspace");
const cardsBox = element<HTMLDivElement>("cards");
const result = element<HTMLParagraphElement>("result");
const NEW_AGENT = "";
/** The server whose page opened this window (its "Connect a tool on this computer"): its workspace is chosen first. */
const askedFor = new URLSearchParams(window.location.search).get("server");

let views: SummaryView[] = [];
/** The computer's default login, as the last look at the harnesses found it. */
let defaultLogin: ConnectView["defaultLogin"] = null;
/** What the cards' options do when the workspace chosen changes (its agents are offered); made anew with the cards. */
let workspaceChanged: (() => void)[] = [];

const keyOf = (v: SummaryView) => JSON.stringify([v.serverId, v.summary.workspace.id]);

function chosen(): SummaryView | undefined {
  return views.find((v) => keyOf(v) === workspaces.value);
}

function describeCli(view: ConnectView): string {
  if (view.cli.found) return `quadit ${view.cli.version} is on your PATH at ${view.cli.found}.`;
  if (view.cli.linkInto && view.cli.profile)
    return `quadit is not on your PATH: connecting puts the app's own copy in ${view.cli.linkInto} and adds that folder to your PATH in ${view.cli.profile}.`;
  if (view.cli.linkInto)
    return `quadit is not on your PATH: connecting links the app's own copy into ${view.cli.linkInto}.`;
  return `quadit is not on your PATH, and the app cannot put it there. Install it first: ${view.cli.manual ?? ""}`;
}

function loginName(login: NonNullable<ConnectView["defaultLogin"]>): string {
  return `${login.agent ?? "an agent its server did not name"} on ${login.server ?? "its server"}`;
}

function say(text: string) {
  result.textContent = text;
  result.hidden = !text;
}

/** Plans `choice` and shows the plan in the sheet, whose button connects; the plan is dropped if the sheet closes first. */
function reviewConnect(h: HarnessView, plan: Promise<Planned>, card: ToolCard) {
  let applied = false;
  openSheet({
    tool: h,
    kind: "connect",
    plan,
    action: {
      label: `Connect ${h.name}`,
      run: async (planId) => {
        const done = await api.applyConnect(planId);
        if (!done.ok) return done;
        applied = true;
        card.markConnected(true);
        say(`Connected. ${done.hint}`);
        void render();
        return { ok: true };
      },
    },
    closed: () => {
      if (!applied) void api.dropPlan();
    },
  });
}

/** Shows what disconnecting does in the sheet, whose button does it; resolves with how that went (closed: nothing). */
function reviewDisconnect(h: HarnessView): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((settle) => {
    let done = false;
    openSheet({
      tool: h,
      kind: "disconnect",
      plan: api.planDisconnect(h.id),
      action: {
        label: `Disconnect ${h.name}`,
        run: async (planId) => {
          const applied = await api.applyDisconnect(planId);
          if (!applied.ok) return applied;
          done = true;
          say(["Disconnected.", ...applied.notes].join(" "));
          settle({ ok: true });
          void render();
          return { ok: true };
        },
      },
      closed: () => {
        if (done) return;
        void api.dropPlan();
        settle({ ok: false, error: "" });
      },
    });
  });
}

function toolCard(h: HarnessView, addsCommand: boolean): ToolCard {
  const plainPlan = (): Promise<Planned> => {
    const view = chosen();
    if (!view) return Promise.resolve({ ok: false, error: "Open a workspace in one of Quadit's windows first." });
    return api.planConnect(defaultChoice(h, view.serverId, view.summary));
  };
  const card: ToolCard = new ToolCard({ ...h, ownLogin: h.cliIdentity === "own" }, addsCommand, {
    connect: async () => {
      const planned = await plainPlan();
      if (!planned.ok) return planned;
      const done = await api.applyConnect(planned.plan.id);
      if (!done.ok) return done;
      say(`Connected. ${done.hint}`);
      void render();
      return { ok: true };
    },
    back: { label: "Disconnect", run: () => reviewDisconnect(h) },
    seeFiles: () => {
      if (card.isConnected) void reviewDisconnect(h);
      else reviewConnect(h, plainPlan(), card);
    },
    changed: () => {},
  });
  card.markConnected(!!h.connected);
  if (h.connected) {
    const how = h.connected.methods.map((m) => (m === "cli" ? "quadit command" : "MCP")).join(" and ");
    const where = [h.connected.server, h.connected.workspace].filter(Boolean).join(" · ");
    card.extra.append(make("p", `Connected (${how}) to ${where} as ${h.connected.agent}`, "where-to"));
  } else {
    const options = optionsForm(h, card);
    options.hidden = true;
    const more = button(
      "More options",
      () => {
        options.hidden = !options.hidden;
        more.setAttribute("aria-expanded", String(!options.hidden));
      },
      "btn-text more",
      `More options for ${h.name}`,
    );
    more.setAttribute("aria-expanded", "false");
    card.extra.append(more, options);
  }
  return card;
}

/** The technical choices for connecting `h`: how, as whom, and without asking each time; reviewed in the sheet. */
function optionsForm(h: HarnessView, card: ToolCard): HTMLFormElement {
  const form = make("form", "", "options");
  form.noValidate = true;
  form.setAttribute("aria-label", `How to connect ${h.name}`);
  const check = (name: string, text: string, on: boolean) => {
    const label = make("label", "", "check");
    const box = make("input");
    box.type = "checkbox";
    box.name = name;
    box.checked = on;
    label.append(box, make("span", text));
    return { label, box };
  };
  const how = make("fieldset", "", "choice");
  how.append(make("legend", "How"));
  const cli = check("cli", "The quadit command and its skill", true);
  const mcp = check("mcp", "Quadit's MCP server (signs in through the tool)", false);
  how.append(cli.label);
  if (h.mcp) how.append(mcp.label);

  const workAs = make("label", "", "stacked");
  const agents = make("select");
  workAs.append(make("span", "Work as"), agents);
  const newAgent = make("div", "", "pair");
  const field = (text: string, value: string) => {
    const label = make("label", "", "stacked");
    const input = make("input");
    input.type = "text";
    input.autocomplete = "off";
    input.value = value;
    label.append(make("span", text), input);
    newAgent.append(label);
    return input;
  };
  const agentName = field("New agent's name", h.name);
  const agentHandle = field("Handle", handleOf(h.name));
  const identity = make("p", "", "hint");
  const unattended = check(
    "unattended",
    "Let it use Quadit without asking each time, where it has a setting for that",
    false,
  );
  const error = make("p", "", "card-error");
  error.setAttribute("role", "alert");
  const review = make("button", "Review changes", "btn btn-line btn-sm");
  review.type = "submit";
  form.append(how, workAs, newAgent, identity, unattended.label, error, review);

  const fillAgents = () => {
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
    const previous = agents.value;
    agents.replaceChildren(...options);
    if (options.some((o) => o.value === previous)) agents.value = previous;
    showIdentity();
  };
  // Whether choosing an agent holds: not for the quadit command alone in a tool that works as the default login there already.
  const showIdentity = () => {
    const viaMcp = mcp.box.checked && h.mcp;
    const fixed = h.cliIdentity === "default" && defaultLogin !== null;
    workAs.hidden = fixed && !viaMcp;
    newAgent.hidden = workAs.hidden || agents.value !== NEW_AGENT || agents.options.length === 0;
    identity.textContent =
      h.cliIdentity === "own"
        ? `With the quadit command, ${h.name} gets a login of its own, as the agent chosen here.`
        : fixed && defaultLogin
          ? `With the quadit command, ${h.name} works as this computer's default login, ${loginName(defaultLogin)}: it has no setting the app can use to give it a login of its own.` +
            (h.mcp
              ? viaMcp
                ? " The agent chosen here is the one to pick when it signs in to MCP."
                : " Connect it by MCP to give it an agent of its own."
              : "")
          : `${h.name} has no setting the app can use to give the quadit command its own login: there it works as this computer's default login, made now for the agent chosen here.` +
            (h.mcp ? " Connect it by MCP to give it an agent of its own." : "");
  };
  mcp.box.addEventListener("change", showIdentity);
  agents.addEventListener("change", showIdentity);
  workspaceChanged.push(fillAgents);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const view = chosen();
    error.textContent = "";
    if (!view) {
      error.textContent = "Open a workspace in one of Quadit's windows first.";
      return;
    }
    const choice: ConnectChoice = {
      harness: h.id,
      serverId: view.serverId,
      workspaceId: view.summary.workspace.id,
      methods: [...(cli.box.checked ? ["cli" as const] : []), ...(mcp.box.checked && h.mcp ? ["mcp" as const] : [])],
      agent: workAs.hidden
        ? null
        : agents.value === NEW_AGENT
          ? { create: { name: agentName.value, handle: agentHandle.value } }
          : { id: agents.value },
      allowUnattended: unattended.box.checked,
    };
    reviewConnect(h, api.planConnect(choice), card);
  });
  fillAgents();
  return form;
}

async function render() {
  const view = await api.connectState();
  defaultLogin = view.defaultLogin;
  element("unsupported").hidden = view.supported;
  // Nothing to connect, nor anything to look back at, where Connect does not run.
  element("tools").hidden = !view.supported;
  element("cli").textContent = view.supported ? describeCli(view) : "";
  element("notices").replaceChildren(
    ...(view.defaultLogin
      ? [
          make(
            "li",
            `This computer's default quadit login is ${loginName(view.defaultLogin)}. The tools without a login of their own work as it.`,
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
  await fillWorkspaces();
  const here = view.harnesses.filter((h) => h.installed || h.connected);
  const away = view.harnesses.filter((h) => !h.installed && !h.connected);
  const addsCommand = !view.cli.found && view.cli.linkInto !== null;
  workspaceChanged = [];
  cardsBox.replaceChildren(...here.map((h) => toolCard(h, addsCommand).element));
  // With none found here, the list of tools that are not waits, folded.
  const noneFound = view.supported && here.length === 0;
  element("none-found").hidden = !noneFound;
  element("all-tools").hidden = !noneFound;
  element("all-harnesses").replaceChildren(
    ...(noneFound
      ? away.map((h) => {
          const item = make("li", "", "named-tile");
          item.append(tile(h.initials, "sm"), document.createTextNode(h.name));
          return item;
        })
      : []),
  );
  const others = element<HTMLParagraphElement>("others");
  others.hidden = noneFound || away.length === 0;
  others.replaceChildren(make("span", "Not on this computer:", "lbl"), ...away.map((h) => make("span", h.name, "o")));
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
  const first = views.find((v) => v.serverId === askedFor);
  if (views.some((v) => keyOf(v) === previous)) workspaces.value = previous;
  else if (first) workspaces.value = keyOf(first);
  element("no-workspace").hidden = views.length > 0;
  for (const changed of workspaceChanged) changed();
}

element("backups").addEventListener("click", () => void api.showBackups());
workspaces.addEventListener("change", () => {
  for (const changed of workspaceChanged) changed();
});

// The workspaces change as windows come and go; the harnesses only when the page asks again.
api.onChanged(() => void fillWorkspaces());
void render();
