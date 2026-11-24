// Connect agents (src/main/connect-page.ts; desktop contract §11), laid over
// a server's window, for the workspace that window shows: the two steps to an
// agent that answers (listen-steps.ts), with the other ways, then the agent tools on
// this computer as the same cards and the same sheet as the first run's tools
// step (tool-card.ts, files-sheet.ts). A card's Connect uses the defaults and
// asks nothing; "See the files" shows what it changes first; "More options"
// holds the technical choices (MCP, which agent, a new agent's name),
// whose plan the sheet shows before anything is written, and, once a tool is
// connected, where and as whom. Disconnect shows what taking it back does
// first. "Done" and Escape take the page away, showing the one under it.
// Opened by another server's page rather than by the person, it says which
// server asked, and takes no input for its first moment on screen
// (hold-input.ts).
// A redraw keeps each tool's card and changes it in place: its nodes are
// replaced only when what it shows changes, so focus, a selection or a click
// in it survive the redraw after a Connect or a Disconnect.

import { button, element, make, separated } from "@/pages/dom";
import { openSheet } from "@/pages/files-sheet";
import { letInputIn } from "@/pages/hold-input";
import { listenSteps } from "@/pages/listen-steps";
import { tile, ToolCard } from "@/pages/tool-card";
import { defaultChoice, handleOf } from "@/shared/default-choice";
import { defaultLoginWords } from "@/shared/change-words";
import type {
  ConnectChoice,
  ConnectTarget,
  ConnectView,
  Disconnected,
  Handshake,
  HarnessView,
  PagesApi,
  Planned,
  Refused,
} from "@/shared/pages-api";

const api = window.quaditPages as PagesApi;
const cardsBox = element<HTMLDivElement>("cards");
const result = element<HTMLParagraphElement>("result");
const NEW_AGENT = "";
/** How long the page waits for where the connected tools stand before it shows them; a card asks again itself. */
const FIRST_LOOK_MS = 1_500;

/** The window this page is over: its server, and the workspace its page shows. */
let target: ConnectTarget | null = null;
/** The computer's default login, as the last look at the harnesses found it. */
let defaultLogin: ConnectView["defaultLogin"] = null;
/** What the last Disconnect of each tool left the person to know, which its card says until it connects again. */
const takenBack = new Map<string, Disconnected>();
/**
 * The card of each tool shown, kept from one redraw to the next: `made`,
 * what the card was made from (when it changes, a new card is made); `more`,
 * what its More options and its line about the skill were drawn from;
 * `fill`, what its options do when the workspace shown changes (its agents
 * are offered).
 */
interface Shown {
  card: ToolCard;
  made: string;
  more: string;
  fill: (() => void) | null;
}
const shownCards = new Map<string, Shown>();
/** Whether the page has shown its cards yet: input is let in once it has. */
let shownOnce = false;

/** The workspace to connect to, once the window's page shows one. */
function chosen(): { serverId: string; summary: NonNullable<ConnectTarget["summary"]> } | undefined {
  return target?.summary ? { serverId: target.serverId, summary: target.summary } : undefined;
}

const NO_WORKSPACE: Refused = { ok: false, error: "Open a workspace in this window first." };

function describeCli(view: ConnectView): string {
  if (view.cli.found) return `quadit ${view.cli.version} is on your PATH at ${view.cli.found}.`;
  if (view.cli.linkInto && view.cli.profile)
    return `quadit is not on your PATH: connecting puts the app's own copy in ${view.cli.linkInto} and adds that folder to your PATH in ${view.cli.profile}.`;
  if (view.cli.linkInto)
    return `quadit is not on your PATH: connecting links the app's own copy into ${view.cli.linkInto}.`;
  return `quadit is not on your PATH, and the app cannot put it there. Install it first: ${view.cli.manual ?? ""}`;
}

function loginName(login: NonNullable<ConnectView["defaultLogin"]>): string {
  return defaultLoginWords(login) ?? "";
}

function say(text: string) {
  result.textContent = text;
  result.hidden = !text;
}

/** Plans `choice` and shows the plan in the sheet, whose button connects; the plan is dropped if the sheet closes first. */
function reviewConnect(h: HarnessView, plan: () => Promise<Planned>) {
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
        say(done.hint);
        void render();
        return { ok: true };
      },
    },
    closed: () => {
      if (!applied) void api.dropPlan();
    },
  });
}

/**
 * Shows what disconnecting does in the sheet, whose button does it; resolves
 * with how that went and what the person should know (closed: nothing).
 */
function reviewDisconnect(h: HarnessView): Promise<Disconnected | Refused> {
  return new Promise((settle) => {
    let done = false;
    openSheet({
      tool: h,
      kind: "disconnect",
      plan: () => api.planDisconnect(h.id),
      action: {
        label: `Disconnect ${h.name}`,
        run: async (planId) => {
          const applied = await api.applyDisconnect(planId);
          if (!applied.ok) return applied;
          done = true;
          takenBack.set(h.id, applied);
          say(["Disconnected.", ...applied.notes].join(" "));
          settle(applied);
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

/** A new card for `h`, set up or not as `h` says, with where it stands when known (`handshake`). */
function newCard(h: HarnessView, made: string, addsCommand: boolean, handshake: Handshake | null): Shown {
  const plainPlan = (): Promise<Planned> => {
    const at = chosen();
    if (!at) return Promise.resolve(NO_WORKSPACE);
    return api.planConnect(defaultChoice(h, at.serverId, at.summary));
  };
  const tool = { ...h, ownLogin: h.cliIdentity === "own", worksAs: workingAs(h), mcpOnly: mcpOnly(h) };
  const card: ToolCard = new ToolCard(tool, addsCommand, {
    connect: async () => {
      const planned = await plainPlan();
      if (!planned.ok) return planned;
      const done = await api.applyConnect(planned.plan.id);
      if (!done.ok) return done;
      say(done.hint);
      void render();
      return { ok: true };
    },
    back: () => reviewDisconnect(h),
    seeFiles: () => {
      if (card.isSetUp) void reviewDisconnect(h);
      else reviewConnect(h, plainPlan);
    },
    changed: () => {},
  });
  card.markSetUp(!!h.connected, handshake);
  const left = takenBack.get(h.id);
  if (h.connected) takenBack.delete(h.id);
  else if (left) card.takenBack(left);
  const shown: Shown = { card, made, more: "", fill: null };
  drawMore(shown, h);
  return shown;
}

/**
 * Brings a kept card to what `h` says now, changing only what changed: set
 * up or not, the quadit command's place in its line, and, below it, More
 * options and the line about a skill changed by hand.
 */
function updateCard(shown: Shown, h: HarnessView, addsCommand: boolean, handshake: Handshake | null) {
  if (shown.card.isSetUp !== !!h.connected) shown.card.markSetUp(!!h.connected, handshake);
  if (h.connected) takenBack.delete(h.id);
  shown.card.setAddsCommand(addsCommand);
  drawMore(shown, h);
}

/**
 * A card's More options (connected: where and as whom; not: how and as whom
 * it would be, the technical side, folded) and the line about a skill
 * changed by hand, drawn anew only when what they show changes.
 */
function drawMore(shown: Shown, h: HarnessView) {
  const drawn = JSON.stringify([h.connected, h.skillChangedByHand]);
  if (drawn === shown.more) return;
  shown.more = drawn;
  const form = h.connected ? null : optionsForm(h);
  shown.fill = form?.fill ?? null;
  const options = form?.form ?? connectedHow(h);
  options.hidden = true;
  const toggle = button(
    "More options",
    () => {
      options.hidden = !options.hidden;
      toggle.setAttribute("aria-expanded", String(!options.hidden));
    },
    "btn-text more",
    `More options for ${h.name}`,
  );
  toggle.setAttribute("aria-expanded", "false");
  shown.card.extra.replaceChildren(...(h.skillChangedByHand ? [skillChanged(h)] : []), toggle, options);
}

/** A connected tool whose Quadit skill the person changed by hand: the app leaves it, and offers to update it. */
function skillChanged(h: HarnessView): HTMLParagraphElement {
  const line = make("p", `The Quadit skill for ${h.name} was changed by hand; `, "skill-changed");
  const run = async () => {
    update.disabled = true;
    const done = await api.updateSkill(h.id);
    update.disabled = false;
    if (done.ok) return void render();
    line.append(make("span", ` ${done.error}`, "card-error"));
  };
  const update = button("Update it", () => void run(), "link-blue", `Update the Quadit skill for ${h.name}`);
  line.append(update);
  return line;
}

/** A connected tool's More options: where and as whom it is connected, and the log of what the app ran for it. */
function connectedHow(h: HarnessView): HTMLDivElement {
  const box = make("div", "", "options");
  const { connected } = h;
  if (!connected) return box;
  const how = connected.methods.map((m) => (m === "cli" ? "quadit command" : "MCP")).join(" and ");
  const where = [connected.server, connected.workspace].filter(Boolean).join(" · ");
  box.append(
    make("p", `Connected (${how}) to ${where} as ${connected.agent}`, "where-to"),
    button("Show log", () => void api.showToolLog(h.id), "link-blue", `Show the log of what Quadit ran for ${h.name}`),
  );
  return box;
}

/**
 * The technical choices for connecting `h`: how, and as whom; reviewed in
 * the sheet. `fill` offers the agents of the
 * workspace shown, again when it changes.
 */
function optionsForm(h: HarnessView): { form: HTMLFormElement; fill: () => void } {
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
  const error = make("p", "", "card-error");
  error.setAttribute("role", "alert");
  const review = make("button", "Review changes", "btn btn-line btn-sm");
  review.type = "submit";
  form.append(how, workAs, newAgent, identity, error, review);

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
    // The same agents as offered already: nothing changes, and a choice being made is left alone.
    const offered = options.map((o) => `${o.value}\n${o.textContent}`).join("\n\n");
    if (offered === agents.dataset.offered) return;
    agents.dataset.offered = offered;
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
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const at = chosen();
    error.textContent = "";
    if (!at) {
      error.textContent = NO_WORKSPACE.error;
      return;
    }
    const choice: ConnectChoice = {
      harness: h.id,
      serverId: at.serverId,
      workspaceId: at.summary.workspace.id,
      methods: [...(cli.box.checked ? ["cli" as const] : []), ...(mcp.box.checked && h.mcp ? ["mcp" as const] : [])],
      agent: workAs.hidden
        ? null
        : agents.value === NEW_AGENT
          ? { create: { name: agentName.value, handle: agentHandle.value } }
          : { id: agents.value },
    };
    reviewConnect(h, () => api.planConnect(choice));
  });
  fillAgents();
  return { form, fill: fillAgents };
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
  const here = view.harnesses.filter((h) => h.installed || h.connected);
  const away = view.harnesses.filter((h) => !h.installed && !h.connected);
  const addsCommand = !view.cli.found && view.cli.linkInto !== null;
  // Where the tools newly set up stand, as far as known in a moment; a card not answered by then asks itself, and
  // one set up already asks on its own.
  const known = new Map<string, Handshake | null>();
  const asked = here
    .filter((h) => h.connected && !shownCards.get(h.id)?.card.isSetUp)
    .map((h) => api.toolHandshake(h.id).then((handshake) => void known.set(h.id, handshake)));
  await Promise.race([Promise.all(asked), new Promise((done) => setTimeout(done, FIRST_LOOK_MS))]);
  placeCards(here, addsCommand, known);
  await showTarget();
  if (!shownOnce) {
    shownOnce = true;
    letInputIn(element("connect"), target?.openedByPage ?? false);
  }
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
  others.replaceChildren(make("span", "Not on this computer:", "lbl"), separated(away.map((h) => h.name)));
}

/**
 * Shows a card for each of `here`, in order: a tool's card kept and changed
 * in place, a new one only for a tool not shown before or whose card's
 * making changed (whom it works as); a card moved only when the order did.
 */
function placeCards(here: HarnessView[], addsCommand: boolean, known: Map<string, Handshake | null>) {
  for (const [id, shown] of shownCards) {
    if (here.some((h) => h.id === id)) continue;
    shown.card.element.remove();
    shownCards.delete(id);
  }
  here.forEach((h, i) => {
    const made = JSON.stringify([
      h.id,
      h.name,
      h.initials,
      h.cliIdentity,
      h.listenVerified,
      h.chatListens,
      workingAs(h),
      mcpOnly(h),
    ]);
    const kept = shownCards.get(h.id);
    const handshake = known.get(h.id) ?? null;
    let shown: Shown;
    if (kept && kept.made === made) {
      shown = kept;
      updateCard(shown, h, addsCommand, handshake);
    } else {
      kept?.card.element.remove();
      shown = newCard(h, made, addsCommand, handshake);
      shownCards.set(h.id, shown);
    }
    const at = cardsBox.children[i];
    if (at !== shown.card.element) cardsBox.insertBefore(shown.card.element, at ?? null);
  });
}

/** Connected by MCP alone: without the quadit command and its skill, which listening needs. */
function mcpOnly(h: HarnessView): boolean {
  return !!h.connected && !h.connected.methods.includes("cli");
}

/** Whom a tool without a login of its own works as: this computer's default login, as the last look found it. */
function workingAs(h: HarnessView): string | null {
  return h.cliIdentity === "default" ? defaultLoginWords(defaultLogin) : null;
}

/** The workspace the window under this page shows (it changes as its page publishes), and its agents in the options. */
async function showTarget() {
  target = await api.connectTarget();
  const at = chosen();
  element("where").textContent = at ? `For ${at.summary.workspace.name} on ${target?.serverName ?? ""}.` : "";
  const openedBy = element("opened-by");
  openedBy.hidden = !target?.openedByPage;
  openedBy.textContent = target?.openedByPage ? `Opened by ${target.serverName}` : "";
  element("no-workspace").hidden = !!at;
  for (const shown of shownCards.values()) shown.fill?.();
}

// The steps to an agent that answers, and the other ways, named so a person who wants one knows it is there:
// MCP has no listening (no lease: docs/agents.md), and the rest are set up outside this page.
const how = listenSteps();
how.append(
  make(
    "p",
    "Other ways: MCP (under More options) gives a tool Quadit’s tools in its chats, but cannot listen. To answer with no chat open, run a companion command in a terminal or set up a webhook: docs/agents.md in Quadit’s repository says how.",
    "how-other",
  ),
);
element("tools").prepend(how);
element("backups").addEventListener("click", () => void api.showBackups());
element("done").addEventListener("click", () => void api.closeConnect());
// Escape goes back to the page under this one; with the sheet open, it closes the sheet (files-sheet.ts).
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || document.querySelector("dialog[open]")) return;
  event.preventDefault();
  void api.closeConnect();
});

// What the window shows changes as its page publishes; the harnesses only when the page asks again.
api.onChanged(() => void showTarget());
void render();
