import { useEffect, useMemo, useState } from "react";
import { Trash2, Undo2 } from "lucide-react";
import { api, errorMessage, ws } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useCollection, useSlug } from "@/lib/selectors";
import { mergeRows } from "@/lib/store";
import { ago, exact } from "@/lib/time";
import type { Task } from "@/lib/types";
import { usePageTitle } from "@/lib/ui-state";
import { restoreTasks } from "@/tasks/actions";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty";
import { Loading } from "@/ui/spinner";
import { useMinute } from "@/lib/tick";

/**
 * The trash: deleted tasks, newest deletion first, each with a way back.
 * The workspace's starting copy leaves them out, so they are fetched here.
 */
export function TrashPage() {
  useMinute();
  usePageTitle(t("nav.trash"));
  const slug = useSlug();
  const tasks = useCollection("tasks");
  const projects = useCollection("projects");
  const [state, setState] = useState<"loading" | "ready" | { error: string }>("loading");

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

  const deleted = useMemo(
    () =>
      Object.values(tasks)
        .filter((task) => task.deleted_at)
        .sort((a, b) => (b.deleted_at ?? 0) - (a.deleted_at ?? 0)),
    [tasks],
  );

  if (deleted.length === 0) {
    if (state === "loading") return <Loading />;
    if (state !== "ready") return <EmptyState icon={<Trash2 />} title={t("trash.loadFailed")} hint={state.error} />;
    return <EmptyState icon={<Trash2 />} title={t("trash.empty")} hint={t("trash.emptyHint")} />;
  }

  return (
    <div className="h-full overflow-y-auto pb-10">
      <header className="sticky top-0 z-[2] flex h-10 items-center border-b border-line bg-surface px-4">
        <p className="text-xs text-ink-2 tnum">{t("trash.count", { n: deleted.length })}</p>
      </header>
      <ul>
        {deleted.map((task) => (
          <li key={task.id} className="flex min-h-9 items-center gap-2.5 border-b border-line/70 pr-2 pl-4 text-sm max-sm:py-1">
            <span className="w-[4.25rem] shrink-0 truncate text-xs text-ink-3 tnum">{task.key}</span>
            <span className="min-w-0 flex-1 truncate text-ink-2">{task.title || t("task.untitled")}</span>
            <span className="max-w-40 shrink-0 truncate text-xs text-ink-3 max-md:hidden">{projects[task.project_id]?.name}</span>
            <time
              dateTime={new Date(task.deleted_at ?? 0).toISOString()}
              title={exact(task.deleted_at ?? 0)}
              className="w-24 shrink-0 text-right text-xs text-ink-3 tnum max-sm:hidden"
            >
              {t("trash.deleted", { when: ago(task.deleted_at ?? 0) })}
            </time>
            <Button size="sm" aria-label={t("trash.restoreTask", { key: task.key })} onClick={() => restoreTasks([task])} className="max-sm:h-9 max-sm:px-3">
              <Undo2 className="size-3.5" aria-hidden />
              {t("trash.restore")}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
