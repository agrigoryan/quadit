// "See the files" (desktop contract §10): a side sheet over the page, a modal dialog, saying
// what connecting (or disconnecting) a tool changes. Each file in plain words
// first (shared/change-words.ts: what it is, a sentence, the path in small
// type, what happens to it), then the copy kept and the way back, and the
// exact changes, file by file, only behind "Show the exact changes". The
// first run's tools step and the Connect window both use it. Styled by
// tools.css.

import { button, lineIcon, make } from "@/pages/dom";
import { tile } from "@/pages/tool-card";
import { fileWords, filesSummary, sheetIntro } from "@/shared/change-words";
import type { PlanFile, Planned, PlanView, Refused } from "@/shared/pages-api";

export interface SheetSetup {
  tool: { name: string; initials: string };
  /** "connect": what connecting changes; "disconnect": what taking it back does. */
  kind: "connect" | "disconnect";
  /** Fetches the plan to show: once the sheet is open, and again when the one shown is out of date. */
  plan(): Promise<Planned>;
  /**
   * The sheet's main button ("Connect Claude Code"), which carries out the
   * plan shown (its id), or none (connected already). Refused as `stale`, the
   * sheet fetches the plan again and says why, for the person to look again.
   */
  action?: { label: string; run(planId: string): Promise<{ ok: true } | Refused> };
  /** The sheet closed, by any of its ways. */
  closed?(): void;
}

/** The sheet open now, so that a second replaces it. */
let open: { close(): void } | null = null;

/**
 * Opens the sheet over the page, as a modal dialog: while it is open, the
 * page behind it takes no clicks and no keys, and focus stays in it.
 */
export function openSheet(setup: SheetSetup) {
  open?.close();
  const { tool, kind } = setup;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const sheet = make("dialog", "", "sheet");
  sheet.setAttribute("aria-labelledby", "sheet-title");

  const head = make("div", "", "sheet-h");
  const titles = make("div");
  const title = make("h2", `What ${kind === "connect" ? "connecting" : "disconnecting"} ${tool.name} changes`);
  title.id = "sheet-title";
  const summary = make("p", "Looking…");
  titles.append(title, summary);
  const closeButton = button("", () => close(), "x", "Close");
  closeButton.append(cross());
  head.append(tile(tool.initials), titles, closeButton);

  const body = make("div", "", "sheet-b");
  const foot = make("div", "", "sheet-f");
  const error = make("p", "", "card-error");
  error.setAttribute("role", "alert");
  const closeAtFoot = button("Close", () => close(), "btn btn-line");
  const go = button("", () => void carryOut(), "btn btn-move");
  go.hidden = true;
  foot.append(error, closeAtFoot, go);
  sheet.append(head, body, foot);

  /** The plan shown now, which the main button carries out. */
  let shown: string | null = null;

  const close = () => {
    if (open !== handle) return;
    open = null;
    sheet.close();
    sheet.remove();
    opener?.focus();
    setup.closed?.();
  };
  const handle = { close };
  open = handle;
  // Escape: closed the sheet's own way, so that it says so.
  sheet.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  // A click outside the sheet (on its backdrop) lands on the dialog itself.
  sheet.addEventListener("click", (event) => {
    if (event.target === sheet) close();
  });
  document.body.append(sheet);
  sheet.showModal();
  closeButton.focus();

  const load = async () => {
    shown = null;
    go.hidden = true;
    summary.textContent = "Looking…";
    const planned = await setup.plan();
    if (open !== handle) return;
    if (!planned.ok) {
      summary.textContent = "";
      body.replaceChildren(make("p", planned.error, "card-error"));
      return;
    }
    showPlan(planned.plan);
  };

  const showPlan = (plan: PlanView) => {
    summary.textContent = filesSummary(plan.files);
    const files = make("div", "", "files");
    files.append(...plan.files.map((file) => fileRow(file, tool.name)));
    const safety = make("p", "", "safety");
    safety.append(
      shield(),
      make(
        "span",
        kind === "connect"
          ? "Quadit copies each file before it changes it. Undo puts every file back the way it was."
          : "Quadit copies each file before it changes it.",
      ),
    );
    const warnings = plan.warnings.map((warning) => make("p", warning, "warning"));
    const exact = make("details", "", "disclose");
    const label = make("summary");
    label.append(make("span", "Show the exact changes"), make("small", "Line by line, for each file"));
    exact.append(label);
    for (const file of plan.files) {
      exact.append(make("p", file.path, "exact-path"));
      if (file.note) exact.append(make("p", file.note, "exact-note"));
      if (file.diff) exact.append(make("pre", file.diff, "diff"));
    }
    body.replaceChildren(
      ...(kind === "connect" ? [make("p", sheetIntro(tool.name, plan.files), "intro")] : []),
      files,
      ...warnings,
      safety,
      exact,
    );
    if (!setup.action) return;
    shown = plan.id;
    go.textContent = setup.action.label;
    go.hidden = false;
  };

  /** The main button: carries out the plan shown; one out of date is fetched again, with why. */
  const carryOut = async () => {
    const { action } = setup;
    if (!action || !shown) return;
    error.textContent = "";
    go.disabled = true;
    const done = await action.run(shown);
    go.disabled = false;
    if (open !== handle) return;
    if (done.ok) {
      close();
      return;
    }
    if (done.stale) await load();
    error.textContent = done.error;
  };

  void load();
}

/** A file as the person reads it first: what it is and is for, its path, and what happens to it. */
function fileRow(file: PlanFile, tool: string): HTMLElement {
  const words = fileWords(file, tool);
  const row = make("div", "", "file");
  const icon = make("span", "", "fi");
  icon.append(fileIcon(file.role));
  const text = make("div");
  text.append(make("b", words.title), make("p", words.what, "what"), make("code", file.shown));
  const chip = make("span", words.chip, `chip chip-${file.change}`);
  row.append(icon, text, chip);
  return row;
}

function fileIcon(role: PlanFile["role"]): SVGSVGElement {
  switch (role) {
    case "login":
    case "shared-login":
      return lineIcon(["M2 18.5a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0", "m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"]);
    case "settings":
    case "profile":
      return lineIcon([
        "M12.5 22H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v9.5",
        "M14 2v4a2 2 0 0 0 2 2h4M13.4 12.6a2 2 0 1 1 3 3L11 21l-4 1 1-4Z",
      ]);
    case "command":
      return lineIcon(["m4 17 6-6-6-6", "M12 19h8"]);
    case "folder":
      return lineIcon([
        "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
      ]);
    case "skill":
      return lineIcon([
        "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",
        "M14 2v4a2 2 0 0 0 2 2h4M9 15h6M12 18v-6",
      ]);
  }
}

function shield(): SVGSVGElement {
  return lineIcon([
    "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
    "m9 12 2 2 4-4",
  ]);
}

function cross(): SVGSVGElement {
  return lineIcon(["M18 6 6 18M6 6l12 12"]);
}
