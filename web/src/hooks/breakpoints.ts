// The two widths where the app changes its layout in script and not only in
// CSS. Each mirrors a Tailwind breakpoint, and the classes named beside it
// change at the same width; a layout that needs another width says why.

import { useMedia } from "@/hooks/use-media";

/**
 * Narrower than Tailwind's `sm` (640px): a phone. The compare view becomes a
 * swipe-through, one option at a time, and its header grows (its `max-sm:`
 * classes).
 */
export const usePhone = () => useMedia("(max-width: 639px)");

const ONE_PANE = "(max-width: 767px)";

/**
 * Narrower than Tailwind's `md` (768px): one pane at a time. The sidebar
 * becomes a drawer and the task panel covers the page (the `md:` and
 * `max-md:` classes of shell/sidebar.tsx, shell/topbar.tsx and
 * detail/task-panel.tsx), and settings and admin show their list of pages
 * or one page (ui/page-layout.tsx).
 */
export const useOnePane = () => useMedia(ONE_PANE);

/** The same, asked once: for a key or a command, which looks when it is pressed. */
export const isOnePane = () => window.matchMedia(ONE_PANE).matches;
