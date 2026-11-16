import { Fragment } from "react";
import { MOD } from "@/hooks/hotkeys";
import { useFocusReturn } from "@/palette/focus-return";
import { type Key, t } from "@/lib/i18n";
import { ui, useUi } from "@/lib/ui-state";
import { DESTINATIONS, goKeys, listedName } from "@/shell/destinations";
import { KEYED } from "@/tasks/properties";
import { Dialog } from "@/ui/dialog";
import { Kbd } from "@/ui/kbd";

interface Shortcut {
  what: Key;
  /** Each entry is one way to do it; keys in an entry are pressed together. */
  keys: string[];
  /** The word between the entries: "or" for alternatives, "to" for a range. */
  join?: "or" | "to";
}

interface Section {
  title: Key;
  hint?: Key;
  rows: Shortcut[];
}

/** The keys that open a task property's picker, on a list's row and on the open task alike (tasks/properties). */
const propertyKeys: Shortcut[] = KEYED.flatMap(({ picker }) =>
  picker.hotkey ? [{ what: picker.hotkey.shortcut, keys: [picker.hotkey.key.toUpperCase()] }] : [],
);

const sections: Section[] = [
  {
    title: "shortcuts.group.anywhere",
    rows: [
      { what: "shortcuts.palette", keys: [`${MOD} K`] },
      { what: "shortcuts.newTask", keys: ["C"] },
      { what: "shortcuts.sheet", keys: ["?"] },
      { what: "shortcuts.undo", keys: [`${MOD} Z`] },
      { what: "shortcuts.redo", keys: [`Shift ${MOD} Z`] },
      { what: "shortcuts.goBack", keys: [`${MOD} [`] },
      { what: "shortcuts.goForward", keys: [`${MOD} ]`] },
      { what: "shortcuts.close", keys: ["Esc"] },
    ],
  },
  {
    title: "shortcuts.group.lists",
    hint: "shortcuts.group.listsHint",
    rows: [
      { what: "shortcuts.down", keys: ["J"] },
      { what: "shortcuts.up", keys: ["K"] },
      { what: "shortcuts.peek", keys: ["Space"] },
      { what: "shortcuts.open", keys: ["Enter"] },
      { what: "shortcuts.newTab", keys: [`${MOD} Click`] },
      { what: "shortcuts.select", keys: ["X"] },
      { what: "shortcuts.fold", keys: ["←", "→"], join: "or" },
      ...propertyKeys,
      { what: "shortcuts.clear", keys: ["Esc"] },
      { what: "shortcuts.lift", keys: ["Shift Space"] },
    ],
  },
  {
    title: "shortcuts.group.panel",
    hint: "shortcuts.group.panelHint",
    rows: [
      { what: "shortcuts.peekNext", keys: ["J", "K"], join: "or" },
      { what: "shortcuts.openPage", keys: ["Enter"] },
      { what: "shortcuts.peekClose", keys: ["Space", "Esc"], join: "or" },
      { what: "shortcuts.pageNext", keys: ["J", "K"], join: "or" },
      { what: "shortcuts.back", keys: ["Esc"] },
      ...propertyKeys,
      { what: "shortcuts.comment", keys: ["Ctrl M"] },
      { what: "shortcuts.send", keys: [`${MOD} Enter`] },
      { what: "shortcuts.leaveBox", keys: ["Esc"] },
    ],
  },
  {
    // The places and their letters are the table the sequences themselves read.
    title: "shortcuts.group.goto",
    hint: "shortcuts.group.gotoHint",
    rows: DESTINATIONS.flatMap((place) => {
      const keys = goKeys(place);
      return keys ? [{ what: listedName(place), keys: [keys] }] : [];
    }),
  },
  {
    title: "shortcuts.group.page",
    hint: "shortcuts.group.pageHint",
    rows: [{ what: "shortcuts.openChip", keys: [`${MOD} Enter`] }],
  },
  {
    title: "shortcuts.group.inbox",
    rows: [
      { what: "shortcuts.archive", keys: ["E"] },
      { what: "shortcuts.toggleRead", keys: ["U"] },
    ],
  },
  {
    title: "shortcuts.group.compare",
    rows: [
      { what: "shortcuts.focusOption", keys: ["←", "→"], join: "or" },
      { what: "shortcuts.pick", keys: ["1", "9"], join: "to" },
      { what: "shortcuts.zoom", keys: ["+", "−"], join: "or" },
      { what: "shortcuts.fit", keys: ["0"] },
    ],
  },
];

/**
 * Focus starts on the list, not on the Close button: arrow keys then scroll
 * the sheet, and the button's tooltip does not open and take the first Esc.
 */
const focusOnOpen = (el: HTMLElement | null) => el?.focus();

/** The sheet that lists every keyboard shortcut; opened with "?". */
export function ShortcutsSheet() {
  const open = useUi((s) => s.shortcutsOpen);
  useFocusReturn(open);
  return (
    <Dialog open={open} onOpenChange={ui.setShortcuts} title={t("top.shortcuts")} size="lg">
      <div ref={focusOnOpen} tabIndex={-1} className="gap-x-10 pb-2 outline-none sm:columns-2">
        {sections.map((section) => (
          <section key={section.title} className="mb-5 break-inside-avoid">
            <h3 className="text-sm font-semibold">{t(section.title)}</h3>
            {section.hint && <p className="text-xs text-ink-3">{t(section.hint)}</p>}
            <dl className="mt-1.5">
              {section.rows.map((row) => (
                <div
                  key={row.what}
                  className="flex h-8 items-center justify-between gap-4 border-b border-line/70 text-sm"
                >
                  <dt className="truncate text-ink-2">{t(row.what)}</dt>
                  <dd className="flex shrink-0 items-center gap-1.5">
                    {row.keys.map((keys, i) => (
                      <Fragment key={keys}>
                        {i > 0 && (
                          <span className="text-xs text-ink-3">
                            {t(row.join === "to" ? "shortcuts.to" : "shortcuts.or")}
                          </span>
                        )}
                        <Kbd>{keys}</Kbd>
                      </Fragment>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
