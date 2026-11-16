// Cmd+Z and Shift+Cmd+Z (Ctrl on other keyboards): the keys of
// data/undo.ts. In a field or the editor they stay the text's
// own undo, and while a dialog or menu is open they do nothing. Something
// done more than five minutes ago is asked about first, so a stray Cmd+Z
// does not quietly change what was settled a while back.

import { useState } from "react";
import { t } from "@/lib/i18n";
import { type Done, nextUndo, redo, undo } from "@/data/undo";
import { isTyping, overlayOpen, useHotkeys } from "@/hooks/hotkeys";
import { exact } from "@/lib/time";
import { toast } from "@/lib/toast";
import { ConfirmDialog } from "@/ui/confirm-dialog";

/** Older than this, an edit is asked about before it is undone. */
const ASK_AFTER_MS = 5 * 60_000;

export function UndoKeys() {
  const [asking, setAsking] = useState<Done | null>(null);

  function onUndo() {
    const next = nextUndo();
    if (!next) toast.info(t("undo.nothing"));
    else if (Date.now() - next.at > ASK_AFTER_MS) setAsking(next);
    else undo(next);
  }

  function onRedo() {
    if (!redo()) toast.info(t("undo.nothingRedo"));
  }

  /** Runs `act` unless the key belongs to a text being typed or to something open over the page. */
  const unlessElsewhere = (act: () => void) => (e: KeyboardEvent) => {
    if (isTyping(e.target) || overlayOpen()) return;
    e.preventDefault();
    act();
  };

  useHotkeys(
    {
      "mod+z": (e) => unlessElsewhere(e.shiftKey ? onRedo : onUndo)(e),
    },
    { layer: "global" },
  );

  return (
    <ConfirmDialog
      open={asking !== null}
      onOpenChange={(open) => !open && setAsking(null)}
      title={t("undo.old.title")}
      body={asking && t("undo.old.body", { name: asking.name, when: exact(asking.at) })}
      confirm={t("common.undo")}
      safe
      onConfirm={() => void (asking && undo(asking))}
    />
  );
}
