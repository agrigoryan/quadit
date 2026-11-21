// A tool's card (desktop contract §10), as the first run's tools step and
// the Connect window both show it, so the two never look like different
// products: a neutral tile with the tool's initials (no logos), its name,
// "Found on this computer", what connecting gives, what it changes on disk
// with "See the files", and its button. Connect turns into "Connected" in
// place, with the way back beside it; the card then speaks in the past tense
// and says how to try it. A failure shows on the card with "Try again".
// Styled by tools.css.

import { button, lineIcon, make } from "@/pages/dom";
import { diskLine } from "@/shared/change-words";
import type { Refused } from "@/shared/pages-api";

export interface CardTool {
  id: string;
  name: string;
  initials: string;
  /** Whether it gets a quadit login of its own; else whom it works as, when this computer's login is there already. */
  ownLogin: boolean;
  worksAs: string | null;
}

export interface CardActions {
  /**
   * Connects the tool, with the plan the sheet showed when `planId` is given;
   * the card shows its progress, and then Connected or the error. Gives the
   * handle of the workspace's agent it works as, when the page knows it.
   */
  connect(planId?: string): Promise<{ ok: true; agent?: string | null } | Refused>;
  /**
   * Takes the connection back; its label is the button's ("Undo" in the first
   * run, "Disconnect" later). Gives what the person should know after, which
   * the card shows (a token to revoke by hand).
   */
  back: { label: string; run(): Promise<{ ok: true; notes?: string[] } | Refused> };
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
  private connected = false;
  private addsCommand: boolean;
  private tileEl: HTMLSpanElement;
  private gives: HTMLParagraphElement;
  private disk: HTMLParagraphElement;
  private diskText: Text;
  private act: HTMLDivElement;
  private error: HTMLParagraphElement;
  private note: HTMLParagraphElement;
  private tryIt: HTMLParagraphElement;
  private connectButton: HTMLButtonElement;
  /** Room under the card's text for what a page adds (the Connect window's options). */
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

    this.gives = make("p", "", "gives");
    this.disk = make("p", "", "disk");
    this.diskText = document.createTextNode("");
    const see = button(
      "See the files",
      () => actions.seeFiles(),
      "link-blue",
      `See the files connecting ${tool.name} changes`,
    );
    this.disk.append(this.diskText, " ", see);
    this.error = make("p", "", "card-error");
    this.error.setAttribute("role", "alert");
    this.extra = make("div", "", "card-extra");
    this.note = make("p", "", "card-note");
    this.note.setAttribute("role", "status");
    body.append(head, this.gives, this.disk, this.error, this.note, this.extra);

    this.tryIt = make("p", "", "try");
    const tryLabel = make("b", "Try it:");
    const ask = make("q", "what is on my Quadit list?");
    this.tryIt.append(tryLabel, ` in ${tool.name}, ask `, ask);

    card.append(this.tileEl, body, this.tryIt);
    this.element = card;
    this.show();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Shows the card connected (or not) without doing anything: what the page found it to be. */
  markConnected(connected: boolean) {
    this.connected = connected;
    this.show();
  }

  /** The quadit command is on this computer now (another card connected): this card's line stops promising it. */
  commandAdded() {
    this.addsCommand = false;
    this.show();
  }

  /**
   * Connects it, as its button does (with the plan the sheet showed when
   * `planId` is given); resolves once it has, or has failed (the card says why).
   */
  async run(planId?: string): Promise<{ ok: true; agent?: string | null } | Refused> {
    if (this.connected) return { ok: true };
    this.error.textContent = "";
    this.note.textContent = "";
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
    this.connected = true;
    this.show();
    this.actions.changed(true, done.agent ?? null);
    return done;
  }

  private async takeBack(control: HTMLButtonElement) {
    this.error.textContent = "";
    control.disabled = true;
    const done = await this.actions.back.run();
    control.disabled = false;
    if (!done.ok) {
      this.error.textContent = done.error;
      return;
    }
    this.connected = false;
    this.note.textContent = (done.notes ?? []).join(" ");
    this.show();
    this.actions.changed(false, null);
  }

  private show() {
    const { tool, connected } = this;
    this.element.classList.toggle("done", connected);
    this.tileEl.classList.toggle("member", connected);
    const where = tool.worksAs ? " using this computer’s login" : " here";
    this.gives.textContent = `${tool.name} ${connected ? "can now" : "will be able to"} take tasks, ask you questions and report back${where}.`;
    this.diskText.textContent = diskLine(tool, this.addsCommand && !connected, connected);
    this.tryIt.hidden = !connected;
    if (connected) {
      const badge = make("span", "", "connected");
      badge.setAttribute("role", "status");
      badge.append(lineIcon(["M20 6 9 17l-5-5"]), document.createTextNode("Connected"));
      const back = button(
        this.actions.back.label,
        () => void this.takeBack(back),
        "undo",
        `${this.actions.back.label} ${tool.name}`,
      );
      this.act.replaceChildren(badge, back);
    } else {
      this.connectButton.textContent = "Connect";
      this.connectButton.setAttribute("aria-label", `Connect ${tool.name}`);
      this.act.replaceChildren(this.connectButton);
    }
  }
}
