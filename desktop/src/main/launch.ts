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

/**
 * How long after a --background start an `activate` (macOS) is taken for
 * that start's own: macOS may send one as it launches the app, even started
 * hidden by `open -g -j`, and Electron says launching is among what sends
 * it. Three seconds outlasts a launch; a person clicking the Dock icon
 * later still gets a window.
 */
const BACKGROUND_QUIET_MS = 3_000;

/** Whether an `activate` is the person asking for a window, after a start that was `background` or not. */
export class ActivateAfterStart {
  private quietUntil: number;

  constructor(background: boolean) {
    this.quietUntil = background ? Date.now() + BACKGROUND_QUIET_MS : 0;
  }

  /** Whether the `activate` arriving now is the person's (to be answered with a window), not the background start's. */
  isThePersons(): boolean {
    return Date.now() >= this.quietUntil;
  }
}

/**
 * What the app says on its own (the first run, a dialog: a server that no
 * longer fits it, an update), held while it runs in the background: started
 * with --background, or told so while running, it shows nothing at all until
 * the person opens it themselves (a window of it comes to the front). Then
 * what was held is said, in the order it came.
 */
export class Quiet {
  private held: (() => void)[] = [];

  /** `background`: the app was started with --background. */
  constructor(private quiet: boolean) {}

  /** Whether it holds what the app says: it runs in the background, and the person has not opened it since. */
  get holding(): boolean {
    return this.quiet;
  }

  /** Told to start in the background while running: quiet until the person next opens it. */
  background() {
    this.quiet = true;
  }

  /** The person opened the app: what was held is said now. */
  seen() {
    this.quiet = false;
    for (const say of this.held.splice(0)) say();
  }

  /** Says `say` now, or, in the background, once the person opens the app. */
  say(say: () => void) {
    if (this.quiet) this.held.push(say);
    else say();
  }
}
