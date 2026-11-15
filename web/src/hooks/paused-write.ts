// A write that waits for typing to pause (a title, a filter's value, a
// page's text), so the person's keys make one change and not one each. What
// waits is written at once when the page goes away or is hidden, and, with
// the hook, when the component goes: a reload or a closed tab a moment after
// the last key would otherwise lose it, since the timer never fires.
// `pagehide` and `visibilitychange` are the events a browser reliably sends
// then (`beforeunload` is not, on phones above all).

import { useEffect, useState } from "react";

export interface PausedWrite {
  /** Keeps `write` to run once typing pauses, in place of the write that waited. */
  hold(write: () => void): void;
  /** Runs the write that waits, now. Nothing waits: nothing runs. */
  flush(): void;
  /** Forgets the write that waits. */
  cancel(): void;
  /** Whether a write waits. */
  readonly waiting: boolean;
}

/** A write that runs `waitMs` after the last hold(). Listens to the page only while one waits. */
export function pausedWrite(waitMs: number): PausedWrite {
  let held: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onVisibility = () => {
    if (document.visibilityState === "hidden") flush();
  };
  function listen(on: boolean) {
    if (on) {
      window.addEventListener("pagehide", flush);
      document.addEventListener("visibilitychange", onVisibility);
    } else {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    }
  }
  function take() {
    clearTimeout(timer);
    timer = undefined;
    const taken = held;
    held = null;
    if (taken) listen(false);
    return taken;
  }
  function flush() {
    take()?.();
  }

  return {
    hold(write) {
      if (!held) listen(true);
      held = write;
      clearTimeout(timer);
      timer = setTimeout(flush, waitMs);
    },
    flush,
    cancel: () => void take(),
    get waiting() {
      return held !== null;
    },
  };
}

/** pausedWrite for a component: the write that waits also runs when the component goes. */
export function usePausedWrite(waitMs: number): PausedWrite {
  const [paused] = useState(() => pausedWrite(waitMs));
  useEffect(() => () => paused.flush(), [paused]);
  return paused;
}
