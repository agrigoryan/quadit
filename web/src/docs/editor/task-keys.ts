// Typing a task's key ("SVA-12" and then a space) turns it into a chip that
// shows the task live.

import { findTaskByKey } from "@/lib/selectors";
import { getState } from "@/lib/store";
import type { AnyEditor } from "@/docs/editor/sync";

const TYPED = /(^|[\s(])([A-Z][A-Z0-9]{1,9}-\d{1,6})([\s.,;:!?)])$/;

export function chipTypedTaskKey(editor: AnyEditor) {
  const state = editor.prosemirrorState;
  const sel = state.selection;
  const chip = state.schema.nodes.taskChip;
  if (!sel.empty || !chip) return;
  const $from = sel.$from;
  if (!$from.parent.isTextblock || $from.parent.type.spec.code) return;
  if ($from.marks().some((mark) => mark.type.name === "code" || mark.type.name === "link")) return;
  const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 24), $from.parentOffset, undefined, "￼");
  const m = TYPED.exec(before);
  if (!m) return;
  const key = m[2] as string;
  const task = findTaskByKey(getState().c.tasks, key);
  if (!task || task.deleted_at) return;
  const end = sel.from - (m[3] as string).length;
  editor.transact((tr) => tr.replaceWith(end - key.length, end, chip.create({ key })));
}
