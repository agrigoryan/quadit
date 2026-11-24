// A task handed back to the person looking at it, near its top: it waits on
// them, who handed it and what they said ("@codex: review the result"), and
// the three ways out. Looks good stops the wait, then offers to mark the
// task done; Reply writes back, handing it to whoever handed it; Not
// waiting on me only stops the wait. A question asked of them on the task
// is the action there instead (its card), so nothing shows then; a wait on
// someone else stays the waiting row's (tasks/properties/waiting.tsx).

import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import { t } from "@/lib/i18n";
import { useCan } from "@/data/access";
import { useMe, useMember, useOpenDecisions, useStatuses } from "@/data/selectors";
import { useTaskEvents } from "@/data/task-detail";
import type { FeedEvent, Task } from "@/types/core";
import { isOpenCategory } from "@/types/core";
import { editDraft } from "@/detail/comment-actions";
import { startComment } from "@/detail/comment-box";
import { nameOf } from "@/detail/data";
import { setStatus, stopWaiting } from "@/tasks/actions";
import { Avatar } from "@/ui/avatar";
import { Button } from "@/ui/button";

/**
 * Who handed the task on as it waits now, from its history: the actor of
 * the newest change of its wait or of the wait's note. A second hand-off to
 * the same person changes only the note, and it is that hand-off's.
 */
export function handedBy(events: FeedEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const changes = events[i]?.data?.changes;
    if (changes?.waiting_on_id || changes?.waiting_on_note) return events[i]?.actor_id;
  }
  return undefined;
}

/** The hand-back block of a task, or, once it was found good, the offer to mark the task done. Nothing otherwise. */
export function HandBack({ task }: { task: Task }) {
  const me = useMe();
  const can = useCan();
  const open = useOpenDecisions()[task.id] ?? [];
  const asked = open.some((d) => d.asked_id === me.user_id);
  const events = useTaskEvents(task.id);
  const hander = useMember(useMemo(() => handedBy(events), [events]));
  const statuses = useStatuses(task.project_id);
  const done = statuses.find((st) => st.category === "done");
  // Set when Looks good was pressed here: the offer to mark it done takes the block's place until the person moves on.
  const [found, setFound] = useState(false);

  if (!can.editTask(task)) return null;
  if (found) {
    // Gone as soon as marking it done would be wrong: it is closed, waits on someone again, or has a question open.
    const closed = !isOpenCategory(statuses.find((st) => st.id === task.status_id)?.category);
    if (closed || !done || task.waiting_on_id || task.waiting_outside || open.length > 0) return null;
    return (
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-ink-2">
        <span className="flex items-center gap-1.5">
          <Check className="size-3.5 text-ok" strokeWidth={2.5} aria-hidden />
          {t("handBack.cleared")}
        </span>
        <Button
          size="sm"
          onClick={() => {
            setStatus([task], done.id);
            setFound(false);
          }}
        >
          {t("handBack.markDone", { key: task.key })}
        </Button>
      </div>
    );
  }
  if (task.waiting_on_id !== me.user_id || task.waiting_outside || asked) return null;

  const note = task.waiting_on_note?.trim() ?? "";
  const by = hander ? nameOf(hander) : "";
  const said = by && note ? t("handBack.said", { who: by, note }) : by ? t("handBack.handed", { who: by }) : note;
  return (
    <section
      aria-label={t("handBack.title")}
      className="mt-3 rounded-lg border border-move/50 bg-move-soft px-3 py-2.5 dark:border-move/30"
    >
      <h3 className="text-sm font-semibold text-ink">{t("handBack.title")}</h3>
      {said && (
        <p className="mt-1 flex items-start gap-1.5 text-sm text-ink">
          {hander && <Avatar member={hander} size="xs" className="mt-0.5" />}
          <span className="min-w-0 whitespace-pre-line">{said}</span>
        </p>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button
          variant="move"
          className="max-sm:h-10"
          onClick={() => {
            stopWaiting(task);
            setFound(true);
          }}
        >
          {t("handBack.looksGood")}
        </Button>
        <Button
          className="max-sm:h-10"
          onClick={() => {
            // The reply hands the task back to whoever handed it, as the comment box's own "then waits on" would.
            editDraft(task.id, (d) => ({ ...d, handTo: hander?.user_id ?? d.handTo }));
            startComment();
          }}
        >
          {t("handBack.reply")}
        </Button>
        <Button variant="ghost" className="max-sm:h-10" onClick={() => stopWaiting(task)}>
          {t("handBack.notMe")}
        </Button>
      </div>
    </section>
  );
}
