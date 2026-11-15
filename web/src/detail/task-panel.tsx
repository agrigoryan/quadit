// A task as a panel on the right, over the list or board it was opened
// from: the quick look. On a phone it covers the whole screen. The task
// itself is drawn by detail/task-view.tsx; the same task on its own page is
// detail/task-page.tsx.

import { type RefObject, useEffect, useRef } from "react";
import { useMedia } from "@/decisions/data";
import { TaskView } from "@/detail/task-view";

interface Props {
  taskKey: string;
  onClose: () => void;
  /** Turns the panel into the task's own page. Not given on a phone, where the panel already is the whole screen. */
  onExpand?: () => void;
}

/**
 * Below the width where the panel leaves a strip of the page showing, it
 * covers the whole screen. What is behind it is then put out of reach of
 * the keyboard and of screen readers, as it is out of sight. Dialogs and
 * menus are drawn outside the frame and stay usable.
 */
function useCoverPage(panel: RefObject<HTMLElement | null>) {
  const covers = useMedia("(max-width: 767px)");
  useEffect(() => {
    const el = panel.current;
    const frame = el?.parentElement;
    if (!covers || !el || !frame) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const put: { el: HTMLElement; inert: boolean; hidden: string | null }[] = [];
    for (const other of frame.children) {
      if (other === el || !(other instanceof HTMLElement) || other.contains(el)) continue;
      put.push({ el: other, inert: other.inert, hidden: other.getAttribute("aria-hidden") });
      other.inert = true;
      other.setAttribute("aria-hidden", "true");
    }
    return () => {
      for (const p of put) {
        p.el.inert = p.inert;
        if (p.hidden === null) p.el.removeAttribute("aria-hidden");
        else p.el.setAttribute("aria-hidden", p.hidden);
      }
      // Back to the row the task was opened from, if nothing else took the focus.
      if (before?.isConnected && (document.activeElement === document.body || el.contains(document.activeElement)))
        before.focus();
    };
  }, [covers, panel]);
}

/** The frame stays while the panel moves from one task to the next (J and K in a list), so it slides in once. */
export function TaskPanel({ taskKey, onClose, onExpand }: Props) {
  const panel = useRef<HTMLElement>(null);
  useCoverPage(panel);
  return (
    <aside
      ref={panel}
      data-task-panel
      aria-label={taskKey}
      className="fixed inset-y-0 right-0 z-40 flex w-full flex-col bg-surface shadow-panel animate-panel md:w-[min(44rem,calc(100vw-3rem))]"
    >
      <TaskView key={taskKey} taskKey={taskKey} layout="panel" onClose={onClose} onExpand={onExpand} />
    </aside>
  );
}
