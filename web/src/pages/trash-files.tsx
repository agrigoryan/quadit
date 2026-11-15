// Removed files in the trash: every attachment taken off a task, a comment,
// a question or one of its options, each with a way back. The starting copy
// of the workspace leaves them out, so they are asked for here, and again
// whenever a file is removed or restored while the page is open.

import { useEffect, useState } from "react";
import { FileImage, FileText, FileVideo, Undo2 } from "lucide-react";
import { api, errorMessage, ws } from "@/lib/api";
import { fileSize, isImage, isVideo } from "@/lib/files";
import { t, tMaybe } from "@/lib/i18n";
import { mutate } from "@/lib/mutate";
import { useCollection, useSlug } from "@/lib/selectors";
import { onEvents } from "@/lib/store";
import { toast } from "@/lib/toast";
import type { Attachment, FileRow } from "@/lib/types";
import { localPath } from "@/lib/url";
import { keyCell } from "@/tasks/task-row";
import { Button } from "@/ui/button";

export type TrashedFile = Attachment & { file: FileRow };

export interface TrashedFiles {
  rows: TrashedFile[];
  loading: boolean;
  error: string;
  restore: (id: string) => void;
}

export function useTrashedFiles(): TrashedFiles {
  const slug = useSlug();
  const [rows, setRows] = useState<TrashedFile[]>([]);
  const [state, setState] = useState<"loading" | "ready" | { error: string }>("loading");
  /** Counts up to ask again. */
  const [round, setRound] = useState(0);

  useEffect(() => {
    const ctl = new AbortController();
    api
      .get<{ attachments?: Attachment[] }>(ws(slug, "/list/attachments?trash=1"), ctl.signal)
      .then((out) => {
        const found = (out.attachments ?? []).filter((a): a is TrashedFile => !!a.file);
        setRows(
          found
            .map((a) => ({
              ...a,
              file: { ...a.file, url: localPath(a.file.url) as string, preview_url: localPath(a.file.preview_url) },
            }))
            .sort((a, b) => (b.deleted_at ?? 0) - (a.deleted_at ?? 0)),
        );
        setState("ready");
      })
      .catch((err: unknown) => {
        if (!ctl.signal.aborted) setState({ error: errorMessage(err) });
      });
    return () => ctl.abort();
  }, [slug, round]);

  // A file removed or put back anywhere changes this list.
  useEffect(
    () => onEvents((events) => events.some((ev) => ev.entity_type === "attachment") && setRound((n) => n + 1)),
    [],
  );

  function restore(id: string) {
    const row = rows.find((r) => r.id === id);
    setRows((list) => list.filter((r) => r.id !== id));
    mutate({ type: "attachment.restore", args: { id } })
      .then(() => row && toast.info(t("trash.fileRestored", { name: row.file.name })))
      // Refused: the reason is shown, and the list is asked for again so the row comes back.
      .catch(() => setRound((n) => n + 1));
  }

  return { rows, loading: state === "loading", error: typeof state === "object" ? state.error : "", restore };
}

/** One removed file: what it is, what it was attached to, and the way back. */
export function TrashedFileRow({
  row,
  onRestore,
  rowClass,
  when,
}: {
  row: TrashedFile;
  onRestore: () => void;
  rowClass: string;
  when: React.ReactNode;
}) {
  const tasks = useCollection("tasks");
  const task = row.task_id ? tasks[row.task_id] : undefined;
  // The server does not serve a file that is in the trash, so there is no picture to show: its kind, as an icon.
  const Icon = isImage(row.file) ? FileImage : isVideo(row.file) ? FileVideo : FileText;
  return (
    <li className={rowClass}>
      <span className={keyCell}>{task?.key}</span>
      <span className="flex size-6 shrink-0 items-center justify-center rounded-xs bg-sunken text-ink-2">
        <Icon className="size-3.5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate text-ink-2">{row.file.name}</span>
      <span className="shrink-0 text-xs text-ink-3 tnum max-md:hidden">{fileSize(row.file.size)}</span>
      <span className="max-w-40 shrink-0 truncate text-xs text-ink-3 max-md:hidden">
        {tMaybe(`trash.fileOn.${row.subject_type}`, t("trash.fileOn.task"))}
      </span>
      {when}
      <Button
        size="sm"
        aria-label={t("trash.restoreFile", { name: row.file.name })}
        onClick={onRestore}
        className="max-sm:h-9 max-sm:px-3"
      >
        <Undo2 className="size-3.5" aria-hidden />
        {t("trash.restore")}
      </Button>
    </li>
  );
}
