// The inline things of a page that are not text: a person or agent, a task,
// another page. Each shows live from the workspace copy.

import { FileText } from "lucide-react";
import { cx } from "@/lib/cx";
import { useTaskByKey } from "@/lib/selectors";
import { useStore } from "@/lib/store";
import { docTitle, useDoc } from "@/docs/data";
import { openDoc, openTask } from "@/docs/nav";
import { PageIcon } from "@/docs/page-icon";
import { StatusIcon } from "@/ui/icons";

export function MentionChip({ handle }: { handle: string }) {
  const member = useStore((s) => Object.values(s.c.members).find((m) => m.handle === handle));
  const isMe = useStore((s) => !!member && s.me?.user_id === member.user_id);
  return (
    <span className={cx("qd-chip qd-mention", isMe && "is-me")} data-handle={handle}>
      @{member?.name ?? handle}
    </span>
  );
}

export function TaskChip({ taskKey }: { taskKey: string }) {
  const task = useTaskByKey(taskKey);
  const category = useStore((s) => (task ? s.c.statuses[task.status_id]?.category : undefined));
  return (
    <span
      className={cx("qd-chip qd-task", (!task || !!task.deleted_at) && "is-missing")}
      role="link"
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => task && openTask(task.key)}
    >
      {category && <StatusIcon category={category} className="qd-chip-icon" />}
      <span className="qd-task-key">{taskKey.toUpperCase()}</span>
      {task && <span className="qd-task-title">{task.title}</span>}
    </span>
  );
}

export function PageChip({ docId }: { docId: string }) {
  const doc = useDoc(docId);
  const gone = !doc || !!doc.deleted_at;
  return (
    <span
      className={cx("qd-chip qd-page", gone && "is-missing")}
      role="link"
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => !gone && openDoc(docId)}
    >
      {doc ? <PageIcon doc={doc} className="qd-chip-icon" /> : <FileText className="qd-chip-icon" />}
      <span className="qd-page-title">{docTitle(doc)}</span>
    </span>
  );
}
