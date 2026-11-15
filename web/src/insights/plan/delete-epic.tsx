// Deleting an epic, after asking.

import { t } from "@/lib/i18n";
import type { Epic } from "@/types/core";
import { deleteEpic } from "@/insights/plan/actions";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";

/** Asks before an epic is deleted: its tasks stay, without an epic. */
export function DeleteEpic({ epic, onClose, onDeleted }: { epic: Epic; onClose: () => void; onDeleted?: () => void }) {
  return (
    <Dialog
      open
      size="sm"
      onOpenChange={(open) => !open && onClose()}
      title={t("epic.deleteTitle", { name: epic.name })}
      description={t("epic.deleteHint")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              deleteEpic(epic);
              onClose();
              onDeleted?.();
            }}
          >
            {t("epic.delete")}
          </Button>
        </>
      }
    >
      {null}
    </Dialog>
  );
}
