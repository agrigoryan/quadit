// The app's rules about addresses: what a server's address is, which pages
// count as that server's own (and so get the bridge and stay in its
// window), and what may be handed to the system browser. Every check the
// app makes on a URL goes through here, so the rules live in one place.

import { isIP } from "node:net";

/**
 * The origin ("https://host:port") of a server from what a person typed or a
 * link carried. A missing scheme means https; only http and https are
 * servers. Any path, query or fragment is dropped: a Quadit server lives at
 * the root of its origin. Null when the text is not such an address.
 */
export function serverOrigin(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname || url.username || url.password) return null;
  return url.origin;
}

/**
 * How the address of a server carries what the app and the server say,
 * sign-ins and session cookies included:
 *   secure    https
 *   local     http to this computer, or to an address that is usually on a
 *             network the person runs: a loopback, private, link-local or
 *             carrier-grade NAT address (Tailscale's), or a name that cannot
 *             be on the internet (localhost, a single word, .local,
 *             .home.arpa, .internal). Not encrypted: anyone else on that
 *             network (a shared Wi-Fi, an office) can read and change it, and
 *             the app cannot tell whose network it is. It says so, and adds
 *             such a server without asking: most self-hosted servers are there.
 *   insecure  http to anywhere else: anyone on the way can read and change
 *             it. The app adds such a server only when the person says so.
 */
export type Transport = "secure" | "local" | "insecure";

export function transportOf(origin: string): Transport {
  const url = URL.parse(origin);
  if (!url || url.protocol !== "http:") return "secure";
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host) === 4) {
    const [a = 0, b = 0] = host.split(".").map(Number);
    const local =
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127);
    return local ? "local" : "insecure";
  }
  if (isIP(host) === 6) {
    // ::1, unique local fc00::/7, link-local fe80::/10.
    return host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) ? "local" : "insecure";
  }
  const local = !host.includes(".") || /(^|\.)localhost$/.test(host) || /\.(local|home\.arpa|internal)$/.test(host);
  return local ? "local" : "insecure";
}

/** Whether `url` is a page of the server at `origin` (exactly that scheme, host and port). */
export function isOwnPage(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * The first part of a workspace page's path: a workspace's slug (2 to 40
 * lower-case letters, digits and dashes, internal/engine/ch_bootstrap.go).
 */
const SLUG = /^[a-z0-9-]{2,40}$/;

/**
 * First path parts that look like a slug but are not a workspace: the
 * server's own addresses (internal/server: the API, the hand-off, OAuth,
 * webhooks, health and metrics, built files) and the web app's pages
 * outside a workspace that a link has no business opening (signing in,
 * setting up, invitations, password resets, the desktop sign-in).
 */
const NOT_A_WORKSPACE = new Set([
  "api",
  "mcp",
  "oauth",
  "hooks",
  "desktop",
  "healthz",
  "readyz",
  "metrics",
  "assets",
  "login",
  "setup",
  "register",
  "reset",
  "invite",
  "admin",
  "account",
]);

/**
 * The full address of a page of the web app at `path` on the server at
 * `origin`, or null when `path` is anything else. This is what a link or a
 * notification from outside the app may open, so it is a list of what may
 * be, not of what may not: the home page, a workspace's pages, the admin
 * pages and the account's security page. Everything the server answers
 * itself is refused, the sign-in finish (/desktop/finish) above all: loaded
 * by anything but the app's own hand-off, it would sign the window in to
 * whatever account made the code. A path that would leave the origin
 * ("//elsewhere", "/\elsewhere"), or that hides a slash or a dot behind
 * percent signs, is refused too.
 */
export function appPage(origin: string, path: string): string | null {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null;
  let url: URL;
  try {
    url = new URL(path, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || /%(2f|5c|2e)/i.test(url.pathname)) return null;
  const parts = url.pathname.split("/").slice(1);
  const first = parts[0] ?? "";
  const isApp =
    url.pathname === "/" ||
    first === "admin" ||
    url.pathname === "/account/security" ||
    (SLUG.test(first) && !NOT_A_WORKSPACE.has(first));
  return isApp ? url.href : null;
}

/**
 * Whether `url` is the server's sign-in finish, or anything else under
 * /desktop/: a page only the app's own hand-off may load (src/main/handoff.ts).
 */
export function isHandoffPage(url: string, origin: string): boolean {
  const parsed = URL.parse(url);
  if (!parsed || parsed.origin !== origin) return false;
  // The server decodes the path before routing it: "/%64esktop/finish" is the finish too.
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname);
  } catch {
    return true; // Not readable: kept away, as if it were.
  }
  return /^\/+desktop(\/|$)/i.test(path);
}

/** The address to give the system browser, or null for anything but http and https (file:, javascript:, custom schemes). */
export function browserAddress(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}
