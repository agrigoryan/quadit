// The inline things of a page that are not text: a person or agent, a task,
// a decision, another page. Each shows live from the workspace copy.

import { createExtension } from "@blocknote/core";
import { FileText } from "lucide-react";
import { useMemo } from "react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useLookupEvenIfGone, useMe, useRowEvenIfGone, useRows, useTaskByKeyEvenIfGone } from "@/lib/selectors";
import type { Decision } from "@/lib/types";
import { docTitle } from "@/docs/data";
import { answerOf, DECISION_REF, decisionsOf } from "@/docs/editor/decision-refs";
import { openDecision, openDoc, openTask } from "@/docs/nav";
import { PageIcon } from "@/docs/page-icon";
import { DecisionMark, StatusIcon } from "@/ui/icons";

export function MentionChip({ handle }: { handle: string }) {
  // A removed member's mention still shows their name.
  const members = useLookupEvenIfGone("members");
  const member = useMemo(() => Object.values(members).find((m) => m.handle === handle), [members, handle]);
  const meId = useMe()?.user_id;
  const isMe = !!member && meId === member.user_id;
  return (
    <span className={cx("qd-chip qd-mention", isMe && "is-me")} data-handle={handle}>
      @{member?.name ?? handle}
    </span>
  );
}

/**
 * What makes a chip a link to what it names. The mouse opens it; the caret
 * moves over it while the page is edited (Mod-Enter beside it opens it: see
 * openChipAtCaret); in a page that cannot be edited it is a Tab stop that
 * Enter or Space opens.
 */
function chipLink(open: (() => void) | undefined, editable: boolean) {
  return {
    // An <a> inside the editor's text would be edited as a link of the text.
    role: "link",
    tabIndex: editable ? -1 : 0,
    onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
    onClick: () => open?.(),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (editable || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      open?.();
    },
  } as const;
}

/**
 * Mod-Enter while editing opens the chip the caret touches (the one before
 * it first), as a click on it would.
 */
export const openChipAtCaret = createExtension({
  key: "qdOpenChip",
  keyboardShortcuts: {
    "Mod-Enter": ({ editor }) => {
      const { selection } = editor.prosemirrorState;
      if (!selection.empty) return false;
      const $at = selection.$from;
      const isChip = (node: typeof $at.nodeBefore) => !!node && CHIPS.has(node.type.name);
      const at = isChip($at.nodeBefore)
        ? $at.pos - ($at.nodeBefore?.nodeSize ?? 0)
        : isChip($at.nodeAfter)
          ? $at.pos
          : -1;
      if (at < 0) return false;
      const dom = editor.prosemirrorView.nodeDOM(at);
      const link = dom instanceof HTMLElement ? dom.querySelector<HTMLElement>('[role="link"]') : null;
      link?.click();
      return !!link;
    },
  },
});

/** The inline content types that open what they name (a mention names a person, and opens nothing). */
const CHIPS = new Set(["taskChip", "decisionChip", "pageLink"]);

export function TaskChip({ taskKey, editable }: { taskKey: string; editable: boolean }) {
  // A trashed task is found, to be shown as gone.
  const task = useTaskByKeyEvenIfGone(taskKey);
  const category = useRowEvenIfGone("statuses", task?.status_id)?.category;
  return (
    <span
      className={cx("qd-chip qd-task", (!task || !!task.deleted_at) && "is-missing")}
      {...chipLink(task && (() => openTask(task.key)), editable)}
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
export function DecisionChip({ decisionRef, editable }: { decisionRef: string; editable: boolean }) {
  const m = DECISION_REF.exec(decisionRef.toUpperCase());
  // A trashed task is found, so its decision shows as gone.
  const task = useTaskByKeyEvenIfGone(m?.[1]);
  const live = !!task && !task.deleted_at;
  const decisions = useRows("decisions");
  const meId = useMe()?.user_id;
  const number = m ? Number(m[2]) : 0;
  // Its number counts the task's questions in the order asked, as the server does.
  const decision = useMemo(
    () => (live && number ? decisionsOf(decisions, task.id)[number - 1] : undefined),
    [live, number, decisions, task],
  );
  const mine = !!decision && decision.state === "open" && decision.asked_id === meId;
  const open = decision?.state === "open";
  return (
    <span
      className={cx("qd-chip qd-decision", !decision && "is-missing")}
      title={decision ? `${decisionRef.toUpperCase()} · ${decision.question}` : undefined}
      {...chipLink(task && decision && (() => openDecision(task.key, decision.id)), editable)}
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

export function PageChip({ docId, editable }: { docId: string; editable: boolean }) {
  // A trashed page is found, to show its title as gone.
  const doc = useRowEvenIfGone("docs", docId);
  const gone = !doc || !!doc.deleted_at;
  return (
    <span
      className={cx("qd-chip qd-page", gone && "is-missing")}
      {...chipLink(gone ? undefined : () => openDoc(docId), editable)}
    >
      {doc ? <PageIcon doc={doc} className="qd-chip-icon" /> : <FileText className="qd-chip-icon" />}
      <span className="qd-page-title">{docTitle(doc)}</span>
    </span>
  );
}
