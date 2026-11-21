// How the app was started, and what starting it again asks of the copy that
// runs (it holds the single-instance lock: the second start's arguments
// come to it, main.ts). The quadit command starts the app with
// `--background` when its server on this computer is not running (desktop
// contract §11, amendment): then, as when it starts at login, it opens no
// window and takes no focus, showing only its menu-bar or tray icon, and it
// starts its server unless the person stopped it on purpose
// (LocalServer.startInBackground).

import { deepLinkInArgs } from "@/main/deep-link";

/** The switch the quadit command starts the app with. */
export const BACKGROUND_SWITCH = "--background";

/**
 * A start of the app with the arguments `argv`, at login or not: whether it
 * shows its windows, and how it starts its server on this computer, if one
 * is set up ("background": unless the person stopped it on purpose).
 */
export function coldStart(
  argv: readonly string[],
  { atLogin }: { atLogin: boolean },
): { windows: boolean; server: "start" | "background" } {
  const background = argv.includes(BACKGROUND_SWITCH);
  return { windows: !atLogin && !background, server: background ? "background" : "start" };
}

/**
 * What a second start, with the arguments `argv`, asks of the app running:
 * a link to follow; the background start of the quadit command; or, from
 * the person, a window when none is on screen (`windowShown`).
 */
export function secondStart(
  argv: readonly string[],
  { windowShown }: { windowShown: boolean },
): { kind: "link"; link: string } | { kind: "background" } | { kind: "list" } | { kind: "nothing" } {
  const link = deepLinkInArgs(argv);
  if (link) return { kind: "link", link };
  if (argv.includes(BACKGROUND_SWITCH)) return { kind: "background" };
  return windowShown ? { kind: "nothing" } : { kind: "list" };
}
