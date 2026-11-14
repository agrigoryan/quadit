// Rank strings keep rows in manual order. A rank is a string over 0-9a-z
// compared character by character; to move a row between two others, give it
// a rank between theirs and nothing else changes. This is an exact port of
// internal/rank/rank.go, so both sides agree on every result.

const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;

/**
 * A rank that sorts after `a` and before `b`. An empty `a` means "before
 * everything", an empty `b` "after everything". Throws if a >= b.
 */
export function between(a: string, b: string): string {
  if (b !== "" && a >= b) throw new Error(`rank: between(${a}, ${b}): not in order`);
  let out = "";
  for (let i = 0; ; i++) {
    const lo = i < a.length ? DIGITS.indexOf(a.charAt(i)) : 0;
    const hi = b !== "" && i < b.length ? DIGITS.indexOf(b.charAt(i)) : BASE;
    if (lo < 0 || hi < 0) throw new Error(`rank: not a rank: ${a} / ${b}`);
    if (hi - lo > 1) return out + DIGITS.charAt((lo + hi) >> 1);
    // No room at this digit: keep a's digit and look further right. Once the
    // result is below b here, only a still bounds it.
    out += DIGITS.charAt(lo);
    if (hi - lo === 1) b = "";
  }
}

export const after = (a: string) => between(a, "");
export const before = (b: string) => between("", b);

export function validRank(s: string): boolean {
  if (s === "" || s.endsWith("0")) return false;
  for (const ch of s) if (!DIGITS.includes(ch)) return false;
  return true;
}

/**
 * The rank for a row dropped between two neighbours in a sorted list. Either
 * neighbour may be missing (the ends of the list). Neighbours that share a
 * rank, or are out of order, would leave no room; the row then goes right
 * after the one above it.
 */
export function rankBetween(above: string | undefined, below: string | undefined): string {
  const a = above ?? "";
  const b = below ?? "";
  if (b !== "" && a >= b) return after(a);
  return between(a, b);
}
