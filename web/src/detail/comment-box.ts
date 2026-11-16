// The comment box of the open task, for what reaches it from outside
// (Ctrl+M on the task): the box carries data-comment-box (detail/composer.tsx),
// and startComment() puts the cursor in it.

/**
 * Puts the cursor at the end of the open task's comment box and brings the
 * box into view. False when there is none: no task is open, or the person
 * may not comment on it.
 */
export function startComment(): boolean {
  const box = document.querySelector<HTMLTextAreaElement>("textarea[data-comment-box]");
  if (!box) return false;
  box.focus({ preventScroll: true });
  box.setSelectionRange(box.value.length, box.value.length);
  box.scrollIntoView({ block: "nearest" });
  return true;
}
