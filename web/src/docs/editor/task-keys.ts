// What is typed as text and becomes a live chip the moment it is complete:
// a task's key ("SVA-12" and then a space), a decision by its task and
// number ("SVA-12#2" and then a space), and a page by its title in double
// brackets ("[[Art guide]]", when exactly one page has that title).

import { SuggestionMenu } from "@blocknote/core/extensions";
import { getTaskByKeyEvenIfGone } from "@/data/selectors";
import { findDecision } from "@/docs/editor/decision-refs";
import { pageByTitle } from "@/docs/editor/refs";
import type { AnyEditor } from "@/docs/editor/sync";

const TYPED_TASK = /(^|[\s(])([A-Z][A-Z0-9]{1,9}-\d{1,6})([\s.,;:!?)])$/;
const TYPED_DECISION = /(^|[\s(])([A-Z][A-Z0-9]{1,9}-\d{1,6}#\d{1,3})([\s.,;:!?)])$/;
const TYPED_PAGE = /\[\[([^[\]\n￼]{1,200})\]\]$/;

/** As far back as a title in brackets can reach. */
const LOOK_BACK = 210;

export function chipTyped(editor: AnyEditor) {
  const state = editor.prosemirrorState;
  const sel = state.selection;
  const nodes = state.schema.nodes;
  if (!sel.empty) return;
  const $from = sel.$from;
  if (!$from.parent.isTextblock || $from.parent.type.spec.code) return;
  if ($from.marks().some((mark) => mark.type.name === "code" || mark.type.name === "link")) return;
  // One character per position: a chip already in the line counts as one.
  const before = $from.parent.textBetween(
    Math.max(0, $from.parentOffset - LOOK_BACK),
    $from.parentOffset,
    undefined,
    "￼",
  );
  const put = (from: number, to: number, type: string, props: Record<string, string>) => {
    const node = nodes[type];
    if (!node) return;
    editor.transact((tr) => tr.replaceWith(from, to, node.create(props)));
    // A menu that opened on the way ("#", "[[") has nothing left to offer.
    const menu = editor.getExtension(SuggestionMenu);
    if (menu?.shown()) menu.closeMenu();
  };

  const page = TYPED_PAGE.exec(before);
  if (page) {
    const doc = pageByTitle(page[1] as string);
    if (doc) put(sel.from - page[0].length, sel.from, "pageLink", { doc: doc.id });
    return;
  }

  const decision = TYPED_DECISION.exec(before);
  if (decision) {
    const found = findDecision(decision[2] as string);
    const end = sel.from - (decision[3] as string).length;
    if (found) put(end - (decision[2] as string).length, end, "decisionChip", { key: found.ref });
    return;
  }

  const m = TYPED_TASK.exec(before);
  if (!m) return;
  const key = m[2] as string;
  // An archived task still gets its chip; a trashed one's key stays text.
  const task = getTaskByKeyEvenIfGone(key);
  if (!task || task.deleted_at) return;
  const end = sel.from - (m[3] as string).length;
  put(end - key.length, end, "taskChip", { key });
}
