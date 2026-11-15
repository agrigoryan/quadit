// Small things this browser remembers between visits, in localStorage, as
// JSON: whether the sidebar is collapsed, the timeline's zoom, which pages
// are open in the docs tree. Storage can be missing or refused (private
// mode, a full disk); then a choice lasts for this visit and nothing throws.

/**
 * The value kept under `key`, or `fallback` when there is none, it cannot be
 * read, or it is not JSON. It is not checked against `T`: compare it with
 * what is expected where that matters.
 */
export function readKept<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/** Keeps `value` under `key` for the next visit, when the browser lets it. */
export function keep(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Refused: the choice lasts for this visit.
  }
}
