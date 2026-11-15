// A part of the app whose code is fetched apart from the rest, like
// React.lazy, with one difference: once the code is here, the part is drawn
// at once. React.lazy goes through Suspense even then, and what Suspense
// shows after a fallback it shows on a timer; a browser slows the timers of
// a tab in the background, so a task opened in a new tab stood on its
// spinner, without its name on the tab, until the timer came round.

import { type ComponentType, lazy, useState } from "react";

export interface Ahead<P> {
  /** Draws the part; inside a Suspense, for the first time, when its code is still on the way. */
  Part: ComponentType<P>;
  /** Starts fetching the code, if it is not here or on its way. */
  fetch: () => Promise<unknown>;
}

export function ahead<P extends object>(load: () => Promise<ComponentType<P>>): Ahead<P> {
  let ready: ComponentType<P> | undefined;
  let loading: Promise<ComponentType<P>> | undefined;

  const fetch = () =>
    (loading ??= load().then(
      (part) => (ready = part),
      (err: unknown) => {
        loading = undefined; // asked for again the next time
        throw err;
      },
    ));
  const Lazy = lazy(() => fetch().then((part) => ({ default: part }))) as unknown as ComponentType<P>;

  function Part(props: P) {
    // Chosen once: changing from one to the other later would draw the part anew and lose what it holds.
    const [Chosen] = useState<ComponentType<P>>(() => ready ?? Lazy);
    return <Chosen {...props} />;
  }
  return { Part, fetch };
}
