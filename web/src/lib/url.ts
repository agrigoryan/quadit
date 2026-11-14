/** File links arrive absolute; keep only the path so they work behind any proxy or port. */
export function localPath(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const u = new URL(url, location.origin);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}
