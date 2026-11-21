// A tool's card (desktop contract §10 and §11), as the first run's tools step
// and Connect agents both show it, so the two never look like different
// products: a neutral tile with the tool's initials (no logos), its name,
// "Found on this computer", what connecting gives, and what it changes on
// disk with "See the files". Its three states:
//   found      "Connect";
//   set up     written on this computer, waiting for the tool: the line to
//              say in it (`Connect to Quadit ABC123`) with Copy, a live
//              "Waiting for Codex…", "New code" when it has none, and Undo;
//   connected  the agent gave the code back: "Connected", whether it
//              listens, how to try it, and Disconnect.
// A set-up card asks the app where its tool stands every couple of seconds
// while it is on the page (main/handshake.ts says how the server's answer is
// read); where the server cannot say, it shows "Connected" as written, as
// before connecting was proven. A tool whose listening was not verified says
// so, quietly. A failure shows on the card with "Try again". Styled by
// tools.css.

import { button, lineIcon, make } from "@/pages/dom";
import { diskLine, unrevokedWords } from "@/shared/change-words";
import type { Disconnected, Handshake, PagesApi, Refused } from "@/shared/pages-api";

const api = window.quaditPages as PagesApi;

/** How often a set-up card asks where its tool stands: calm, and soon enough to see the tool connect. */
const ASK_EVERY_MS = 2_000;
/** What the card calls this computer. */
const HERE = navigator.userAgent.includes("Macintosh") ? "this Mac" : "this computer";

export interface CardTool {
  id: string;
  name: string;
  initials: string;
  /** Whether it gets a quadit login of its own; else whom it works as, when this computer's login is there already. */
  ownLogin: boolean;
  worksAs: string | null;
  /** Whether an agent in it was seen to listen; if not, the card says so. */
  listenVerified: boolean;
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
   * once connected). Gives what the person should know after, which the card
   * shows (a token to revoke by hand).
   */
  back(): Promise<Disconnected | Refused>;
  /** Opens what connecting it changes (the sheet). */
  seeFiles(): void;
  /** Told after the card connected (as the agent with that handle, when known) or was taken back. */
  changed(connected: boolean, agent: string | null): void;
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
  private connected = false;
  /** Where it stands with Quadit once set up; null until the app has said. */
  private handshake: Handshake | null = null;
  private addsCommand: boolean;
  private asking = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private tileEl: HTMLSpanElement;
  private act: HTMLDivElement;
  private stand: HTMLDivElement;
  private gives: HTMLParagraphElement;
  private diskText: Text;
  private error: HTMLParagraphElement;
  private note: HTMLParagraphElement;
  private caution: HTMLParagraphElement;
  private tryIt: HTMLParagraphElement;
  private connectButton: HTMLButtonElement;
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
    body.append(head, this.stand, this.gives, disk, unverified, this.error, this.note, this.caution, this.extra);

    this.tryIt = make("p", "", "try");
    const tryLabel = make("b", "Try it:");
    const ask = make("q", "what is on my Quadit list?");
    this.tryIt.append(tryLabel, ` in ${tool.name}, ask `, ask);

    card.append(this.tileEl, body, this.tryIt);
    this.element = card;
    this.show();
  }

  /** Whether Connect has set it up on this computer. */
  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Shows the card set up (or not) without doing anything: what the page
   * found it to be, with where it stands when the page knows (else the card asks).
   */
  markConnected(connected: boolean, handshake: Handshake | null = null) {
    this.connected = connected;
    this.handshake = connected ? handshake : null;
    this.show();
    this.watch(handshake === null);
  }

  /** The quadit command is on this computer now (another card connected): this card's line stops promising it. */
  commandAdded() {
    this.addsCommand = false;
    this.show();
  }

  /**
   * Connects it, as its button does (with the plan the sheet showed when
   * `planId` is given); resolves once it is set up, or has failed (the card
   * says why). Where the tool stands then is asked after, never waited for.
   */
  async run(planId?: string): Promise<{ ok: true; agent?: string | null } | Refused> {
    if (this.connected) return { ok: true };
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
    this.markConnected(true);
    this.actions.changed(true, done.agent ?? null);
    return done;
  }

  /** Asks where the tool stands now, unless the card is gone from its page or not set up; shows it when it changed. */
  private async ask() {
    if (this.asking || !this.connected) return;
    this.asking = true;
    const now = await api.toolHandshake(this.tool.id).finally(() => (this.asking = false));
    if (!this.connected) return;
    if (now === null) {
      // Taken back elsewhere (another page of the app).
      this.markConnected(false);
      this.actions.changed(false, null);
      return;
    }
    if (JSON.stringify(now) === JSON.stringify(this.handshake)) return;
    this.handshake = now;
    this.show();
  }

  /** Asks every couple of seconds while the card is set up and on its page; `now`: once at once, too. */
  private watch(now: boolean) {
    if (!this.connected) {
      clearInterval(this.timer);
      this.timer = undefined;
      return;
    }
    if (now) void this.ask();
    this.timer ??= setInterval(() => {
      if (this.connected && this.element.isConnected) return void this.ask();
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
    this.markConnected(false);
    this.takenBack(done);
    this.actions.changed(false, null);
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

  /** A new connect code, for a set-up tool that has none (it ran out); the card shows its line once made. */
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
    const { tool, connected, handshake } = this;
    // Set up, the server has not said yet or says the agent has not proven it: it waits for the tool.
    const waiting = connected && (handshake === null || handshake.state === "waiting");
    const proven = connected && !waiting;
    this.element.classList.toggle("done", proven);
    this.element.classList.toggle("set-up", waiting);
    this.tileEl.classList.toggle("member", connected);
    const where = tool.worksAs ? " using this computer’s login" : " here";
    this.gives.textContent = `${tool.name} ${proven ? "can now" : "will be able to"} take tasks, ask you questions and report back${where}.`;
    this.diskText.textContent = diskLine(tool, this.addsCommand && !connected, connected);
    this.tryIt.hidden = !proven;

    if (!connected) {
      this.connectButton.textContent = "Connect";
      this.connectButton.setAttribute("aria-label", `Connect ${tool.name}`);
      this.act.replaceChildren(this.connectButton);
      this.stand.replaceChildren();
      return;
    }
    const label = waiting ? "Undo" : "Disconnect";
    const back = button(label, () => void this.takeBack(back), "undo", `${label} ${tool.name}`);
    if (waiting) {
      this.act.replaceChildren(back);
      this.stand.replaceChildren(...this.waitingLines(handshake?.state === "waiting" ? handshake.code : undefined));
      return;
    }
    const badge = make("span", "", "connected");
    badge.setAttribute("role", "status");
    badge.append(lineIcon(["M20 6 9 17l-5-5"]), document.createTextNode("Connected"));
    this.act.replaceChildren(badge, back);
    this.stand.replaceChildren(...(handshake?.state === "connected" ? [this.listening(handshake.listening)] : []));
  }

  /**
   * What a set-up card says while it waits for the tool: with a code, the
   * line to say in the tool, its Copy and the live wait; without one (it ran
   * out), "New code"; `code` undefined: the app has not said yet.
   */
  private waitingLines(code: string | null | undefined): HTMLElement[] {
    const { name } = this.tool;
    if (code === undefined) return [make("p", `Set up on ${HERE}.`, "set-up-line")];
    const lead = make("p", `Set up on ${HERE}. Now open ${name} and say:`, "set-up-line");
    if (code === null) {
      const again = button("New code", () => void this.newCode(again), "btn btn-line btn-sm", `New code for ${name}`);
      return [lead, again];
    }
    const line = `Connect to Quadit ${code}`;
    const say = make("p", "", "say");
    const copy = button(
      "Copy",
      () =>
        void api.copyText(line).then(() => {
          copy.textContent = "Copied";
          setTimeout(() => (copy.textContent = "Copy"), 1_500);
        }),
      "btn btn-line btn-sm",
      `Copy the line to say in ${name}`,
    );
    say.append(make("code", line), copy);
    const wait = make("p", "", "waiting");
    wait.setAttribute("role", "status");
    wait.append(make("span", "", "pulse"), document.createTextNode(`Waiting for ${name}…`));
    return [lead, say, wait];
  }

  /** Whether the connected tool's agent listens, and, when it does not, how to have it listen. */
  private listening(listening: boolean): HTMLElement {
    if (!listening) return make("p", `Not listening: in ${this.tool.name}, say “listen to Quadit”`, "listen off");
    const line = make("p", "", "listen on");
    line.append(make("span", "", "found-dot"), document.createTextNode("Listening"));
    return line;
  }
}
