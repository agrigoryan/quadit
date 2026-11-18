// The app's rules about addresses: what a server's address is, which pages
// count as that server's own (and so get the bridge and stay in its
// window), and what may be handed to the system browser. Every check the
// app makes on a URL goes through here, so the rules live in one place.

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

/** Whether `url` is a page of the server at `origin` (exactly that scheme, host and port). */
export function isOwnPage(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * The full address of `path` on the server at `origin`, or null when `path`
 * is not a plain absolute path there. "//elsewhere" and "/\elsewhere" are
 * refused: browsers read both as another host.
 */
export function pageAt(origin: string, path: string): string | null {
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return null;
  let url: URL;
  try {
    url = new URL(path, origin);
  } catch {
    return null;
  }
  return url.origin === origin ? url.href : null;
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
