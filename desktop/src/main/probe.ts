// Asking a server what it is (the desktop contract, section 1): whether it
// is Quadit at all, and which version of the sign-in hand-off it speaks, so
// the app can say plainly when a server is too old or too new for it.

/** The hand-off version this app speaks. */
export const HANDOFF_VERSION = 1;

/** How the app reaches the network: Electron's net.fetch (the system's proxy and certificates), or a test's stand-in. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export type Probe =
  { reachable: true; version: string; handoff: number; fit: Fit } | { reachable: false; reason: string };

/**
 * How the server and this app fit together:
 *   ok         the browser sign-in works
 *   old-server the server has no hand-off (an older Quadit): signing in with a password in its window still works
 *   new-server the server speaks a newer hand-off than this app: the app needs an update
 */
export type Fit = "ok" | "old-server" | "new-server";

/** Asks the server at `origin`; never throws. `fetcher` is the app's network stack (Electron's net.fetch) or a test's. */
export async function probe(origin: string, fetcher: Fetch, timeoutMs = 6000): Promise<Probe> {
  const ask = async (path: string) => {
    const response = await fetcher(new URL(path, origin).href, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "application/json" },
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) throw new Moved(response.headers.get("location"));
    const body: unknown = await response.json().catch(() => null);
    return { status: response.status, body: (body ?? {}) as Record<string, unknown> };
  };
  try {
    const about = await ask("/api/v1/version");
    if (about.status === 200 && about.body.name === "quadit") {
      const desktop = about.body.desktop as { handoff?: unknown } | undefined;
      const handoff = typeof desktop?.handoff === "number" ? desktop.handoff : 0;
      return {
        reachable: true,
        version: typeof about.body.version === "string" ? about.body.version : "",
        handoff,
        fit: fitOf(handoff),
      };
    }
    // A Quadit from before the desktop app has no version address, but its
    // sign-in page's settings say what it is.
    if (about.status === 404) {
      const signIn = await ask("/api/v1/auth/config");
      if (signIn.status === 200 && typeof signIn.body.setup_needed === "boolean" && "version" in signIn.body) {
        return {
          reachable: true,
          version: typeof signIn.body.version === "string" ? signIn.body.version : "",
          handoff: 0,
          fit: "old-server",
        };
      }
    }
  } catch (err) {
    if (err instanceof Moved) {
      const to = URL.parse(err.location ?? "", origin)?.origin ?? "";
      if (to && to !== origin)
        return { reachable: false, reason: `${origin} sends visitors to ${to}: add that address.` };
    }
    return { reachable: false, reason: `Could not reach ${origin}. Check the address and that the server is running.` };
  }
  return { reachable: false, reason: `${origin} does not answer as a Quadit server.` };
}

/** A redirect where the version should have been: the server lives at another address. */
class Moved extends Error {
  constructor(readonly location: string | null) {
    super("moved");
  }
}

function fitOf(handoff: number): Fit {
  if (handoff === 0) return "old-server";
  return handoff > HANDOFF_VERSION ? "new-server" : "ok";
}
