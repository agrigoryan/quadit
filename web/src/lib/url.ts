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

/**
 * A GitHub repository as "owner/name", from what a person typed or pasted:
 * that, or its address on github.com (with or without ".git"). Null when it
 * is neither.
 */
export function githubRepo(text: string): string | null {
  const repo = text
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null;
}

/** True for an http or https address with no spaces in it: the check a form makes before sending one. */
export const isWebAddress = (text: string): boolean => /^https?:\/\/\S+$/i.test(text.trim());
