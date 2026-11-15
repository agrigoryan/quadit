// Ranks for blocks placed by the editor. lib/rank.ts gives a rank between
// two others by halving the gap, which is right for a move but makes ranks
// grow a digit every few blocks when someone types a page top to bottom.
// So a block added at the end counts up instead, the way the server numbers
// the blocks of a new page (rank.ForNumber): fixed width, room in between.

import { between } from "@/lib/rank";

const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";
const WIDTH = 10;
const STEP = 1024;
const LIMIT = 36 ** WIDTH;

function encode(v: number): string {
  let out = "";
  for (let i = 0; i < WIDTH; i++) {
    out = DIGITS.charAt(v % 36) + out;
    v = Math.floor(v / 36);
  }
  return out;
}

/** A rank after `a` with nothing above it: the next step of the number line when there is room. */
function append(a: string): string {
  let v = 0;
  for (let i = 0; i < WIDTH; i++) {
    const d = i < a.length ? DIGITS.indexOf(a.charAt(i)) : 0;
    if (d < 0) return between(a, "");
    v = v * 36 + d;
  }
  let next = (Math.floor(v / STEP) + 1) * STEP;
  if (next % 36 === 0) next++; // a rank never ends in 0
  if (next >= LIMIT) return between(a, "");
  const rank = encode(next);
  return rank > a ? rank : between(a, "");
}

/**
 * `count` ranks in order, all after `lo` and before `hi` (either may be
 * empty: the start or the end of the list). In the middle the gap is split
 * evenly, so a paste of many blocks does not make long ranks.
 */
export function spread(lo: string, hi: string, count: number): string[] {
  if (count <= 0) return [];
  if (hi !== "" && lo >= hi) hi = ""; // neighbours out of order leave no gap: go right after `lo`
  if (hi === "") {
    const out: string[] = [];
    let prev = lo;
    for (let i = 0; i < count; i++) out.push((prev = append(prev)));
    return out;
  }
  const mid = Math.floor(count / 2);
  const rank = between(lo, hi);
  return [...spread(lo, rank, mid), rank, ...spread(rank, hi, count - mid - 1)];
}
