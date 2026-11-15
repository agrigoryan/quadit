// Windowing for long lists: which part of a scrolling box is on screen. A
// list of ten thousand rows draws only the few dozen that can be seen; this
// says where the box is scrolled to and how tall it is.

import { type RefObject, useEffect, useState } from "react";

export interface Viewport {
  top: number;
  height: number;
}

/** Follows the scroll position and height of the element in `ref`. */
export function useViewport(ref: RefObject<HTMLElement | null>): Viewport {
  const [view, setView] = useState<Viewport>({
    top: 0,
    height: typeof window === "undefined" ? 800 : window.innerHeight,
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // A scroll event already comes once a frame, before the frame is drawn: reading here keeps the rows under the scroll.
    const read = () => {
      const next = { top: el.scrollTop, height: el.clientHeight };
      setView((prev) => (prev.top === next.top && prev.height === next.height ? prev : next));
    };
    read();
    el.addEventListener("scroll", read, { passive: true });
    const watcher = new ResizeObserver(read);
    watcher.observe(el);
    return () => {
      el.removeEventListener("scroll", read);
      watcher.disconnect();
    };
  }, [ref]);

  return view;
}
