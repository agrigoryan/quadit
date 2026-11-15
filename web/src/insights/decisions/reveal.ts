// Opening a task "at" one of its decisions. Each decision block in the task
// panel carries the id "decision-<id>"; after the panel opens this looks for
// it and scrolls it into view. The panel's contents arrive in steps, so it
// looks a few times.

let run = 0;

function find(decisionId: string): HTMLElement | null {
  const el = document.getElementById(`decision-${decisionId}`);
  return el?.closest("[data-task-panel], [data-task-page]") ? el : null;
}

/** Scrolls the task panel to this decision, once the panel shows it. */
export function revealDecision(decisionId: string) {
  const mine = ++run;
  const started = Date.now();
  let shown = 0;
  // Stop as soon as the person scrolls by hand: they have taken over.
  const cancel = () => {
    if (run === mine) run++;
  };
  window.addEventListener("wheel", cancel, { once: true, passive: true });
  window.addEventListener("touchmove", cancel, { once: true, passive: true });

  function step() {
    if (run !== mine) return;
    const el = find(decisionId);
    if (el) {
      // A little air above it, so its first line does not sit under the panel's header.
      el.style.scrollMarginTop = "12px";
      el.scrollIntoView({ block: "start" });
      // Once more after the description and files above it have loaded and pushed it down.
      if (++shown >= 3) return;
    } else if (Date.now() - started > 4000) {
      return;
    }
    setTimeout(step, el ? 350 : 80);
  }
  setTimeout(step, 0);
}
