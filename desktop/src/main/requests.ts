// Requests: how something the person did in the app's own UI (a button on a
// native notification, the panel, quick capture, Connect) reaches the
// server's page that is to do it. The app never calls a server's API itself:
// a server's page does every write through its own path, and only when the
// app asks it to here.
//
// A request goes only to one page: the one that published the workspace it
// is about (the newest such page that listens), or the one that sent the
// notification it came from. It is answered by that page alone, and when
// that page does not listen, goes away or takes longer than 20 seconds, the
// answer is no, and the caller opens the window instead.
//
// Pages are known by their web contents' id, and what they say here has
// already been checked to come from a server's own page (server-windows.ts).

import { type DesktopOutcome, type DesktopRequest, type DesktopSummary, outcomeOf, REPLY_MAX } from "@/shared/bridge";

/**
 * How a request went: the page's own outcome, or, when no page answered it
 * (none listened, the one asked went away or took too long, or said nothing
 * the app understands), a refusal marked `unanswered`. A page cannot mark
 * its own outcome so: what it sends is rebuilt from the outcome's shape.
 */
export type Answer = DesktopOutcome | Unanswered;

type Unanswered = Extract<DesktopOutcome, { ok: false }> & { unanswered: true };

/** Hands a request to a page; false when there is no such page any more. */
export type PageSend = (page: number, message: { id: string; request: DesktopRequest }) => boolean;

const TIMEOUT_MS = 20_000;

interface Page {
  serverId: string;
  listening: boolean;
  summary: DesktopSummary | null;
  /** When it last published, in the order of publishing: the newest publisher of a workspace speaks for it. */
  publishedAt: number;
}

export class Requests {
  private pages = new Map<number, Page>();
  private pending = new Map<string, { page: number; settle(outcome: Answer): void }>();
  private published = 0;
  private sent = 0;

  /** `changed` is called whenever the summaries (or who listens) change. */
  constructor(
    private send: PageSend,
    private changed: () => void,
  ) {}

  /** `page`, of the server, now shows `summary` (null: none). */
  publish(page: number, serverId: string, summary: DesktopSummary | null) {
    const known = this.pageOf(page, serverId);
    known.summary = summary;
    known.publishedAt = ++this.published;
    this.changed();
  }

  /** `page`, of the server, has a request handler now, or no longer. */
  listen(page: number, serverId: string, listening: boolean) {
    this.pageOf(page, serverId).listening = listening;
    this.changed();
  }

  /** `page` went away (closed, or loaded another page): its summary goes, and what it was asked is answered no. */
  forget(page: number) {
    if (!this.pages.delete(page)) return;
    for (const request of this.pending.values()) {
      if (request.page === page) request.settle(unanswered("The server's window went away before it answered."));
    }
    this.changed();
  }

  /** `page` answered: `raw` is `{id, outcome}`, held to the outcome's shape; an answer from any other page is ignored. */
  answer(page: number, raw: unknown) {
    if (typeof raw !== "object" || raw === null) return;
    const { id, outcome } = raw as Record<string, unknown>;
    const request = typeof id === "string" ? this.pending.get(id) : undefined;
    if (!request || request.page !== page) return;
    request.settle(outcomeOf(outcome) ?? unanswered("The server's page gave an answer the app does not understand."));
  }

  /** The summary of every workspace a page shows, once each: its newest publisher's. */
  summaries(): { serverId: string; summary: DesktopSummary; listening: boolean }[] {
    const newest = new Map<string, Page>();
    for (const page of this.pages.values()) {
      if (!page.summary) continue;
      const key = `${page.serverId}\n${page.summary.workspace.id}`;
      if ((newest.get(key)?.publishedAt ?? -1) < page.publishedAt) newest.set(key, page);
    }
    return [...newest.values()]
      .sort((a, b) => a.publishedAt - b.publishedAt)
      .flatMap((page) =>
        page.summary ? [{ serverId: page.serverId, summary: page.summary, listening: page.listening }] : [],
      );
  }

  /** Asks the page that speaks for a workspace of a server. */
  toWorkspace(serverId: string, workspaceId: string, request: DesktopRequest): Promise<Answer> {
    let found: number | undefined;
    let foundAt = -1;
    for (const [id, page] of this.pages) {
      if (page.serverId !== serverId || page.summary?.workspace.id !== workspaceId || !page.listening) continue;
      if (page.publishedAt > foundAt) [found, foundAt] = [id, page.publishedAt];
    }
    if (found === undefined) return Promise.resolve(notListening());
    return this.toPage(found, serverId, request);
  }

  /** Asks one page of a server: the one a notification came from. */
  toPage(page: number, serverId: string, request: DesktopRequest): Promise<Answer> {
    const known = this.pages.get(page);
    if (!known || known.serverId !== serverId || !known.listening) return Promise.resolve(notListening());
    if (request.kind === "action" && (request.text?.length ?? 0) > REPLY_MAX) {
      return Promise.resolve({ ok: false, message: `A reply is at most ${REPLY_MAX} characters.` });
    }
    const id = `r${++this.sent}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(unanswered("The server's page did not answer in time.")), TIMEOUT_MS);
      const settle = (outcome: Answer) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(outcome);
      };
      this.pending.set(id, { page, settle });
      if (!this.send(page, { id, request })) settle(notListening());
    });
  }

  /**
   * The panel's button: `action.request` must be one of the actions the
   * workspace's summary offers, so a request goes only to the server that
   * made it, whatever the panel was told.
   */
  act(serverId: string, workspaceId: string, action: { request: string; text?: string }): Promise<Answer> {
    const summary = this.summaries().find(
      (s) => s.serverId === serverId && s.summary.workspace.id === workspaceId,
    )?.summary;
    const offered = summary?.waiting.some((item) => item.actions.some((a) => a.request === action.request));
    if (!offered) return Promise.resolve({ ok: false, message: "That decision is no longer waiting on you." });
    return this.toWorkspace(serverId, workspaceId, {
      kind: "action",
      request: action.request,
      ...(action.text !== undefined ? { text: action.text } : {}),
    });
  }

  private pageOf(page: number, serverId: string): Page {
    let known = this.pages.get(page);
    if (!known || known.serverId !== serverId) {
      known = { serverId, listening: false, summary: null, publishedAt: 0 };
      this.pages.set(page, known);
    }
    return known;
  }
}

function notListening(): Unanswered {
  return unanswered("No window of that server can do this now: open it and try there.");
}

function unanswered(message: string): Unanswered {
  return { ok: false, message, unanswered: true };
}
