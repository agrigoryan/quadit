// The inline things of a page that are not text: a person or agent, a task,
// a decision, another page. Each shows live from the workspace copy.

import { FileText } from "lucide-react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useTaskByKey } from "@/lib/selectors";
import { useStore } from "@/lib/store";
import type { Decision } from "@/lib/types";
import { docTitle, useDoc } from "@/docs/data";
import { answerOf, DECISION_REF, decisionsOf } from "@/docs/editor/decision-refs";
import { openDecision, openDoc, openTask } from "@/docs/nav";
import { PageIcon } from "@/docs/page-icon";
import { DecisionMark, StatusIcon } from "@/ui/icons";

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

/** How a decision stands, in the fewest words: "Open", "Picked: B: burst", "Approved". */
export function decisionStateText(decision: Decision): string {
  const answer = answerOf(decision);
  if (answer.kind === "picked")
    return answer.label ? t("docs.decision.pickedLabel", { label: answer.label }) : t("docs.decision.picked");
  return t(`docs.decision.${answer.kind}`);
}

/** A decision, named as the server reads it ("SVA-7#2"): its task's key, the question, and how it stands. */
export function DecisionChip({ decisionRef }: { decisionRef: string }) {
  const m = DECISION_REF.exec(decisionRef.toUpperCase());
  const task = useTaskByKey(m?.[1]);
  const live = !!task && !task.deleted_at;
  // Its number counts the task's questions in the order asked, as the server does.
  const decision = useStore((s) => (live && m ? decisionsOf(s.c, task.id)[Number(m[2]) - 1] : undefined));
  const mine = useStore((s) => !!decision && decision.state === "open" && decision.asked_id === s.me?.user_id);
  const open = decision?.state === "open";
  return (
    <span
      className={cx("qd-chip qd-decision", !decision && "is-missing")}
      role="link"
      tabIndex={-1}
      title={decision ? `${decisionRef.toUpperCase()} · ${decision.question}` : undefined}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => task && decision && openDecision(task.key, decision.id)}
    >
      <DecisionMark mine={mine} className="qd-chip-icon" />
      <span className="qd-task-key">{decision && task ? task.key : decisionRef.toUpperCase()}</span>
      {decision && (
        <>
          <span className="qd-decision-sep" aria-hidden>
            ·
          </span>
          <span className="qd-task-title">{decision.question}</span>
          <span className={cx("qd-decision-state", open && "is-open")}>{decisionStateText(decision)}</span>
        </>
      )}
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
