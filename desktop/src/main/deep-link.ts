// quadit:// links (the desktop contract, section 4): what each one asks for,
// read from a URL any web page or other app may have made. Nothing here is
// trusted yet: the sign-in hand-off checks a connect link against the flow
// it started, and an open link may only open a page of the web app on its
// server (origins.ts, appPage), never an address the server answers itself.

import { appPage, serverOrigin } from "@/main/origins";

export const SCHEME = "quadit";

export type DeepLink =
  /** The browser finished its part of a sign-in: `code` is to be redeemed on `server`. */
  | { kind: "connect"; server: string; code: string; state: string }
  /** Open `path` (a page of the web app on `server`) in that server's window. */
  | { kind: "open"; server: string; path: string };

/** The link `raw` asks for, or null when it is not a well-formed quadit:// link. `server` is an origin. */
export function parseDeepLink(raw: string): DeepLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${SCHEME}:`) return null;
  // "quadit://connect?…" names the action as the host; "quadit:connect?…" and
  // "quadit:///connect?…" as the path. All three mean the same.
  const action = url.host || url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  const server = serverOrigin(url.searchParams.get("server") ?? "");
  if (!server) return null;
  if (action === "connect") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    return code && state ? { kind: "connect", server, code, state } : null;
  }
  if (action === "open") {
    const path = url.searchParams.get("path") || "/";
    return appPage(server, path) ? { kind: "open", server, path } : null;
  }
  return null;
}

/** The first quadit:// link among command-line arguments (how Windows and Linux hand a link to the app). */
export function deepLinkInArgs(argv: readonly string[]): string | null {
  return argv.find((arg) => arg.toLowerCase().startsWith(`${SCHEME}:`)) ?? null;
}
