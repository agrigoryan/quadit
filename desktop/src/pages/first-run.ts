// The first run's page (src/main/first-run.ts; desktop contract §10), laid
// over the window it ends in. Two steps:
//   1. Welcome: the person's name and "Set up on this computer", which turns
//      into its own progress and, failing, into "Try again" with the reason;
//      or "Connect to a server instead", the address form (on Windows, the
//      only way). A server added there takes the window: the first run is over.
//   2. Connect your AI tools: looking (at least about a second:
//      shared/looking.ts), then a card per tool found (tool-card.ts), the
//      tools not here in a line, and beside them the workspace's members, each
//      found tool a place that fills when it connects, and an example of a
//      task handed to an agent. Continue (Enter) or Skip ends it: the sample
//      tasks are made, the workspace shows on them, and this page goes.
// Each change of step slides and fades for 200 ms; with reduced motion,
// nothing moves (first-run.css).

import { element, make } from "@/pages/dom";
import { openSheet } from "@/pages/files-sheet";
import { tile, ToolCard } from "@/pages/tool-card";
import { countWord } from "@/shared/change-words";
import { lookingPace } from "@/shared/looking";
import type { FoundTools, PagesApi, ToolView } from "@/shared/pages-api";

const api = window.quaditPages as PagesApi;
const stillMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
/** How long a change of step, and the page's going, take (first-run.css's --step). */
const STEP_MS = 200;
/** The first run's steps, as its dots show them; a step added later is one more name here. */
const STEPS = ["Welcome", "Connect your AI tools"];

const welcome = element<HTMLElement>("welcome");
const toolsStep = element<HTMLElement>("tools-step");

// Step 1.
const here = element<HTMLFormElement>("here");
const nameInput = here.elements.namedItem("name") as HTMLInputElement;
const go = element<HTMLButtonElement>("go");
const fine = element<HTMLParagraphElement>("fine");
const toConnect = element<HTMLButtonElement>("to-connect");
const connectForm = element<HTMLFormElement>("connect");
const address = connectForm.elements.namedItem("address") as HTMLInputElement;
const add = element<HTMLButtonElement>("add");
const connectError = element<HTMLParagraphElement>("connect-error");
const addInsecure = element<HTMLButtonElement>("add-insecure");
const toHere = element<HTMLButtonElement>("to-here");

const FINE_HERE = "Quadit runs on this computer while the app is open. Nothing else to install, no password to choose.";
const FINE_KEPT = "Quadit on this computer still has its data from before: setting it up opens it again.";
let fineAtRest = FINE_HERE;

/** The person's name as they gave it, for the members and the example. */
let person = "";

function showDots(at: number) {
  for (const list of document.querySelectorAll<HTMLOListElement>("ol.dots")) {
    list.replaceChildren(...STEPS.map((_step, i) => make("li", "", i === at ? "on" : "")));
    list.setAttribute("aria-label", `Step ${at + 1} of ${STEPS.length}: ${STEPS[at]}`);
  }
}

/** Which of Welcome's forms shows. */
function showForm(which: "here" | "connect", canSetUpHere: boolean) {
  here.hidden = which !== "here";
  connectForm.hidden = which !== "connect";
  toHere.hidden = !canSetUpHere;
  (which === "here" ? nameInput : address).focus();
}

/**
 * Welcome's main button and the line under it: at rest, starting, failed
 * (the button tries again), or asking for the name.
 */
function setUpState(state: { kind: "rest" } | { kind: "starting" } | { kind: "failed" | "asking"; reason: string }) {
  const starting = state.kind === "starting";
  const said = state.kind === "failed" || state.kind === "asking";
  welcome.classList.toggle("starting", starting);
  nameInput.readOnly = starting;
  toConnect.disabled = starting;
  go.disabled = starting;
  fine.classList.toggle("error", said);
  fine.setAttribute("role", said ? "alert" : "status");
  if (starting) {
    nameInput.blur();
    go.replaceChildren(make("span", "", "spinner"), document.createTextNode("Starting Quadit…"));
    fine.textContent = "Making your workspace. This takes a few seconds the first time.";
  } else if (said) {
    go.textContent = state.kind === "failed" ? "Try again" : "Set up on this computer";
    fine.textContent = state.reason;
  } else {
    go.textContent = "Set up on this computer";
    fine.textContent = fineAtRest;
  }
}

async function setUp() {
  const name = nameInput.value.trim();
  if (!name) {
    setUpState({ kind: "asking", reason: "Type your name first." });
    nameInput.focus();
    return;
  }
  setUpState({ kind: "starting" });
  const done = await api.setUpHere(name);
  if (!done.ok) {
    setUpState({ kind: "failed", reason: done.error });
    go.focus();
    return;
  }
  person = name;
  // Set up before, its data kept: the app signed in, and the workspace is there under this page.
  if (done.next === "workspace") {
    await leave();
    return;
  }
  nextStep();
  void look();
}

/** Adds the server the address form holds; `allowInsecure` is the person's yes to a plain http address. */
async function addServer(allowInsecure: boolean) {
  connectError.textContent = "";
  addInsecure.hidden = true;
  add.disabled = true;
  const done = await api.connectServer(address.value, allowInsecure);
  add.disabled = false;
  // Added: its window is this one, on its sign-in page, and the app has taken this page away.
  if (done.ok) return;
  connectError.textContent = done.error;
  addInsecure.hidden = !done.insecure;
}

/** From Welcome to the tools step: Welcome slides out to the left, the step in from the right. */
function nextStep() {
  showDots(1);
  welcome.inert = true;
  toolsStep.hidden = false;
  welcome.classList.add("leaving");
  // Both steps move in the same paint. With reduced motion there is nothing to wait for.
  void Promise.allSettled(welcome.getAnimations().map((animation) => animation.finished)).then(() => {
    welcome.hidden = true;
  });
  element<HTMLButtonElement>("continue").focus();
}

// Step 2.
const looking = element<HTMLElement>("looking");
const checking = element<HTMLParagraphElement>("checking");
const found = element<HTMLElement>("found");
const none = element<HTMLElement>("none");
const cardsBox = element<HTMLDivElement>("cards");
const connectAll = element<HTMLButtonElement>("connect-all");
const skip = element<HTMLButtonElement>("skip");
const later = element<HTMLSpanElement>("later");
const cont = element<HTMLButtonElement>("continue");
const finishError = element<HTMLSpanElement>("finish-error");

/** Every tool Connect knows, as the last look found them, and the cards of those found, in the order shown. */
let tools: ToolView[] = [];
let cards: ToolCard[] = [];
/**
 * The tools connected in this step, in the order they were, with the handle
 * of the workspace's agent each works as (null: none of this workspace, a
 * tool on this computer's login elsewhere). The first with an agent gets the
 * third sample task.
 */
const connectedAs = new Map<string, string | null>();
/** Continue or Skip was pressed: nothing new is started, and Connect all stops. */
let finishing = false;

async function look() {
  const began = performance.now();
  stage("looking");
  looking.hidden = false;
  found.hidden = true;
  none.hidden = true;
  checking.replaceChildren();
  cards = [];
  connectedAs.clear();
  renderProgress();
  const result = await api.lookForTools();
  await goDown(result.tools, lookingPace(result.tools.length, performance.now() - began));
  tools = result.tools;
  const onComputer = tools.filter((t) => t.found);
  looking.hidden = true;
  if (onComputer.length === 0) {
    showNone();
    return;
  }
  showFound(result, onComputer);
}

/** Goes down the tools' names `pace` ms each, marking those found: what looking looks like. */
async function goDown(all: ToolView[], pace: number) {
  const names = all.map((tool) => {
    const name = make("span");
    name.append(tile(tool.initials, "sm"), document.createTextNode(tool.name));
    return name;
  });
  checking.replaceChildren(...names);
  if (stillMotion()) {
    await wait(pace * all.length);
    names.forEach((name, i) => all[i]?.found && name.classList.add("hit"));
    return;
  }
  for (const [i, name] of names.entries()) {
    name.classList.add("now");
    await wait(pace);
    name.classList.remove("now");
    if (all[i]?.found) name.classList.add("hit");
  }
}

function showFound(result: FoundTools, onComputer: ToolView[]) {
  stage("found");
  let addsCommand = result.addsCommand;
  cards = onComputer.map((tool, i) => {
    const card: ToolCard = new ToolCard(tool, addsCommand, {
      connect: (planId) => api.connectTool(tool.id, planId),
      back: { label: "Undo", run: () => api.disconnectTool(tool.id) },
      // Its Connect carries out the plan shown, which the app keeps for it.
      seeFiles: () =>
        openSheet({
          tool,
          kind: "connect",
          plan: () => api.toolChanges(tool.id),
          action: card.isConnected ? undefined : { label: `Connect ${tool.name}`, run: (planId) => card.run(planId) },
        }),
      changed: (connected, agent) => {
        if (connected && addsCommand) {
          addsCommand = false;
          for (const other of cards) other.commandAdded();
        }
        if (connected) connectedAs.set(tool.id, agent);
        else connectedAs.delete(tool.id);
        renderProgress();
      },
    });
    // One after another.
    card.element.style.setProperty("--arrive", `${i * 90}ms`);
    return card;
  });
  cardsBox.replaceChildren(...cards.map((card) => card.element));
  element("found-lead").textContent =
    onComputer.length === 1
      ? "Quadit found one on this computer. Connected, it joins your workspace as a member."
      : `Quadit found ${countWord(onComputer.length)} on this computer. Connected, each one joins your workspace as a member.`;
  const others = element<HTMLParagraphElement>("others");
  const away = tools.filter((t) => !t.found);
  others.hidden = away.length === 0;
  others.replaceChildren(make("span", "Not on this computer:", "lbl"), ...away.map((t) => make("span", t.name, "o")));
  found.hidden = false;
  renderProgress();
}

function showNone() {
  stage("none");
  element("all-tools").replaceChildren(
    ...tools.map((tool) => {
      const item = make("li");
      item.append(tile(tool.initials), document.createTextNode(tool.name));
      return item;
    }),
  );
  none.hidden = false;
  renderProgress();
}

/** What changes as tools connect: the count, Connect all, the footer, the members and the example. */
function renderProgress() {
  const total = cards.length;
  const done = connectedAs.size;
  const left = total - done;
  element("count").textContent =
    done === 0 ? `${total} found` : left === 0 ? `${done} connected` : `${done} connected, ${left} to go`;
  connectAll.hidden = left < 2;
  connectAll.textContent = left === 2 ? "Connect both (2)" : `Connect all (${left})`;
  skip.hidden = done > 0;
  later.textContent =
    done > 0 ? "Connect more later from the Agents page." : "You can do this later from the Agents page.";
  renderMembers();
}

/** Where the page is in the tools step, for the stage's look. */
function stage(state: "looking" | "found" | "none") {
  document.body.dataset.state = state;
  drawField(state === "looking");
}

const AGENT_COLOURS = ["#1f8f84", "#4a63d8", "#8a5bd6", "#c0703a", "#3b8fc4", "#b5487e", "#5f8f3a", "#7a6ad8"];

/** An avatar: a person's round one, or an agent's, filled once it is a member and drawn in outline before. */
function avatar(initials: string, kind: "person" | "agent" | "place", colour = "", small = false): HTMLSpanElement {
  const made = make("span", kind === "place" && !initials ? "" : initials, `av${small ? " sm" : ""}`);
  made.setAttribute("aria-hidden", "true");
  if (kind !== "person") made.classList.add("agent");
  if (kind === "place") made.classList.add("ghost-av");
  else made.style.background = colour;
  return made;
}

function member(av: HTMLElement, name: string, sub: string, tag: string, tagClass = "", ghost = false): HTMLLIElement {
  const row = make("li", "", ghost ? "mem ghosted" : "mem");
  const who = make("span", "", "who");
  who.append(make("b", name));
  if (sub) who.append(make("small", sub));
  row.append(av, who, make("span", tag, `tag ${tagClass}`.trim()));
  return row;
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words.length > 1 ? (words.at(-1)?.[0] ?? "") : "")).toUpperCase();
}

/** The members pane and the example: the person, a place for each tool found, filled as it connects. */
function renderMembers() {
  const list = element<HTMLUListElement>("members");
  const rows = [member(avatar(initialsOf(person), "person", "#b5487e"), person, "You", "Owner")];
  const state = document.body.dataset.state;
  const colourOf = (id: string) => AGENT_COLOURS[cards.findIndex((c) => c.tool.id === id) % AGENT_COLOURS.length] ?? "";
  if (state === "looking") {
    const place = member(avatar("", "place"), "", "", "", "", true);
    place.querySelector("b")?.classList.add("bar-ghost");
    rows.push(place);
  } else if (state === "none") {
    rows.push(member(avatar("", "place"), "Your first agent", "", "Joins here", "", true));
  } else {
    for (const card of cards) {
      const { tool } = card;
      const agent = connectedAs.get(tool.id);
      rows.push(
        agent
          ? member(
              avatar(tool.initials, "agent", colourOf(tool.id)),
              tool.name,
              `Agent @${agent}`,
              "Joined just now",
              "ok",
            )
          : card.isConnected
            ? // Connected as this computer's login, which is no agent of this workspace.
              member(
                avatar(tool.initials, "place"),
                tool.name,
                `Works as ${tool.worksAs ?? "this computer's login"}`,
                "Not a member here",
                "",
                true,
              )
            : member(avatar(tool.initials, "place"), tool.name, "", "Not connected", "", true),
      );
    }
  }
  list.replaceChildren(...rows);
  const agents = [...connectedAs.values()].filter(Boolean).length;
  element("member-count").textContent =
    agents === 0 ? "1 person" : `1 person, ${agents} ${agents === 1 ? "agent" : "agents"}`;

  // The example: a task like the third sample, handed to the first tool connected (or the first found).
  const example = element<HTMLElement>("example");
  example.hidden = state === "looking";
  const first = person.split(/\s+/)[0] || "you";
  element("example-title").textContent = `Say hello and tell ${first} what you can do`;
  const firstAgent = [...connectedAs].find(([, agent]) => agent)?.[0];
  const connectedFirst = cards.find((c) => c.tool.id === firstAgent);
  const shown = connectedFirst ?? cards[0];
  const agentName = shown?.tool.name ?? "Your agent";
  const filled = !!connectedFirst;
  const exampleAvatar = () =>
    filled && shown
      ? avatar(shown.tool.initials, "agent", colourOf(shown.tool.id), true)
      : avatar("", "place", "", true);
  element("example-avatar").replaceChildren(exampleAvatar());
  element("example-assignee").textContent = agentName;
  const events: [string, () => (Node | string)[]][] = [
    ["took the task and moved it to", () => [make("span", "In progress", "pill blue")]],
    ["asked you:", () => [make("q", "Which project should I start with?")]],
    ["posted a result and marked it", () => [make("span", "Done", "pill quiet")]],
  ];
  element("feed").replaceChildren(
    ...events.map(([said, more]) => {
      const row = make("li", "", "ev");
      const text = make("span");
      text.append(make("b", agentName), ` ${said} `, ...more());
      row.append(exampleAvatar(), text);
      return row;
    }),
  );
}

/**
 * Continue or Skip: once what was asked before is done, the workspace's
 * samples are asked for and the window shows them; then this page fades
 * away. A failure is said beside the buttons, and Continue tries again.
 */
async function finish() {
  finishing = true;
  found.inert = true;
  none.inert = true;
  cont.disabled = true;
  skip.disabled = true;
  finishError.textContent = "";
  const done = await api.finishFirstRun();
  if (done.ok) {
    await leave();
    return;
  }
  finishing = false;
  found.inert = false;
  none.inert = false;
  cont.disabled = false;
  skip.disabled = false;
  cont.textContent = "Try again";
  finishError.textContent = done.error;
}

/** The first run is over: this page fades, showing the window under it, and goes. */
async function leave() {
  if (!stillMotion()) {
    document.body.classList.add("leaving");
    await wait(STEP_MS);
  }
  await api.endFirstRun();
}

/** The field of small squares behind the stage, after the website's hero; `searching`: a band of light across it. */
function drawField(searching: boolean) {
  const box = document.querySelector<HTMLElement>(".field-of-squares");
  if (!box) return;
  const { width, height } = box.getBoundingClientRect();
  let canvas = box.querySelector("canvas");
  if (!canvas) {
    canvas = document.createElement("canvas");
    box.append(canvas);
  }
  const ratio = devicePixelRatio;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const g = canvas.getContext("2d");
  if (!g) return;
  g.scale(ratio, ratio);
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pitch = 18;
  const size = 10;
  for (let y = 0; y < Math.ceil(height / pitch); y++) {
    for (let x = 0; x < Math.ceil(width / pitch); x++) {
      let alpha = 0.018 + random() * 0.022;
      if (random() > 0.975) alpha = 0.07 + random() * 0.06;
      if (searching) {
        const d = Math.abs(x * 0.8 + y * 0.45 - 22);
        if (d < 4) alpha += (4 - d) * 0.022 * (0.6 + random() * 0.6);
      }
      g.beginPath();
      g.roundRect(x * pitch + 6, y * pitch + 6, size, size, 3);
      g.fillStyle = `rgba(170,185,255,${alpha})`;
      g.fill();
    }
  }
  // Fades towards the panes, so that it never competes with them.
  const fade = g.createRadialGradient(width * 0.5, height * 0.42, 60, width * 0.5, height * 0.42, width * 0.75);
  fade.addColorStop(0, "rgba(15,16,21,0.75)");
  fade.addColorStop(1, "rgba(15,16,21,0)");
  g.fillStyle = fade;
  g.fillRect(0, 0, width, height);
}

function wait(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

here.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!welcome.classList.contains("starting")) void setUp();
});
toConnect.addEventListener("click", () => showForm("connect", true));
toHere.addEventListener("click", () => showForm("here", true));
connectForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void addServer(false);
});
addInsecure.addEventListener("click", () => void addServer(true));
// The yes was for the address shown: another address asks again.
address.addEventListener("input", () => (addInsecure.hidden = true));
/** Connects the tools not connected yet, one after another. */
async function connectTheRest() {
  connectAll.disabled = true;
  for (const card of cards) {
    if (finishing) break;
    if (!card.isConnected) await card.run();
  }
  connectAll.disabled = false;
}

connectAll.addEventListener("click", () => void connectTheRest());
element("look-again").addEventListener("click", () => void look());
cont.addEventListener("click", () => void finish());
skip.addEventListener("click", () => void finish());
// Enter continues, wherever it is not a control's own key.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || toolsStep.hidden || cont.disabled || document.querySelector("dialog.sheet[open]"))
    return;
  if (event.target instanceof Element && event.target.closest("button, a, input, select, textarea, summary")) return;
  event.preventDefault();
  void finish();
});
addEventListener("resize", () => {
  if (!toolsStep.hidden) drawField(document.body.dataset.state === "looking");
});

async function start() {
  showDots(0);
  const [step, local, name] = await Promise.all([
    api.firstRunStep(),
    api.localServer(),
    api.accountName().catch(() => ""),
  ]);
  // Resumed after the account was made (the app quit during the tools step): straight to it.
  if (step.step === "tools") {
    person = step.person;
    welcome.hidden = true;
    showDots(1);
    toolsStep.hidden = false;
    cont.focus();
    void look();
    return;
  }
  if (!local.available) {
    showForm("connect", false);
    return;
  }
  nameInput.value = name;
  fineAtRest = local.dataKept ? FINE_KEPT : FINE_HERE;
  setUpState({ kind: "rest" });
  showForm("here", true);
}

void start();
