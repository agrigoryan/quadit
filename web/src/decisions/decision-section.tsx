// The decisions of a task, inside the task panel: each question as a block,
// the open ones first, and the button that asks a new one. A task with no
// decisions shows only that button. D answers: the first open question
// asked of me takes it (decisions/decision-block.tsx); with none, a short
// note says so.

import { type DragEvent, useState } from "react";
import { MessageCircleQuestion } from "lucide-react";
import { useCan } from "@/data/access";
import { useHotkeys } from "@/hooks/hotkeys";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { useMe, useRowEvenIfGone } from "@/data/selectors";
import { Section } from "@/detail/section";
import { Button } from "@/ui/button";
import { useTaskDecisions } from "@/decisions/data";
import { DecisionBlock } from "@/decisions/decision-block";
import { NewDecisionDialog } from "@/decisions/new-decision-dialog";

/** Files dragged over the dialog belong to its options, not to whatever is behind it. */
const keepDrags = {
  onDragEnter: (e: DragEvent) => e.stopPropagation(),
  onDragLeave: (e: DragEvent) => e.stopPropagation(),
  onDragOver: (e: DragEvent) => {
    e.stopPropagation();
    if (e.defaultPrevented) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "none";
  },
  onDrop: (e: DragEvent) => {
    e.stopPropagation();
    e.preventDefault();
  },
};

export function DecisionSection({ taskId }: { taskId: string }) {
  // The section is drawn on a trashed task's page too, without the button.
  const task = useRowEvenIfGone("tasks", taskId);
  const can = useCan();
  const decisions = useTaskDecisions(taskId);
  const [asking, setAsking] = useState(false);
  const canAsk = !!task && can.editTask(task);
  const open = decisions.filter((d) => d.state === "open").length;
  const me = useMe();
  // Answering is a change to the task: none from one who may not change it, nor of a question one asked (decisions/data.ts useViewer).
  const asked = canAsk
    ? decisions.find((d) => d.state === "open" && d.asked_id === me.user_id && d.created_by !== me.user_id)
    : undefined;
  useHotkeys({ d: () => toast.info(t("decision.noneAsked")) }, { layer: "panel", enabled: !asked });

  const dialog = asking && (
    <div className="contents" {...keepDrags}>
      <NewDecisionDialog taskId={taskId} onClose={() => setAsking(false)} />
    </div>
  );
  const ask = canAsk && (
    <Button variant="ghost" size="sm" className="max-md:h-9 max-md:px-2.5" onClick={() => setAsking(true)}>
      <MessageCircleQuestion className="size-3.5" aria-hidden />
      {t("decision.ask")}
    </Button>
  );

  if (decisions.length === 0) {
    if (!canAsk) return null;
    return (
      <div className="flex border-t border-line px-2.5 py-1.5 md:px-4.5">
        {ask}
        {dialog}
      </div>
    );
  }

  return (
    <Section
      title={t("decision.section")}
      meta={open > 0 ? <span className="text-xs text-ink-3">{t("decision.openCount", { n: open })}</span> : undefined}
      action={ask}
    >
      <div className="mt-2 mb-2 flex flex-col gap-7">
        {decisions.map((decision) => (
          <DecisionBlock key={decision.id} decision={decision} answerKey={decision === asked} />
        ))}
      </div>
      {dialog}
    </Section>
  );
}
