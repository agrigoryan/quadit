import { type RefObject, useLayoutEffect, useState } from "react";

/**
 * Whether an element is at least `rem` wide, followed as it is resized and
 * known before the page is first painted: for a layout that changes with
 * the room a part of the page has, not the window. Once wide, it stays so
 * until `slack` rem narrower, so that what the wide layout brings (a
 * scrollbar, as it makes the page longer) does not undo it, back and forth.
 */
export function useAtLeast(element: RefObject<HTMLElement | null>, rem: number, slack: number): boolean {
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const el = element.current;
    if (!el) return;
    const px = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const measure = () => setWide((was) => el.clientWidth >= (was ? rem - slack : rem) * px);
    measure();
    const sizes = new ResizeObserver(measure);
    sizes.observe(el);
    return () => sizes.disconnect();
  }, [element, rem, slack]);
  return wide;
}
