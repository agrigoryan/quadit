// Signing in through the system browser (the desktop contract, section 2).
// The app starts a flow with a random state and a PKCE verifier, sends the
// browser to the server's /desktop/connect, and the server answers on a
// quadit://connect link with a one-time code. Only a link that carries the
// state of a flow this app started, for that flow's server, is redeemed;
// the verifier never leaves the app until the server's own window loads
// /desktop/finish with it, so a code seen by anyone else is useless.
//
// That load is the only way into /desktop/finish (server-windows.ts,
// finishSignIn): it carries HANDOFF_HEADER, which the server asks for and
// which no link, redirect or page can add to a navigation. A code someone
// made for their own account, put in a link, therefore never signs the app
// in as them (login CSRF).

import { createHash, randomBytes } from "node:crypto";

/** The header the app's own load of /desktop/finish carries, with the value "1" (the desktop contract, section 2). */
export const HANDOFF_HEADER = "X-Quadit-Handoff";

/** How long a started sign-in waits for the browser; the server's code itself lasts two minutes. */
const FLOW_LIFETIME_MS = 15 * 60 * 1000;

interface Flow {
  serverId: string;
  origin: string;
  verifier: string;
  startedAt: number;
  next?: string;
}

/**
 * Where a finished hand-off goes: the server's window loads `finishUrl`,
 * then `next` when the sign-in began on the way to a page.
 */
export type Redeemed = { ok: true; serverId: string; finishUrl: string; next?: string } | { ok: false; reason: string };

/** The sign-ins started and not yet finished, in memory: a restart forgets them, and the person starts again. */
export class SignInFlows {
  private flows = new Map<string, Flow>();

  constructor(private now: () => number = Date.now) {}

  /**
   * Starts a sign-in on the server at `origin` and gives the address to open
   * in the system browser. `next` is the page of the web app the window was
   * on its way to, given back by redeem.
   */
  begin(serverId: string, origin: string, next?: string): string {
    this.forgetExpired();
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    this.flows.set(state, { serverId, origin, verifier, startedAt: this.now(), next });
    const url = new URL("/desktop/connect", origin);
    url.searchParams.set("state", state);
    url.searchParams.set("challenge", challengeOf(verifier));
    return url.href;
  }

  /**
   * Redeems what a quadit://connect link brought back. A state is used once:
   * whatever the outcome, its flow is gone afterwards.
   */
  redeem(link: { server: string; code: string; state: string }): Redeemed {
    this.forgetExpired();
    const flow = this.flows.get(link.state);
    if (!flow) {
      return { ok: false, reason: "This sign-in link was not started from this app, or it has expired. Start again." };
    }
    this.flows.delete(link.state);
    if (flow.origin !== link.server) {
      return { ok: false, reason: `This sign-in link came from ${link.server}, not ${flow.origin}. Start again.` };
    }
    const url = new URL("/desktop/finish", flow.origin);
    url.searchParams.set("code", link.code);
    url.searchParams.set("verifier", flow.verifier);
    return { ok: true, serverId: flow.serverId, finishUrl: url.href, next: flow.next };
  }

  private forgetExpired() {
    const oldest = this.now() - FLOW_LIFETIME_MS;
    for (const [state, flow] of this.flows) if (flow.startedAt < oldest) this.flows.delete(state);
  }
}

/** The S256 challenge of a verifier: base64url of its SHA-256, without padding. */
export function challengeOf(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
