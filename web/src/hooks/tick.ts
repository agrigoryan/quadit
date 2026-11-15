// One clock for every relative time on screen ("5m", "2h"). A component
// that shows one calls useMinute() (or renders <Ago>) and is drawn again
// when the minute turns. There is a single timer however many labels there
// are, and none while nothing is listening.

import { useSyncExternalStore } from "react";

const MIN = 60_000;
const listeners = new Set<() => void>();
let minute = Math.floor(Date.now() / MIN);
let timer: ReturnType<typeof setTimeout> | undefined;

function check() {
  const now = Math.floor(Date.now() / MIN);
  if (now === minute) return;
  minute = now;
  for (const listener of listeners) listener();
}

/** Wakes just after the next minute begins, so labels turn over together and on time. */
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(
    () => {
      check();
      if (listeners.size > 0) schedule();
    },
    MIN - (Date.now() % MIN) + 50,
  );
}

// A tab in the background has its timers slowed; catch up the moment it is looked at again.
const onVisible = () => {
  if (document.visibilityState !== "visible") return;
  check();
  schedule();
};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    check();
    schedule();
    document.addEventListener("visibilitychange", onVisible);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    }
  };
}

/** The current minute (as a count since 1970). Reading it redraws the component each time the minute turns. */
export function useMinute(): number {
  return useSyncExternalStore(subscribe, () => minute);
}
