// The files attached to the task itself (not to a comment or a question).

import { Paperclip } from "lucide-react";
import { t } from "@/lib/i18n";
import { useMe } from "@/lib/selectors";
import type { Task } from "@/lib/types";
import type { Attached } from "@/detail/data";
import { FileGrid } from "@/detail/file-grid";
import { Section } from "@/detail/section";
import { type PendingUpload, removeAttachment } from "@/detail/uploads";
import { Button } from "@/ui/button";

interface Props {
  task: Task;
  files: Attached[];
  pending: PendingUpload[];
  /** Opens the file chooser. */
  onAttach: () => void;
}

export function Attachments({ task, files, pending, onAttach }: Props) {
  const me = useMe();
  const readOnly = !!task.deleted_at;
  return (
    <Section
      title={t("detail.files")}
      action={
        !readOnly && (
          <Button variant="ghost" size="sm" className="max-md:h-9" onClick={onAttach}>
            <Paperclip className="size-3.5" aria-hidden />
            {t("detail.add.attach")}
          </Button>
        )
      }
    >
      <FileGrid
        files={files}
        pending={pending}
        className="mt-1"
        // The server lets only whoever attached a file, or an admin, remove it.
        canRemove={(a) => !readOnly && (a.created_by === me.user_id || me.role !== "member")}
        onRemove={(a) => removeAttachment(a.id)}
      />
    </Section>
  );
}
