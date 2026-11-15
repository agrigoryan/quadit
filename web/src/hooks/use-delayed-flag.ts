// Something shown only once a condition has held for a moment, and hidden
// as soon as it ends: a note about a slow connection, a hint for a key
// sequence. A flicker shorter than the delay shows nothing.

import { useEffect, useState } from "react";

/** True once `on` has been true for `delayMs` without a break; false at once when it turns false. */
export function useDelayedFlag(on: boolean, delayMs: number): boolean {
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (!on) return;
    const timer = setTimeout(() => setWaited(true), delayMs);
    return () => {
      clearTimeout(timer);
      // The next time `on` turns true, the wait starts again.
      setWaited(false);
    };
  }, [on, delayMs]);
  return on && waited;
}
