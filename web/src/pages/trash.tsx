import { type ReactNode, useEffect, useMemo, useState } from "react";
import { MessageCircleQuestion, Trash2, Undo2 } from "lucide-react";
import { api, errorMessage, ws } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useCollection, useSlug } from "@/lib/selectors";
import { mergeRows } from "@/lib/store";
import { ago, exact } from "@/lib/time";
import type { Task } from "@/lib/types";
import { usePageTitle } from "@/lib/ui-state";
import { restoreDecision } from "@/decisions/actions";
import { useTrashedDecisions } from "@/decisions/trash";
import { TrashedFileRow, useTrashedFiles } from "@/pages/trash-files";
import { restoreTasks } from "@/tasks/actions";
import { keyCell, keyColumn } from "@/tasks/task-row";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty";
import { Loading } from "@/ui/spinner";
import { useMinute } from "@/lib/tick";

function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h2 className="flex h-8 items-center gap-2 border-b border-line bg-sunken px-4 text-sm font-medium">
        {title}
        <span className="text-xs font-normal text-ink-3 tnum">{count}</span>
      </h2>
      <ul>{children}</ul>
    </section>
  );
}

const rowClass = "flex min-h-9 items-center gap-2.5 border-b border-line/70 pr-2 pl-4 text-sm max-sm:py-1";

function Deleted({ at }: { at: number | undefined }) {
  // Kept as an empty column when the time is not known, so the rows line up.
  if (!at) return <span className="w-24 shrink-0 max-sm:hidden" />;
  return (
    <time dateTime={new Date(at).toISOString()} title={exact(at)} className="w-24 shrink-0 text-right text-xs text-ink-3 tnum max-sm:hidden">
      {t("trash.deleted", { when: ago(at) })}
    </time>
  );
}

/**
 * The trash: deleted tasks, deleted questions and removed files, newest
 * deletion first, each with a way back. The workspace's starting copy leaves them out, so
 * they are fetched here (the questions in decisions/trash.ts); what is
 * deleted while the app is open shows up here by itself.
 */
export function TrashPage() {
  useMinute();
  usePageTitle(t("nav.trash"));
  const slug = useSlug();
  const tasks = useCollection("tasks");
  const projects = useCollection("projects");
  const questions = useTrashedDecisions();
  const files = useTrashedFiles();
  const [state, setState] = useState<"loading" | "ready" | { error: string }>("loading");
  /** Questions on their way back: hidden until the server has said yes or no. */
  const [restoring, setRestoring] = useState<Record<string, true>>({});

  useEffect(() => {
    const ctl = new AbortController();
    api
      .get<{ tasks: Task[] }>(ws(slug, "/tasks?trash=1&raw=1&limit=1000"), ctl.signal)
      .then((out) => {
        mergeRows("tasks", out.tasks ?? []);
        setState("ready");
      })
      .catch((err: unknown) => {
        if (!ctl.signal.aborted) setState({ error: errorMessage(err) });
      });
    return () => ctl.abort();
  }, [slug]);

  function restoreQuestion(id: string) {
    setRestoring((r) => ({ ...r, [id]: true }));
    const settle = () =>
      setRestoring((r) => {
        const next = { ...r };
        delete next[id];
        return next;
      });
    // Refused (its task is in the trash): the reason is shown and the row comes back.
    restoreDecision(id).then(settle, settle);
  }

  const deletedTasks = useMemo(
    () =>
      Object.values(tasks)
        .filter((task) => task.deleted_at)
        .sort((a, b) => (b.deleted_at ?? 0) - (a.deleted_at ?? 0)),
    [tasks],
  );
  const deletedDecisions = questions.rows.filter((d) => !restoring[d.id]);
  // A file whose task is in the trash comes back with the task; it is not listed twice.
  const removedFiles = files.rows.filter((f) => !(f.task_id && tasks[f.task_id]?.deleted_at));
  const total = deletedTasks.length + deletedDecisions.length + removedFiles.length;
  // One key column down the whole page, as wide as its longest key.
  const keyStyle = keyColumn([
    ...deletedTasks.map((task) => task.key),
    ...deletedDecisions.map((d) => d.taskKey),
    ...removedFiles.map((f) => (f.task_id ? tasks[f.task_id]?.key : undefined)),
  ]);

  if (total === 0) {
    if (state === "loading" || questions.loading || files.loading) return <Loading />;
    const error = state !== "ready" ? state.error : questions.error || files.error;
    if (error) return <EmptyState icon={<Trash2 />} title={t("trash.loadFailed")} hint={error} />;
    return <EmptyState icon={<Trash2 />} title={t("trash.empty")} hint={t("trash.emptyHint")} />;
  }

  return (
    <div className="h-full overflow-y-auto pb-10" style={keyStyle}>
      <header className="sticky top-0 z-[2] flex h-10 items-center border-b border-line bg-surface px-4">
        <p className="text-xs text-ink-2 tnum">{t("trash.count", { n: total })}</p>
      </header>
      {deletedTasks.length > 0 && (
        <Group title={t("trash.tasks")} count={deletedTasks.length}>
          {deletedTasks.map((task) => (
            <li key={task.id} className={rowClass}>
              <span className={keyCell}>{task.key}</span>
              <span className="min-w-0 flex-1 truncate text-ink-2">{task.title || t("task.untitled")}</span>
              <span className="max-w-40 shrink-0 truncate text-xs text-ink-3 max-md:hidden">{projects[task.project_id]?.name}</span>
              <Deleted at={task.deleted_at ?? 0} />
              <Button size="sm" aria-label={t("trash.restoreTask", { key: task.key })} onClick={() => restoreTasks([task])} className="max-sm:h-9 max-sm:px-3">
                <Undo2 className="size-3.5" aria-hidden />
                {t("trash.restore")}
              </Button>
            </li>
          ))}
        </Group>
      )}
      {deletedDecisions.length > 0 && (
        <Group title={t("trash.decisions")} count={deletedDecisions.length}>
          {deletedDecisions.map((decision) => {
            const task = decision.taskId ? tasks[decision.taskId] : undefined;
            return (
              <li key={decision.id} className={rowClass}>
                <span className={keyCell}>{decision.taskKey}</span>
                <MessageCircleQuestion className="size-3.5 shrink-0 text-ink-3" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-ink-2">{decision.question}</span>
                {task?.deleted_at ? (
                  <span className="shrink-0 text-xs text-ink-3 max-md:hidden" title={t("trash.taskInTrashHint", { key: task.key })}>
                    {t("trash.taskInTrash", { key: task.key })}
                  </span>
                ) : (
                  <span className="max-w-40 shrink-0 truncate text-xs text-ink-3 max-md:hidden">{task?.title}</span>
                )}
                <Deleted at={decision.deletedAt} />
                <Button
                  size="sm"
                  aria-label={t("trash.restoreDecision", { question: decision.question })}
                  onClick={() => restoreQuestion(decision.id)}
                  className="max-sm:h-9 max-sm:px-3"
                >
                  <Undo2 className="size-3.5" aria-hidden />
                  {t("trash.restore")}
                </Button>
              </li>
            );
          })}
        </Group>
      )}
      {removedFiles.length > 0 && (
        <Group title={t("trash.files")} count={removedFiles.length}>
          {removedFiles.map((file) => (
            <TrashedFileRow key={file.id} row={file} rowClass={rowClass} when={<Deleted at={file.deleted_at} />} onRestore={() => files.restore(file.id)} />
          ))}
        </Group>
      )}
    </div>
  );
}
