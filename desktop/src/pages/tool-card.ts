// A tool's card (desktop contract §10 and §11), as the first run's tools step
// and Connect agents both show it, so the two never look like different
// products: a neutral tile with the tool's initials (no logos), its name,
// "Found on this computer", what connecting gives, and what it changes on
// disk with "See the files". Its states:
//   found      "Connect";
//   set up     written on this computer, waiting for the tool: the line to
//              say in it (`Connect to Quadit ABC234`) with Copy, a live
//              "Waiting for Codex…", "New code" when it has none, and Undo;
//   connected  the server says the agent gave the code back: "Connected",
//              Disconnect, and whether it listens; when it does not, the
//              person's next step, the most visible thing on the card: the
//              line to write in a chat of the tool (`listen to Quadit`)
//              with Copy, and how that chat listens (CardTool.chatListens);
// and what the app does by itself (desktop contract §11, third amendment):
// "Connecting…" while it gives the code back, and the reason when it could
// not (above the line to paste); and, connected, Run by Quadit for a Claude
// Code or Codex with an agent's login of its own (run-by-quadit.ts): while
// Quadit's runner serves a project of it, the agent is heard there, so the
// next step is not shown and what the runner holds is said only by Run by
// Quadit's lines, never as a chat;
// and, set up but where it stands not known here (it works as another
// server's login, or no answer came yet), a plain line saying so, never
// "Connected". A set-up card asks the app where its tool stands every couple
// of seconds while it is on the page (main/handshake.ts says how the
// server's answer is read; no answer changes nothing). A tool whose
// listening was not verified says so, quietly. A failure shows on the card
// with "Try again". Styled by tools.css.

import { button, lineIcon, make } from "@/pages/dom";
import { LISTEN_LINE } from "@/pages/listen-steps";
import { RunByQuadit } from "@/pages/run-by-quadit";
import { isConnectCode } from "@/shared/bridge";
import { diskLine, unrevokedWords } from "@/shared/change-words";
import type { ChatListens, Disconnected, Handshake, Heard, PagesApi, Refused, SelfRun } from "@/shared/pages-api";

const api = window.quaditPages as PagesApi;

/** How often a set-up card asks where its tool stands: calm, and soon enough to see the tool connect. */
const ASK_EVERY_MS = 2_000;
/** What the card calls this computer. */
const HERE = navigator.userAgent.includes("Macintosh") ? "this Mac" : "this computer";
/** The states of an entry Quadit's runner serves: the agent is heard there. */
const SERVED: ReadonlySet<string> = new Set(["ready", "working", "paused", "aside"]);

export interface CardTool {
  id: string;
  name: string;
  initials: string;
  /** Whether it gets a quadit login of its own; else whom it works as, when this computer's login is there already. */
  ownLogin: boolean;
  worksAs: string | null;
  /** Whether an agent in it was seen to listen; if not, the card says so. */
  listenVerified: boolean;
  /** How a chat of it listens, which its card says; absent where not verified. */
  chatListens?: ChatListens;
  /** Connected by MCP alone, without the quadit command, which listening needs: its card says so instead. */
  mcpOnly?: boolean;
  /** Whether connecting also lets it run quadit without asking each time (its card's line says so). */
  allows: boolean;
}

export interface CardActions {
  /**
   * Connects the tool, with the plan the sheet showed when `planId` is given;
   * the card shows its progress, and then where the tool stands or the error.
   * Gives the handle of the workspace's agent it works as, when the page knows it.
   */
  connect(planId?: string): Promise<{ ok: true; agent?: string | null } | Refused>;
  /**
   * Takes the connection back (Undo while it waits for the tool, Disconnect
   * otherwise). Gives what the person should know after, which the card
   * shows (a token to revoke by hand).
   */
  back(): Promise<Disconnected | Refused>;
  /** Opens what connecting it changes (the sheet). */
  seeFiles(): void;
  /**
   * Told whenever the card's state changes: set up (`agent`: the handle of
   * the workspace's agent it works as, null for none), taken back, or
   * where the tool stands (`agent` undefined then).
   */
  changed(agent?: string | null): void;
}

/** A tile with a tool's initials; `small` for the lists of names. */
export function tile(initials: string, className = ""): HTMLSpanElement {
  const made = make("span", initials, `tile ${className}`.trim());
  made.setAttribute("aria-hidden", "true");
  return made;
}

export class ToolCard {
  readonly element: HTMLElement;
  /** Whether Connect has set it up on this computer (written). */
  private setUp = false;
  /** Where it stands with Quadit once set up; null until the app has said. */
  private handshake: Handshake | null = null;
  /** What the app does by itself for it (giving its code back); null until the app has said. */
  private self: SelfRun | null = null;
  /** What the card's buttons and its standing lines were last drawn from: they are drawn anew only when it changes. */
  private drawn = "";
  /** Where it stood when the buttons beside its name were last drawn. */
  private actFor = "";
  private addsCommand: boolean;
  private asking = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private tileEl: HTMLSpanElement;
  private act: HTMLDivElement;
  private stand: HTMLDivElement;
  /** Under Run by Quadit's lines: how a chat adds another project, while Quadit runs some (they come first). */
  private afterRuns: HTMLDivElement;
  private gives: HTMLParagraphElement;
  private diskText: Text;
  private error: HTMLParagraphElement;
  private note: HTMLParagraphElement;
  private caution: HTMLParagraphElement;
  private connectButton: HTMLButtonElement;
  /** Run by Quadit, under where it stands: shown only once it is connected and Quadit can run it. */
  private runs: RunByQuadit;
  /** The projects Quadit's runner serves for its agent now (ready, working, paused, or waiting for a chat), by key. */
  private served: string[] = [];
  /** Room under the card's text for what a page adds (Connect agents' More options). */
  readonly extra: HTMLDivElement;

  /** `addsCommand`: connecting puts the quadit command on this computer too (it has none on its PATH yet). */
  constructor(
    readonly tool: CardTool,
    addsCommand: boolean,
    private actions: CardActions,
  ) {
    this.addsCommand = addsCommand;
    const card = make("article", "", "tool");
    card.setAttribute("aria-label", tool.name);
    this.tileEl = tile(tool.initials);

    const body = make("div", "", "tool-body");
    const head = make("div", "", "head");
    const name = make("p", "", "name");
    const found = make("span", "", "found");
    found.append(make("span", "", "found-dot"), document.createTextNode("Found on this computer"));
    name.append(make("strong", tool.name), found);
    this.act = make("div", "", "act");
    this.connectButton = button("Connect", () => void this.run(), "btn btn-line", `Connect ${tool.name}`);
    head.append(name, this.act);

    this.stand = make("div", "", "stand");
    this.afterRuns = make("div", "", "stand");
    this.runs = new RunByQuadit(tool, HERE);
    this.gives = make("p", "", "gives");
    const disk = make("p", "", "disk");
    this.diskText = document.createTextNode("");
    const see = button(
      "See the files",
      () => actions.seeFiles(),
      "link-blue",
      `See the files connecting ${tool.name} changes`,
    );
    disk.append(this.diskText, " ", see);
    const unverified = make("p", `Listening is not verified with ${tool.name} yet.`, "unverified");
    unverified.hidden = tool.listenVerified;
    this.error = make("p", "", "card-error");
    this.error.setAttribute("role", "alert");
    this.extra = make("div", "", "card-extra");
    this.note = make("p", "", "card-note");
    this.note.setAttribute("role", "status");
    this.caution = make("p", "", "card-caution");
    this.caution.setAttribute("role", "alert");
    this.caution.hidden = true;
    body.append(
      head,
      this.stand,
      this.runs.element,
      this.afterRuns,
      this.gives,
      disk,
      unverified,
      this.error,
      this.note,
      this.caution,
      this.extra,
    );

    card.append(this.tileEl, body);
    this.element = card;
    this.show();
  }

  /** Whether Connect has set it up on this computer: its files are written, whether or not the tool reached Quadit. */
  get isSetUp(): boolean {
    return this.setUp;
  }

  /** Whether the server says the tool's agent proved it reached Quadit (its code given back). */
  get isConnected(): boolean {
    return this.setUp && this.handshake?.state === "connected";
  }

  /**
   * Shows the card set up (or not) without doing anything: what the page
   * found it to be, with where it stands when the page knows (else the card asks).
   */
  markSetUp(setUp: boolean, handshake: Handshake | null = null) {
    this.setUp = setUp;
    this.handshake = setUp ? handshake : null;
    if (!setUp) this.runs.show(null);
    this.show();
    this.watch(handshake === null);
  }

  /**
   * Whether connecting puts the quadit command on this computer too: not
   * once another card's connecting put it there, and the card's line says so.
   */
  setAddsCommand(adds: boolean) {
    if (this.addsCommand === adds) return;
    this.addsCommand = adds;
    this.show();
  }

  /**
   * Connects it, as its button does (with the plan the sheet showed when
   * `planId` is given); resolves once it is set up, or has failed (the card
   * says why). Where the tool stands then is asked after, never waited for.
   */
  async run(planId?: string): Promise<{ ok: true; agent?: string | null } | Refused> {
    if (this.setUp) return { ok: true };
    this.error.textContent = "";
    this.note.textContent = "";
    this.caution.hidden = true;
    this.connectButton.disabled = true;
    this.connectButton.textContent = "Connecting…";
    const done = await this.actions.connect(planId);
    this.connectButton.disabled = false;
    if (!done.ok) {
      this.connectButton.textContent = "Try again";
      this.connectButton.setAttribute("aria-label", `Try connecting ${this.tool.name} again`);
      this.error.textContent = done.error;
      return done;
    }
    this.markSetUp(true);
    this.actions.changed(done.agent ?? null);
    return done;
  }

  /**
   * Asks where the tool stands now, unless the card is gone from its page or
   * not set up, and, connected, what Quadit runs it for; shows it when it changed.
   */
  private async ask() {
    if (this.asking || !this.setUp) return;
    this.asking = true;
    const [now, self, runs] = await Promise.all([api.toolHandshake(this.tool.id), api.toolSelf(this.tool.id)])
      .then(
        async ([now, self]) =>
          [now, self, now?.state === "connected" ? await api.runEntries(this.tool.id) : null] as const,
      )
      .finally(() => (this.asking = false));
    if (!this.setUp) return;
    if (now === null) {
      // Taken back elsewhere (another page of the app).
      this.markSetUp(false);
      this.actions.changed();
      return;
    }
    this.runs.show(runs);
    const served = (runs?.entries ?? []).filter((e) => SERVED.has(e.status.state)).map((e) => e.project);
    if (JSON.stringify([now, self, served]) === JSON.stringify([this.handshake, this.self, this.served])) return;
    this.handshake = now;
    this.self = self;
    this.served = served;
    this.show();
    this.actions.changed();
  }

  /** Asks every couple of seconds while the card is set up and on its page; `now`: once at once, too. */
  private watch(now: boolean) {
    if (!this.setUp) {
      clearInterval(this.timer);
      this.timer = undefined;
      return;
    }
    if (now) void this.ask();
    this.timer ??= setInterval(() => {
      if (this.setUp && this.element.isConnected) return void this.ask();
      clearInterval(this.timer);
      this.timer = undefined;
    }, ASK_EVERY_MS);
  }

  private async takeBack(control: HTMLButtonElement) {
    this.error.textContent = "";
    control.disabled = true;
    const done = await this.actions.back();
    control.disabled = false;
    if (!done.ok) {
      this.error.textContent = done.error;
      return;
    }
    this.markSetUp(false);
    this.takenBack(done);
    this.actions.changed();
  }

  /**
   * Says what the person should know after the connection was taken back:
   * files left as they were, and, as a caution, a token still to revoke.
   */
  takenBack(done: Pick<Disconnected, "notes" | "unrevoked">) {
    this.note.textContent = done.notes.join(" ");
    this.caution.hidden = !done.unrevoked;
    if (done.unrevoked) {
      const words = unrevokedWords(done.unrevoked, this.tool.name);
      this.caution.replaceChildren(
        make("strong", words.happened),
        ` ${words.todo}`,
        make("span", words.reason, "reason"),
      );
    }
  }

  /** A new connect code, for a set-up tool that has none (gone, or run out); the card shows its line once made. */
  private async newCode(control: HTMLButtonElement) {
    this.error.textContent = "";
    control.disabled = true;
    const made = await api.newConnectCode(this.tool.id);
    control.disabled = false;
    if (!made.ok) {
      this.error.textContent = made.error;
      return;
    }
    await this.ask();
  }

  private show() {
    const { tool, setUp, handshake } = this;
    // Set up, the server has not said yet or says the agent has not proven it: it waits for the tool.
    const stands = !setUp
      ? "found"
      : handshake?.state === "connected" || handshake?.state === "unknown"
        ? handshake.state
        : "waiting";
    this.element.classList.toggle("done", stands === "connected");
    this.element.classList.toggle("set-up", stands === "waiting" || stands === "unknown");
    this.tileEl.classList.toggle("member", setUp);
    const where = tool.worksAs ? " using this computer’s login" : " here";
    setText(
      this.gives,
      stands === "connected"
        ? `${tool.name} can now take tasks, ask you questions and report back${where} when you ask it in a chat.`
        : `${tool.name} will be able to take tasks, ask you questions and report back${where}.`,
    );
    setText(this.diskText, diskLine(tool, this.addsCommand && !setUp, setUp));

    // Its nodes are replaced only when what they show changes: focus, a selection or a click in them survive the rest.
    const { self } = this;
    // What is drawn from: of what the app does by itself, only what the waiting state shows.
    const drawn = JSON.stringify([
      stands,
      handshake,
      stands === "waiting" ? (self?.proving ?? null) : null,
      stands === "connected" ? this.served : null,
    ]);
    if (drawn === this.drawn) return;
    this.drawn = drawn;
    // The buttons beside its name follow where it stands only: what listens changing leaves focus on Disconnect.
    if (stands !== this.actFor) {
      this.actFor = stands;
      const label = stands === "waiting" ? "Undo" : "Disconnect";
      const back = button(label, () => void this.takeBack(back), "undo", `${label} ${tool.name}`);
      const badge = make("span", "", "connected");
      badge.setAttribute("role", "status");
      badge.append(lineIcon(["M20 6 9 17l-5-5"]), document.createTextNode("Connected"));
      if (stands === "found") {
        this.connectButton.textContent = "Connect";
        this.connectButton.setAttribute("aria-label", `Connect ${tool.name}`);
        this.act.replaceChildren(this.connectButton);
      } else this.act.replaceChildren(...(stands === "connected" ? [badge, back] : [back]));
    }
    this.afterRuns.replaceChildren();
    if (stands === "found") {
      this.stand.replaceChildren();
      return;
    }
    if (handshake?.state === "connected") {
      const [lines, after] = this.listening(handshake, new Set(this.served));
      this.stand.replaceChildren(...lines);
      this.afterRuns.replaceChildren(...after);
      return;
    }
    if (handshake?.state === "unknown")
      this.stand.replaceChildren(
        make("p", `Set up on ${HERE}. Whether it reached Quadit is not known here.`, "set-up-line"),
      );
    else if (self?.proving?.state === "running") {
      const connecting = make("p", "", "waiting");
      connecting.setAttribute("role", "status");
      connecting.append(make("span", "", "pulse"), document.createTextNode("Connecting…"));
      this.stand.replaceChildren(connecting);
    } else this.stand.replaceChildren(...this.waitingLines(handshake));
  }

  /**
   * What a set-up card says while it waits for the tool: with a code, the
   * line to say in the tool, its Copy and the live wait; without one (gone
   * or run out), "New code", or, when making one failed, why and "Try
   * again"; before the app has said, only that it is set up. Only a code is
   * ever put in the line the person pastes into their agent (isConnectCode).
   */
  private waitingLines(handshake: Extract<Handshake, { state: "waiting" }> | null): HTMLElement[] {
    const { name } = this.tool;
    if (!handshake) return [make("p", `Set up on ${HERE}.`, "set-up-line")];
    // The app could not give the code back itself: why, quietly, and the line to say instead.
    const failed = this.self?.proving?.state === "failed" ? this.self.proving.reason : null;
    const lead = failed
      ? make(
          "p",
          `Quadit could not run ${name} by itself (${failed}). Say this in ${name} instead:`,
          "set-up-line quiet",
        )
      : make("p", `Set up on ${HERE}. Now open ${name} and say:`, "set-up-line");
    const { code, refused } = handshake;
    if (!isConnectCode(code)) {
      if (!refused) {
        const again = button("New code", () => void this.newCode(again), "btn btn-line btn-sm", `New code for ${name}`);
        return [lead, again];
      }
      const why = make("p", refused, "card-error");
      why.setAttribute("role", "alert");
      const again = button(
        "Try again",
        () => void this.newCode(again),
        "btn btn-line btn-sm",
        `Try making a code for ${name} again`,
      );
      return [lead, why, again];
    }
    const say = sayLine(`Connect to Quadit ${code}`, `Copy the line to say in ${name}`);
    const wait = make("p", "", "waiting");
    wait.setAttribute("role", "status");
    wait.append(make("span", "", "pulse"), document.createTextNode(`Waiting for ${name}…`));
    return [lead, say, wait];
  }

  /**
   * Whether the connected tool's agent listens (null: no answer to tell).
   * Listening, or Quadit running it for a project (`run`, the projects its
   * runner serves): what listens (heardLines), nothing when only Quadit's
   * runner does, since Run by Quadit's lines say it (what goes under those
   * lines comes second). Not: the person's next
   * step, set apart as the card's main thing, with how a chat of the tool
   * listens where that was verified; or, connected by MCP alone, that it
   * cannot listen.
   */
  private listening(
    handshake: Extract<Handshake, { state: "connected" }>,
    run: ReadonlySet<string>,
  ): [HTMLElement[], HTMLElement[]] {
    const { name, chatListens, mcpOnly } = this.tool;
    const { listening, heard } = handshake;
    if (listening === null) return [[make("p", "Cannot tell right now whether it is listening.", "listen")], []];
    if (listening || run.size > 0) return heardLines(heard, !mcpOnly, run);
    const step = make("div", "", "next-step");
    step.setAttribute("role", "group");
    step.setAttribute("aria-label", `Next: have ${name} listen`);
    if (mcpOnly) {
      step.append(
        make("p", "Not listening. Connected by MCP only, it cannot listen.", "next-lead"),
        make(
          "p",
          `To have it answer what you write in Quadit, disconnect it and connect it again with the quadit command (More options).`,
          "next-said",
        ),
      );
      return [[step], []];
    }
    step.append(
      make(
        "p",
        `Not listening yet. To have it answer what you write in Quadit, open ${name} in your project’s folder and write:`,
        "next-lead",
      ),
      sayLine(LISTEN_LINE, `Copy “${LISTEN_LINE}” for ${name}`),
    );
    if (chatListens === "background")
      step.append(make("p", "It listens in the background, so you can keep using that chat.", "next-said"));
    else if (chatListens === "busy")
      step.append(
        make(
          "p",
          `${name} cannot listen in the background yet, so listening keeps that chat busy. Use another chat to work with ${name} meanwhile.`,
          "next-said",
        ),
      );
    return [[step], []];
  }
}

/**
 * What listens as a listening agent, a line for each, and what the person
 * should know of each kind, in the skill's words: a chat answers while it is
 * open and stops when told to stop listening; a companion runs in a
 * terminal; a webhook pushes. One chat listens to a project at a time, and,
 * listening to projects only, another is added from a chat in its folder
 * (`mayAdd`: not for a tool connected by MCP alone, which cannot listen).
 * A page of an older server says nothing of what listens: then only that
 * it listens. What Quadit's runner holds, and the projects `run` it serves,
 * are not said here: Run by Quadit's lines say them, and a runner is no chat;
 * while it serves one, how a chat adds another project goes under those
 * lines (the second list). Nothing to say: no lines.
 */
function heardLines(
  heard: Heard | undefined,
  mayAdd: boolean,
  run: ReadonlySet<string>,
): [HTMLElement[], HTMLElement[]] {
  const box = make("div", "", "listening");
  const on = (text: string) => {
    const line = make("p", "", "listen on");
    line.append(make("span", "", "found-dot"), document.createTextNode(text));
    return line;
  };
  const said = (text: string) => make("p", text, "listen-said");
  if (!heard) {
    if (run.size > 0) return [[], []];
    box.append(on("Listening"), said("It answers what you assign to it or ask it in Quadit."));
    return [[box], []];
  }
  const { pushed } = heard;
  const listeners = heard.listeners.filter((l) => !l.runner);
  const byRunner = run.size > 0 || listeners.length < heard.listeners.length;
  const unheard = heard.unheard.filter((key) => !run.has(key));
  // Everything leaves out a project that listens by itself, and one whose own listener stopped (nothing hears it).
  const own = heard.listeners.some((l) => l.project) || byRunner || heard.unheard.length > 0;
  for (const l of listeners) {
    const what = l.project ? l.project.name : own ? "everything else" : "everything";
    box.append(on(`Listening to ${what}${l.by ? `, from ${l.by}` : ""}`));
  }
  if (pushed) box.append(on("A webhook pushes to it"));
  // Listening to a project the page does not show: only that it listens.
  if (!box.hasChildNodes() && !byRunner) box.append(on("Listening"));
  const chats = listeners.filter((l) => l.by === "a chat").length;
  if (chats === 1)
    box.append(
      said(
        "It answers what you assign to it or ask it in Quadit while that chat is open. One chat listens to a project at a time. To stop, tell that chat to stop listening.",
      ),
    );
  else if (chats > 1)
    box.append(
      said(
        "It answers what you assign to it or ask it in Quadit while those chats are open. One chat listens to a project at a time. To stop one, tell its chat to stop listening.",
      ),
    );
  if (listeners.some((l) => l.by === "a companion"))
    box.append(said("A companion runs in a terminal, and stops with Ctrl-C or when that terminal closes."));
  // Listening to projects only (Quadit's runner's among them): how a chat adds another, named when it is the one left.
  const onlyProjects = !pushed && (listeners.length > 0 || byRunner) && listeners.every((l) => l.project);
  const another =
    mayAdd && onlyProjects && unheard.length > 0
      ? said(
          unheard.length === 1
            ? `To have it listen to ${unheard[0]} too, write “${LISTEN_LINE} for ${unheard[0]}” in a chat in that project’s folder.`
            : `To have it listen to another project too, write “${LISTEN_LINE}” in a chat in that project’s folder.`,
        )
      : null;
  if (another && run.size === 0) box.append(another);
  return [box.hasChildNodes() ? [box] : [], another && run.size > 0 ? [another] : []];
}

/**
 * A line for the person to write in their tool, with its Copy: the card's
 * own words only (a connect code's line, or the listen line), never text a
 * server chose.
 */
function sayLine(line: string, label: string): HTMLParagraphElement {
  const say = make("p", "", "say");
  const copy = button(
    "Copy",
    () =>
      void api.copyText(line).then(() => {
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = "Copy"), 1_500);
      }),
    "btn btn-line btn-sm",
    label,
  );
  say.append(make("code", line), copy);
  return say;
}

/** Sets the text of `node`, leaving it alone when it says that already (a selection in it survives). */
function setText(node: Node, text: string) {
  if (node.textContent !== text) node.textContent = text;
}
