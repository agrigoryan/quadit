// What happened in the task, oldest first: changes as short lines, comments
// as cards, and the comment box at the end.

import { memo, useMemo } from "react";
import { useCan } from "@/data/access";
import { cx } from "@/lib/cx";
import { joinPhrases, t } from "@/lib/i18n";
import { useAttachmentsBySubject, useLookup, useMember } from "@/data/selectors";
import { useTaskEvents } from "@/data/task-detail";
import type { Task } from "@/types/core";
import { CommentCard, When } from "@/detail/comment-card";
import { CommentReach } from "@/detail/comment-reach";
import { Composer } from "@/detail/composer";
import { nameOf } from "@/detail/data";
import { Section } from "@/detail/section";
import { buildTimeline, commentHistory, type LineItem } from "@/detail/timeline-model";
import { useStoredRows } from "@/detail/timeline-known";
import { Avatar } from "@/ui/avatar";
import { Loading } from "@/ui/spinner";

interface LineProps {
  actorId: string;
  at: number;
  text: string;
  note?: string;
  /** Something taken away: said, but faintly. */
  quiet?: boolean;
}

/** "Aram moved this from Todo to In progress", with when. */
const Line = memo(function Line({ actorId, at, text, note, quiet }: LineProps) {
  const actor = useMember(actorId);
  return (
    <li className={cx("flex items-start gap-2 px-3 text-xs leading-5", quiet ? "text-ink-3" : "text-ink-2")}>
      <span className={cx("flex h-5 w-5 shrink-0 items-center justify-center", quiet && "opacity-60")}>
        <Avatar member={actor} size="xs" />
      </span>
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <p>
          <span className={cx("font-medium", quiet ? "text-ink-2" : "text-ink")}>{nameOf(actor)}</span> {text}{" "}
          <When at={at} />
        </p>
        {note && <p className="mt-0.5 border-l-2 border-line pl-2 text-ink-2">{note}</p>}
      </div>
    </li>
  );
});

const lineText = (item: LineItem) => joinPhrases(item.phrases);

interface Props {
  task: Task;
  /** The task's contents have not arrived yet. */
  loading: boolean;
  /**
   * They are not being asked for either, until the server can be reached: said in words, not with a spinner
   * that never ends, and under whatever of the task the page already holds (a comment that came live).
   */
  waiting?: boolean;
}

export function Timeline({ task, loading, waiting }: Props) {
  const events = useTaskEvents(task.id);
  const comments = useLookup("comments");
  const stored = useStoredRows();
  const files = useAttachmentsBySubject("comment");
  const items = useMemo(() => buildTimeline(task.id, events, comments, stored), [task.id, events, comments, stored]);
  const can = useCan();
  const history = useMemo(() => commentHistory(events), [events]);

  return (
    <Section title={t("timeline.title")} className="pb-6">
      {loading && !waiting && items.length === 0 ? (
        <Loading />
      ) : (
        <ol className="mt-1 flex flex-col gap-2.5">
          {items.map((item) =>
            item.kind === "line" ? (
              <Line
                key={item.id}
                actorId={item.actorId}
                at={item.at}
                text={lineText(item)}
                note={item.note}
                quiet={item.quiet}
              />
            ) : (
              <li key={item.id}>
                <CommentCard
                  task={task}
                  comment={item.comment}
                  replies={item.replies}
                  files={files}
                  history={history}
                />
              </li>
            ),
          )}
        </ol>
      )}
      {waiting && (
        <output className="mt-3 block px-3 text-center text-sm text-ink-2">{t("timeline.noConnection")}</output>
      )}
      {can.editTask(task) && (
        <div className="mt-3">
          <Composer task={task} />
          <CommentReach task={task} />
        </div>
      )}
    </Section>
  );
}
