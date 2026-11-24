// "Run by Quadit" on a connected Claude Code's or Codex's card
// (agent-runs-contract.md §8.2), in Connect agents and the first run's tools
// step: Quadit starts the program for the agent's tasks of a project, in the
// project's folder on this computer, whenever the person assigns the agent
// a task there or comments on one (main/runner.ts runs `quadit run`). Its
// states:
//   none      what it would do, and "Run by Quadit…";
//   choosing  in the card, no window: which project, which folder (the
//             native picker), what running there means and whose words
//             start it, then "Start running" or "Cancel"; a refusal shows
//             under the folder, as quadit run said it;
//   running   a line for each project it runs, with what it does now and
//             "Stop running", writes the server refused said under it;
//             then "Run another project…" and "Show log".
// Its nodes are kept and their text changed when what they show changes, so
// focus on a control survives the lines under it changing. The card asks
// for its entries every couple of seconds while it is shown (tool-card.ts).
// Styled by tools.css.

import { button, make } from "@/pages/dom";
import type { Owner, PagesApi, RunEntryView, RunsView, RunWaiting } from "@/shared/pages-api";

/** The app's pages API, asked only once the card is on its page. */
const api = () => window.quaditPages as PagesApi;

/** What a Run by Quadit line is about: the program ("Claude Code"), and what the card calls this computer. */
export interface RunWords {
  program: string;
  here: string;
}

/**
 * What the card says when Quadit runs no project for the agent yet: whose
 * words start it, the person here's when they answer for the agent, else
 * that person's (`owner`), while it runs under this person's account.
 */
export function offerLine({ program, here }: RunWords, agent: string, owner: Owner): string {
  return owner.me
    ? `Quadit can start ${program} for you when you assign ${agent} a task or comment on one, in the project’s folder on ${here}.`
    : `Quadit can start ${program} under your account when @${owner.handle} assigns ${agent} a task or writes to it on one, in the project’s folder on ${here}.`;
}

/** What running in a folder means, and whose words start a run (decision 8), said before the person starts it. */
export function choosingNote({ program, here }: RunWords, agent: string, project: string | null, owner: Owner): string {
  const where = project ?? "the project";
  return owner.me
    ? `${program} runs there with full access, as you, whenever you assign ${agent} a task in ${where} or comment on one. Only your words, or those of your other agents, start it.`
    : `${program} runs there with full access, under your account on ${here}, whenever @${owner.handle} assigns ${agent} a task in ${where} or writes to it on one. Only @${owner.handle}’s words, or those of @${owner.handle}’s other agents, start it.`;
}

/**
 * What Start running starts at once, said before it is pressed: the task
 * that waits on the agent, or how many do and the first few of them, one
 * run after another; nothing when none waits.
 */
export function waitingWords(waiting: RunWaiting): { lead: string; tasks: string[]; more: string | null } | null {
  const tasks = waiting.tasks.map((t) => `${t.key} ${oneLine(t.title)}`);
  const [first] = tasks;
  if (waiting.runs === 0 || !first) return null;
  if (waiting.runs === 1)
    return { lead: `Starts now on ${/[.!?…]$/.test(first) ? first : `${first}.`}`, tasks: [], more: null };
  const rest = waiting.runs - tasks.length;
  return {
    lead: `Starts now on ${waiting.runs} tasks that wait on ${waiting.agent}, one after another:`,
    tasks,
    more: rest > 0 ? `and ${rest} more` : null,
  };
}

/** A title on one line: its first line, cut short. */
function oneLine(title: string): string {
  const line = title.split("\n", 1)[0]?.trim() ?? "";
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}

/** Why Quadit offers no run of the agent: it cannot tell whose words would start one. */
export function noOwnerLine(agent: string): string {
  return `Quadit cannot tell who answers for ${agent}, so it does not offer to run it.`;
}

/** What the card says when the list of what Quadit runs could not be read. */
export function unreadableLine({ here }: RunWords): string {
  return `Quadit could not read which projects it runs on ${here}. It tries again in a moment.`;
}

/** What an entry is: the project and its folder. */
export function entryLine(entry: Pick<RunEntryView, "project" | "folder">): string {
  return `Runs ${entry.project} in ${entry.folder}.`;
}

/** What an entry does now. */
export function statusLine({ program, here }: RunWords, entry: RunEntryView, now = new Date()): string {
  const { status } = entry;
  switch (status.state) {
    case "starting":
      return "Starting…";
    case "ready":
      return "Ready.";
    case "working":
      return `Working on ${status.task}.`;
    case "aside":
      return `A chat listens to ${entry.project} now. Quadit runs it again when that chat stops.`;
    case "removing":
      return "Stopping…";
    case "error":
      return `Not running: ${status.message}`;
    case "not_served":
      return status.message;
    case "paused":
      switch (status.pause) {
        case "usage_limit":
          return status.until
            ? `Paused until ${untilWords(status.until, now)}: ${program}’s usage limit.`
            : `Paused: ${program}’s usage limit.`;
        case "not_signed_in":
          return `Paused: ${program} is not signed in. Open ${program} and sign in.`;
        case "program_missing":
          return `Paused: ${program} was not found on ${here}.`;
        case "folder_missing":
          return "Paused: the folder is gone. Stop running and pick it again.";
        case "login_mismatch":
          return `Paused: ${program} is set to work as another agent. Connect it again.`;
        case "server_old":
          return "Paused: this server needs an update to run agents.";
      }
  }
}

/** A write about a run that the server refused for good. */
export function blockedLine(blocked: RunEntryView["blocked"][number]): string {
  return `Quadit could not record how a run on ${blocked.task} ended (${blocked.error}).`;
}

/** When a pause ends, as a person reads it: the time, with the day when it is not today. */
export function untilWords(iso: string, now = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return at.toDateString() === now.toDateString()
    ? time
    : `${at.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

/** How an entry's line is coloured: well, at work, held back, or not running. */
function toneOf(status: RunEntryView["status"]): string {
  switch (status.state) {
    case "ready":
      return "ok";
    case "working":
      return "busy";
    case "paused":
    case "aside":
      return "wait";
    case "error":
    case "not_served":
      return "fail";
    default:
      return "";
  }
}

/** How long Start running waits for what it starts at once to be told: a slow server does not hold it longer. */
const WAITING_WAIT_MS = 2_000;

/**
 * Whether Start running may be pressed: a project and a folder chosen, what
 * it starts at once told (not still `asking`), and nothing under way.
 */
export function mayStart(chosen: { project: string; folder: string | null; asking: boolean; busy: boolean }): boolean {
  return !!chosen.project && !!chosen.folder && !chosen.asking && !chosen.busy;
}

/** An entry's nodes, kept while it is there. */
interface Row {
  box: HTMLDivElement;
  what: HTMLSpanElement;
  status: HTMLSpanElement;
  stop: HTMLButtonElement;
  blocked: HTMLDivElement;
  /** What its blocked lines were drawn from. */
  drawn: string;
}

export class RunByQuadit {
  readonly element: HTMLElement;
  private words: RunWords;
  private runs: RunsView | null = null;
  private rows = new Map<string, Row>();
  private offer: HTMLDivElement;
  private offerText: HTMLParagraphElement;
  private offerButton: HTMLButtonElement;
  private list: HTMLDivElement;
  private more: HTMLParagraphElement;
  private another: HTMLButtonElement;
  private error: HTMLParagraphElement;
  /** Whether the card has said what Quadit runs (show) at least once. */
  private known = false;
  /** The choice is to open once it is offered (want). */
  private wanted = false;
  /** Who answers for the agent; null: not known, and nothing is offered. */
  private owner: Owner | null = null;
  /** Why nothing is offered, or nothing is shown (the list unreadable): one quiet line. */
  private quiet: HTMLParagraphElement;
  /** The form while the person chooses; null otherwise. */
  private choosing: { form: HTMLFormElement; note: HTMLParagraphElement } | null = null;

  constructor(
    private tool: { id: string; name: string },
    here: string,
  ) {
    this.words = { program: tool.name, here };
    const section = make("section", "", "runs");
    section.setAttribute("aria-label", `Run by Quadit for ${tool.name}`);
    this.offer = make("div", "", "run-offer");
    this.offerText = make("p", "", "run-said");
    this.offerButton = button("Run by Quadit…", () => this.choose(), "btn btn-line btn-sm", "");
    this.offer.append(this.offerText, this.offerButton);
    this.list = make("div", "", "run-list");
    this.more = make("p", "", "run-more");
    this.another = button("Run another project…", () => this.choose(), "link-blue");
    this.more.append(
      this.another,
      button("Show log", () => void api().showRunnerLog(), "link-blue", "Show the log of Quadit’s runner"),
    );
    this.error = make("p", "", "card-error");
    this.error.setAttribute("role", "alert");
    this.quiet = make("p", "", "run-said");
    section.append(this.offer, this.list, this.more, this.quiet, this.error);
    this.element = section;
    this.element.hidden = true;
  }

  /**
   * Opens the choice as soon as it is offered (a page asked for it: Connect
   * agents opened to run this agent), once what Quadit runs is known; when
   * it is not offered then, nothing.
   */
  want() {
    this.wanted = true;
    if (this.known) this.settleWant();
  }

  private settleWant() {
    if (!this.wanted) return;
    this.wanted = false;
    if (this.runs && this.owner && !this.runs.unreadable) this.choose();
  }

  /**
   * Shows what Quadit runs for the tool's agent (`runs`), or nothing (null:
   * the tool is not connected, or cannot be run); `owner`, who answers for
   * the agent (null: not known, and no run is offered).
   */
  show(runs: RunsView | null, owner: Owner | null) {
    this.runs = runs;
    this.owner = owner;
    this.known = true;
    this.element.hidden = runs === null;
    if (!runs) {
      this.close();
      this.settleWant();
      return;
    }
    const { entries, agent } = runs;
    if (!owner || runs.unreadable) this.close();
    setText(this.quiet, runs.unreadable ? unreadableLine(this.words) : owner ? "" : noOwnerLine(agent));
    if (owner) setText(this.offerText, offerLine(this.words, agent, owner));
    this.offerButton.setAttribute("aria-label", `Run ${this.tool.name} by Quadit for a project`);
    this.another.setAttribute("aria-label", `Run ${agent} by Quadit for another project`);
    if (this.choosing && owner)
      setText(this.choosing.note, choosingNote(this.words, agent, this.chosenProject(), owner));

    // A row for each entry, kept while it is there; one gone takes its focus to the control that stays.
    const focusLost = [...this.rows.entries()].some(
      ([id, row]) => !entries.some((e) => e.id === id) && row.box.contains(document.activeElement),
    );
    for (const [id, row] of this.rows) {
      if (entries.some((e) => e.id === id)) continue;
      row.box.remove();
      this.rows.delete(id);
    }
    for (const entry of entries) {
      const row = this.rows.get(entry.id) ?? this.newRow(entry, agent);
      setText(row.what, entryLine(entry));
      setText(row.status, statusLine(this.words, entry));
      row.status.className = `run-status ${toneOf(entry.status)}`.trim();
      row.stop.disabled = entry.status.state === "removing" || row.stop.dataset.busy === "1";
      const blocked = JSON.stringify(entry.blocked);
      if (blocked !== row.drawn) {
        row.drawn = blocked;
        row.blocked.replaceChildren(
          ...entry.blocked.map((b) => {
            const line = make("p", "", "run-blocked");
            line.append(
              make("span", blockedLine(b)),
              " ",
              button("Show log", () => void api().showRunnerLog(), "link-blue", "Show the log of Quadit’s runner"),
            );
            return line;
          }),
        );
      }
    }
    // Rows in the order the registry lists them, each moved only when out of place (a move takes focus away).
    entries.forEach((entry, at) => {
      const row = this.rows.get(entry.id);
      const there = this.list.children[at] ?? null;
      if (row && there !== row.box) this.list.insertBefore(row.box, there);
    });
    this.place();
    if (focusLost) (entries.length > 0 ? this.another : this.offerButton).focus();
    this.settleWant();
  }

  /**
   * Which of the parts show: the offer with no entry, the lines and what is
   * under them with some, the form while choosing; with the list unreadable,
   * only its line; with no one known to answer for the agent, the lines and
   * why nothing is offered.
   */
  private place() {
    const unread = !!this.runs?.unreadable;
    const offered = !!this.owner && !unread;
    const some = (this.runs?.entries.length ?? 0) > 0 && !unread;
    this.offer.hidden = some || !!this.choosing || !offered;
    this.list.hidden = !some;
    this.more.hidden = !some || !!this.choosing || !offered;
    this.quiet.hidden = !this.quiet.textContent;
  }

  private newRow(entry: RunEntryView, agent: string): Row {
    const box = make("div", "", "run-entry");
    const line = make("p", "", "run-line");
    const what = make("span", "", "run-what");
    const status = make("span", "", "run-status");
    line.append(what, " ", status);
    const stop = button(
      "Stop running",
      () => void this.stop(entry.id, stop),
      "undo",
      `Stop running ${entry.project} for ${agent}`,
    );
    const head = make("div", "", "run-head");
    head.append(line, stop);
    const blocked = make("div", "", "run-blocked-lines");
    box.append(head, blocked);
    const row: Row = { box, what, status, stop, blocked, drawn: "" };
    this.rows.set(entry.id, row);
    return row;
  }

  /** Asks the app for the entries now (after the person changed them). */
  private async refresh() {
    this.show(await api().runEntries(this.tool.id), this.owner);
  }

  private async stop(entryId: string, control: HTMLButtonElement) {
    this.error.textContent = "";
    control.disabled = true;
    control.dataset.busy = "1";
    const done = await api().stopRunning(this.tool.id, entryId);
    delete control.dataset.busy;
    control.disabled = false;
    if (!done.ok) this.error.textContent = done.error;
    await this.refresh();
  }

  /** The project chosen in the form, if any. */
  private chosenProject(): string | null {
    return this.choosing?.form.querySelector("select")?.value || null;
  }

  /** Opens the form in the card: which project, which folder, and what that means. */
  private choose() {
    if (this.choosing || !this.runs || !this.owner) return;
    this.error.textContent = "";
    const { agent, entries } = this.runs;
    const id = `run-${this.tool.id}`;
    const form = make("form", "", "run-choose");
    form.noValidate = true;
    form.setAttribute("aria-label", `Run ${this.tool.name} by Quadit for a project`);

    const projectLabel = make("label", "Which project?", "run-ask");
    projectLabel.htmlFor = `${id}-project`;
    const select = make("select", "", "run-select");
    select.id = `${id}-project`;
    select.append(new Option("Loading projects…", ""));
    const projectError = make("p", "", "card-error");
    projectError.setAttribute("role", "alert");

    const folderLabel = make("p", "In which folder?", "run-ask");
    folderLabel.id = `${id}-folder`;
    let folder: string | null = null;
    const shown = make("code", "", "run-folder");
    shown.hidden = true;
    const pick = button(
      "Choose folder…",
      () =>
        void api()
          .pickFolder()
          .then((picked) => {
            if (!picked) return;
            folder = picked.path;
            shown.textContent = picked.shown;
            shown.hidden = false;
            update();
          }),
      "btn btn-line btn-sm",
    );
    pick.setAttribute("aria-describedby", folderLabel.id);
    const folderRow = make("div", "", "run-folder-row");
    folderRow.append(pick, shown);
    const refused = make("p", "", "card-error");
    refused.setAttribute("role", "alert");

    const note = make("p", "", "run-note");
    // What Start running starts at once, for the project chosen: said once known, nothing meanwhile. Start running
    // waits for it, so the person sees what starts before starting it, but not past WAITING_WAIT_MS.
    const waits = make("div", "", "run-waits");
    waits.setAttribute("aria-live", "polite");
    let askedFor = "";
    let asking = false;
    let waitEnd: ReturnType<typeof setTimeout> | undefined;
    const askWaiting = () => {
      const project = select.value;
      if (project === askedFor) return;
      askedFor = project;
      waits.replaceChildren();
      clearTimeout(waitEnd);
      asking = !!project;
      if (!project) return;
      const answered = () => {
        if (askedFor !== project || !asking) return;
        clearTimeout(waitEnd);
        asking = false;
        update();
      };
      waitEnd = setTimeout(answered, WAITING_WAIT_MS);
      void api()
        .runWaiting(this.tool.id, project)
        .then((waiting) => {
          if (askedFor !== project || this.choosing?.form !== form) return;
          const words = waiting && waitingWords(waiting);
          if (!words) return;
          const list = make("ul", "", "run-waiting");
          list.append(...words.tasks.map((t) => make("li", t)));
          waits.replaceChildren(
            make("p", words.lead, "run-starts"),
            ...(words.tasks.length > 0 ? [list] : []),
            ...(words.more ? [make("p", words.more, "run-more-tasks")] : []),
          );
        })
        // Not told (the app's answer failed): Start running is let go all the same.
        .catch(() => {})
        .finally(answered);
    };
    let busy = false;
    const start = button("Start running", () => void go(), "btn btn-move btn-sm");
    const cancel = button("Cancel", () => this.close(true), "btn-text");
    const buttons = make("div", "", "run-buttons");
    buttons.append(start, cancel);
    form.append(projectLabel, select, projectError, folderLabel, folderRow, refused, note, waits, buttons);
    form.addEventListener("submit", (e) => e.preventDefault());

    const update = () => {
      askWaiting();
      start.disabled = !mayStart({ project: select.value, folder, asking, busy });
      if (this.owner)
        setText(note, choosingNote(this.words, this.runs?.agent ?? agent, select.value || null, this.owner));
    };
    select.addEventListener("change", update);
    const go = async () => {
      if (!folder || !select.value) return;
      busy = true;
      refused.textContent = "";
      start.textContent = "Starting…";
      update();
      const done = await api().startRunning(this.tool.id, select.value, folder);
      busy = false;
      start.textContent = "Start running";
      update();
      if (!done.ok) {
        refused.textContent = done.error;
        return;
      }
      this.close();
      await this.refresh();
      this.another.focus();
    };

    this.choosing = { form, note };
    this.element.insertBefore(form, this.more);
    update();
    this.place();
    select.focus();

    // The projects the agent may work in, but those Quadit runs it for already.
    void api()
      .agentProjects(this.tool.id)
      .then((answer) => {
        if (this.choosing?.form !== form) return;
        select.replaceChildren();
        if (!answer.ok) {
          select.disabled = true;
          projectError.textContent = answer.error;
          return;
        }
        const runs = new Set(entries.map((e) => e.project));
        const open = answer.projects.filter((p) => !runs.has(p.key));
        if (open.length === 0) {
          select.disabled = true;
          projectError.textContent =
            entries.length > 0
              ? `Quadit runs ${agent} for every project it may work in.`
              : `${agent} may not work in any project.`;
          return;
        }
        if (open.length > 1) select.append(new Option("Choose a project", ""));
        for (const p of open) select.append(new Option(p.name === p.key ? p.key : `${p.key} · ${p.name}`, p.key));
        update();
      });
  }

  /** Takes the form away; `refocus`: the person cancelled, and focus goes back to what opened it. */
  private close(refocus = false) {
    if (!this.choosing) return;
    this.choosing.form.remove();
    this.choosing = null;
    this.place();
    if (refocus) ((this.runs?.entries.length ?? 0) > 0 ? this.another : this.offerButton).focus();
  }
}

/** Sets the text of `node`, leaving it alone when it says that already (a selection in it survives). */
function setText(node: Node, text: string) {
  if (node.textContent !== text) node.textContent = text;
}
