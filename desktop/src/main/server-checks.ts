// Asking each added server what it is (probe.ts), keeping its answer in the
// store, and saying when a server does not fit this app: at every start,
// when the server list shows it, and before a browser sign-in starts, which
// only a server that speaks this app's hand-off can take. A server too old
// or too new is said once for each version it runs, so a restart does not
// say it again but an upgrade does.

import { type Fetch, type Fit, fitOf, probe } from "@/main/probe";
import type { Server, ServerStore } from "@/main/servers";

/** What the app says to the person: a line and the sentences under it. */
export interface Words {
  title: string;
  detail: string;
}

export class ServerChecks {
  constructor(
    private store: ServerStore,
    private fetcher: Fetch,
    /** Says something to the person (a dialog). */
    private tell: (words: Words) => void,
  ) {}

  /** Asks the server now and keeps what it said. Undefined for a removed server. Never throws. */
  async check(serverId: string) {
    const server = this.store.get(serverId);
    if (!server) return undefined;
    const answer = await probe(server.origin, this.fetcher);
    if (answer.reachable) {
      const { handoff, inset, version } = answer;
      this.store.change(server.id, { handoff, inset, version });
    }
    return answer;
  }

  /** Asks every added server, as the app starts, and says which no longer fit it. */
  async checkAll() {
    await Promise.all(
      this.store.list().map(async ({ id }) => {
        const answer = await this.check(id);
        const server = this.store.get(id);
        if (!answer?.reachable || !server) return;
        const said = answer.fit === "ok" ? "" : `${answer.version} ${answer.fit}`;
        if (said === server.warned) return;
        this.store.change(id, { warned: said });
        if (answer.fit !== "ok") this.tell(mismatch(server, answer.fit));
      }),
    );
  }

  /**
   * Why the browser sign-in cannot start on the server, or null when it can.
   * The server is asked first, as it may have been upgraded since the app
   * started; one that does not answer is judged by its last answer.
   */
  async whyNoSignIn(serverId: string): Promise<Words | null> {
    await this.check(serverId);
    const server = this.store.get(serverId);
    if (!server) return { title: "This server was removed", detail: "Add it again to sign in to it." };
    const fit = fitOf(server.handoff);
    return fit === "ok" ? null : mismatch(server, fit);
  }
}

function mismatch(server: Server, fit: Exclude<Fit, "ok">): Words {
  const runs = `${server.origin} runs ${server.version ? `Quadit ${server.version}` : "a Quadit"}`;
  if (fit === "old-server") {
    return {
      title: `${server.name} is older than this app`,
      detail: `${runs}, which cannot sign the app in through your browser. Sign in with your password in its window, or update the server.`,
    };
  }
  return {
    title: `${server.name} needs a newer Quadit app`,
    detail: `${runs}, which signs the app in in a way this version does not know. Update the app to sign in through your browser; signing in with your password in its window still works.`,
  };
}
