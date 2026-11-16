// Cmd+Z and Shift+Cmd+Z (Ctrl on other keyboards): the keys of
// data/undo.ts, and the question it asks before some undos. In a field or
// the editor the keys stay the text's own undo, and while a dialog or menu
// is open they do nothing.

import { t } from "@/lib/i18n";
import { askToUndo, redo, stopAsking, undo, useUndo } from "@/data/undo";
import { isTyping, overlayOpen, useHotkeys } from "@/hooks/hotkeys";
import { exact } from "@/lib/time";
import { toast } from "@/lib/toast";
import { ConfirmDialog } from "@/ui/confirm-dialog";

export function UndoKeys() {
  const asking = useUndo((s) => s.asking);

  useHotkeys(
    {
      "mod+z": (e) => {
        // The key belongs to a text being typed, or to something open over the page.
        if (isTyping(e.target) || overlayOpen()) return;
        e.preventDefault();
        if (e.shiftKey) {
          if (!redo()) toast.info(t("undo.nothingRedo"));
        } else if (!askToUndo()) toast.info(t("undo.nothing"));
      },
    },
    { layer: "global" },
  );

  return (
    <ConfirmDialog
      open={asking !== null}
      onOpenChange={(open) => !open && stopAsking()}
      title={t("undo.ask.title", { name: asking?.name ?? "" })}
      body={asking && (asking.warning ?? t("undo.ask.old", { when: exact(asking.at) }))}
      confirm={t("common.undo")}
      safe={!asking?.warning}
      onConfirm={() => void (asking && undo(asking))}
    />
  );
}
