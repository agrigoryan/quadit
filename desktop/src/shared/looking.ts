// How long the first run's "Looking on this computer…" shows (desktop
// contract §10): as long as looking really takes, but never less than about
// a second, so that the person sees it happen. Once the tools are known, the
// rest of that second is shared out over them as the page goes down their
// names, marking those found.

/** Looking shows for at least this long. */
export const LOOK_MIN_MS = 1_000;

/**
 * How long the page stays on each of `tools` names, the tools having been
 * known `elapsedMs` after looking began: the rest of LOOK_MIN_MS shared out,
 * or nothing when looking took that long already.
 */
export function lookingPace(tools: number, elapsedMs: number): number {
  const left = LOOK_MIN_MS - elapsedMs;
  return tools > 0 && left > 0 ? left / tools : 0;
}
