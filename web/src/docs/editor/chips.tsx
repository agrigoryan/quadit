// The inline things of a page that are not text: a person or agent, a task,
// a decision, another page. Each shows live from the workspace copy, and
// opens what it names: the task, the decision, the page, the card about the
// member.

import { createExtension } from "@blocknote/core";
import { FileText } from "lucide-react";
import { useMemo, useState } from "react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useLookupEvenIfGone, useMe, useRowEvenIfGone, useRows, useTaskByKeyEvenIfGone } from "@/data/selectors";
import { useFindTask } from "@/data/find-task";
import { useRestLoaded } from "@/data/store";
import type { Decision } from "@/types/core";
import { PageIcon, docTitle } from "@/ui/page-name";
import { answerOf, DECISION_REF, decisionsOf } from "@/docs/editor/decision-refs";
import { openDecision, openDoc, openTask } from "@/docs/nav";
import { MemberCard } from "@/tasks/member-card";
import { DecisionMark } from "@/ui/icons";
import { TaskMention } from "@/ui/task-mention";

interface MentionProps {
  handle: string;
  editable: boolean;
  /** Gives the editor the focus back, at its caret, when the card closes while the page is edited. */
  focusEditor?: () => void;
}

/** A person or an agent: it opens the card about them (tasks/member-card.tsx), the way the other chips open what they name. */
export function MentionChip({ handle, editable, focusEditor }: MentionProps) {
  // A removed member's mention still shows their name, and their card.
  const members = useLookupEvenIfGone("members");
  const member = useMemo(() => Object.values(members).find((m) => m.handle === handle), [members, handle]);
  const meId = useMe()?.user_id;
  const [open, setOpen] = useState(false);
  const isMe = !!member && meId === member.user_id;
  const chip = (
    <span
      className={cx("qd-chip qd-mention", isMe && "is-me")}
      data-handle={handle}
      {...(member && chipControl("button", () => setOpen(true), editable))}
    >
      @{member?.name ?? handle}
    </span>
  );
  if (!member) return chip;
  return (
    <MemberCard
      member={member}
      open={open}
      onOpenChange={setOpen}
      onCloseAutoFocus={(e) => {
        if (!editable || !focusEditor) return;
        // While the page is edited the focus goes back to the text, and not to the chip.
        e.preventDefault();
        focusEditor();
      }}
    >
      {chip}
    </MemberCard>
  );
}

/**
 * What makes a chip a link to what it names. The mouse opens it; the caret
 * moves over it while the page is edited (Mod-Enter beside it opens it: see
 * openChipAtCaret); in a page that cannot be edited it is a Tab stop that
 * Enter or Space opens.
 */
function chipLink(open: (() => void) | undefined, editable: boolean) {
  return { ...chipControl("link", open, editable), onClick: () => open?.() };
}

/**
 * The keyboard and focus of a chip that is a control. A mention's card
 * opens on a click by itself (it is the card's trigger), so only the keys
 * are given `open` here.
 */
function chipControl(role: "link" | "button", open: (() => void) | undefined, editable: boolean) {
  return {
    // An <a> or a <button> inside the editor's text would be edited as part of the text.
    role,
    tabIndex: editable ? -1 : 0,
    onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
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
      const view = editor.prosemirrorView;
      if (!view.state.selection.empty) return false;
      // The caret where the browser shows it: beside an inline chip the editor's own idea of it can be a step off.
      const shown = window.getSelection();
      const caret =
        shown?.isCollapsed && shown.anchorNode && view.dom.contains(shown.anchorNode)
          ? view.posAtDOM(shown.anchorNode, shown.anchorOffset)
          : view.state.selection.from;
      const $at = view.state.doc.resolve(caret);
      const isChip = (node: typeof $at.nodeBefore) => !!node && CHIPS.has(node.type.name);
      const at = isChip($at.nodeBefore)
        ? $at.pos - ($at.nodeBefore?.nodeSize ?? 0)
        : isChip($at.nodeAfter)
          ? $at.pos
          : -1;
      if (at < 0) return false;
      const dom = view.nodeDOM(at);
      const link = dom instanceof HTMLElement ? dom.querySelector<HTMLElement>('[role="link"], [role="button"]') : null;
      link?.click();
      return !!link;
    },
  },
});

/** The inline content types that open what they name (a mention, the card about the member). */
const CHIPS = new Set(["taskChip", "decisionChip", "pageLink", "mention"]);

/** A task, drawn as the task's mention is wherever text names one (ui/task-mention.tsx). */
export function TaskChip({ taskKey, editable }: { taskKey: string; editable: boolean }) {
  // A trashed task opens too: its page says it is in the trash. A moved one opens under its new key.
  const { task } = useFindTask(taskKey, useRestLoaded());
  return <TaskMention taskKey={taskKey} control={chipLink(task && (() => openTask(task.key)), editable)} />;
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
