// Removed files in the trash: every attachment taken off a task, a comment,
// a question or one of its options, each with a way back. The starting copy
// of the workspace leaves them out, so they are asked for here, and again
// whenever a file is removed or restored while the page is open. The key
// the list is cached under is here.

import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { FileImage, FileText, FileVideo, Undo2 } from "lucide-react";
import { api, workspacePath } from "@/lib/api";
import { inWorkspace, queryClient, readError } from "@/lib/query";
import { fileSize, isImage, isVideo } from "@/lib/files";
import { t, tMaybe } from "@/lib/i18n";
import { mutate } from "@/lib/mutate";
import { useCan } from "@/lib/access";
import { useRowEvenIfGone, useSlug } from "@/lib/selectors";
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

const filesKey = (slug: string) => [...inWorkspace(slug), "files-trash"] as const;

/** Removed files, newest removal first; their rows are not in the store, so they are this read's own data. */
async function fetchTrashedFiles(slug: string, signal: AbortSignal): Promise<TrashedFile[]> {
  const out = await api.get<{ attachments?: Attachment[] }>(workspacePath(slug, "/list/attachments?trash=1"), signal);
  return (out.attachments ?? [])
    .filter((a): a is TrashedFile => !!a.file)
    .map((a) => ({
      ...a,
      file: { ...a.file, url: localPath(a.file.url) as string, preview_url: localPath(a.file.preview_url) },
    }))
    .sort((a, b) => (b.deleted_at ?? 0) - (a.deleted_at ?? 0));
}

const NO_FILES: TrashedFile[] = [];

export function useTrashedFiles(): TrashedFiles {
  const slug = useSlug();
  const read = useQuery({ queryKey: filesKey(slug), queryFn: ({ signal }) => fetchTrashedFiles(slug, signal) });
  const rows = read.data ?? NO_FILES;

  // A file removed or put back anywhere changes this list.
  useEffect(
    () =>
      onEvents((events) => {
        if (events.some((ev) => ev.entity_type === "attachment"))
          void queryClient.invalidateQueries({ queryKey: filesKey(slug) });
      }),
    [slug],
  );

  function restore(id: string) {
    const row = rows.find((r) => r.id === id);
    queryClient.setQueryData<TrashedFile[]>(filesKey(slug), (list) => list?.filter((r) => r.id !== id));
    mutate({ type: "attachment.restore", args: { id } })
      .then(() => row && toast.info(t("trash.fileRestored", { name: row.file.name })))
      // Refused: the reason is shown, and the list is asked for again so the row comes back.
      .catch(() => queryClient.invalidateQueries({ queryKey: filesKey(slug) }));
  }

  const error = readError(read.error);
  // A 401 is no answer: the person is on the way to sign in.
  return { rows, loading: read.isPending || (!!read.error && !error), error, restore };
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
  // The task it was on may be in the trash or archived: its key still shows.
  const task = useRowEvenIfGone("tasks", row.task_id);
  const can = useCan();
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
      {can.edit(task?.project_id) && (
        <Button
          size="sm"
          aria-label={t("trash.restoreFile", { name: row.file.name })}
          onClick={onRestore}
          className="max-sm:h-9 max-sm:px-3"
        >
          <Undo2 className="size-3.5" aria-hidden />
          {t("trash.restore")}
        </Button>
      )}
    </li>
  );
}
