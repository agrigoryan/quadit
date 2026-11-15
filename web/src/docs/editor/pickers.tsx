// Picking the task, the decision or the page a chip stands for, after the
// slash menu's "Task", "Decision" or "Page link".

import { useMemo } from "react";
import { t } from "@/lib/i18n";
import { useLiveTasks } from "@/lib/selectors";
import { useStore } from "@/lib/store";
import { docTitle, useLinkablePages } from "@/docs/data";
import { decisionStateText } from "@/docs/editor/chips";
import { mentionable } from "@/docs/editor/decision-refs";
import { PageIcon } from "@/docs/page-icon";
import { Dialog } from "@/ui/dialog";
import { DecisionMark, StatusIcon } from "@/ui/icons";
import { PickerList } from "@/ui/picker";

export type ChipKind = "task" | "decision" | "page";

interface Props {
  kind: ChipKind | null;
  onClose: () => void;
  /** A task key, a decision as "SVA-7#2", or a page id. */
  onPick: (kind: ChipKind, ref: string) => void;
}

const TITLE = { task: "docs.slash.task", decision: "docs.slash.decision", page: "docs.slash.page" } as const;

export function ChipPicker({ kind, onClose, onPick }: Props) {
  return (
    <Dialog
      open={kind !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t(TITLE[kind ?? "task"])}
      hideTitle
      size="sm"
      className="[&_[cmdk-root]]:w-full"
    >
      <div className="-mx-4 -my-3">
        {kind === "task" ? (
          <TaskList onPick={(key) => onPick("task", key)} />
        ) : kind === "decision" ? (
          <DecisionList onPick={(ref) => onPick("decision", ref)} />
        ) : kind === "page" ? (
          <PageList onPick={(id) => onPick("page", id)} />
        ) : null}
      </div>
    </Dialog>
  );
}

function TaskList({ onPick }: { onPick: (key: string) => void }) {
  const tasks = useLiveTasks();
  const statuses = useStore((s) => s.c.statuses);
  const items = useMemo(
    () =>
      [...tasks]
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, 400)
        .map((task) => ({
          id: task.key,
          label: task.title,
          keywords: task.key,
          hint: task.key,
          icon: <StatusIcon category={statuses[task.status_id]?.category ?? "backlog"} />,
        })),
    [tasks, statuses],
  );
  return <PickerList items={items} onPick={onPick} label={t("docs.slash.task")} placeholder={t("docs.pick.task")} />;
}

function DecisionList({ onPick }: { onPick: (ref: string) => void }) {
  const c = useStore((s) => s.c);
  const me = useStore((s) => s.me?.user_id);
  const items = useMemo(
    () =>
      mentionable(c)
        .slice(0, 400)
        .map((f) => ({
          id: f.ref,
          label: f.decision.question,
          keywords: `${f.ref} ${f.task.key} ${f.task.title}`,
          hint: `${f.task.key} · ${decisionStateText(f.decision)}`,
          icon: <DecisionMark mine={f.decision.state === "open" && f.decision.asked_id === me} />,
        })),
    [c, me],
  );
  return (
    <PickerList items={items} onPick={onPick} label={t("docs.slash.decision")} placeholder={t("docs.pick.decision")} />
  );
}

function PageList({ onPick }: { onPick: (id: string) => void }) {
  const pages = useLinkablePages();
  const items = useMemo(
    () => pages.map((doc) => ({ id: doc.id, label: docTitle(doc), icon: <PageIcon doc={doc} /> })),
    [pages],
  );
  return <PickerList items={items} onPick={onPick} label={t("docs.slash.page")} placeholder={t("docs.pick.page")} />;
}
