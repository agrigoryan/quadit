// The question being composed in "Ask a question": its wording and details,
// how it is answered, the options with their files, the recommendation, whom
// to ask, and what is still wrong with it. One state, changed only through
// the named actions below.

import { useState } from "react";
import { errorMessage } from "@/lib/api";
import { uploadFile } from "@/lib/files";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { useMe, useTask } from "@/lib/selectors";
import type { NewDecision, NewOptionFile } from "@/decisions/actions";
import type { FileRole } from "@/decisions/data";
import type { DraftFile, DraftOption } from "@/decisions/option-editor";

export type AnswerKind = NewDecision["kind"];

/** What stops the question from being sent, found when the asker tries to. */
interface Problems {
  question?: string;
  options?: string;
  /** Options that have content but no label. */
  unlabelled: string[];
}

interface Composed {
  question: string;
  details: string;
  kind: AnswerKind;
  options: DraftOption[];
  /** The id of the option the asker recommends. */
  recommended: string | null;
  /** Why that one. */
  reason: string;
  /** Who should answer; null for anyone. */
  ask: string | null;
  problems: Problems;
}

const blank = (): DraftOption => ({ id: newId(), label: "", description: "", files: [] });
const hasContent = (o: DraftOption) => !!o.label.trim() || !!o.description.trim() || o.files.length > 0;
const labelled = (options: DraftOption[]) => options.filter((o) => o.label.trim()).length;

/** What is wrong with the question, and the question as it would be sent when nothing is. */
function examine(taskId: string, draft: Composed): { problems: Problems; decision: NewDecision | null } {
  const { question, details, kind, options, recommended, reason, ask } = draft;
  const kept = kind === "choice" ? options.filter(hasContent) : [];
  const problems: Problems = { unlabelled: kept.filter((o) => !o.label.trim()).map((o) => o.id) };
  if (!question.trim()) problems.question = t("decision.new.needQuestion");
  if (kind === "choice" && labelled(kept) < 2) problems.options = t("decision.new.needOptions");
  if (problems.question || problems.options || problems.unlabelled.length > 0) return { problems, decision: null };
  const decision: NewDecision = {
    taskId,
    kind,
    question,
    details,
    options: kept.map((o) => ({
      ...o,
      files: o.files.flatMap((f): NewOptionFile[] => (f.file ? [{ file: f.file, role: f.role }] : [])),
    })),
    recommended: kept.some((o) => o.id === recommended) ? (recommended ?? undefined) : undefined,
    recommendation: reason,
    ask: ask ?? undefined,
  };
  return { problems, decision };
}

/** The question, its options and the ways to change them, for the task `taskId`. */
export function useNewDecision(taskId: string) {
  const me = useMe();
  const task = useTask(taskId);
  const [draft, setDraft] = useState<Composed>(() => ({
    question: "",
    details: "",
    kind: "choice",
    options: [blank(), blank()],
    recommended: null,
    reason: "",
    // Whoever works on the task is the likely one to ask.
    ask: task?.assignee_id && task.assignee_id !== me.user_id ? task.assignee_id : null,
    problems: { unlabelled: [] },
  }));

  const set = (fields: Partial<Composed>) => setDraft((d) => ({ ...d, ...fields }));
  const changeOptions = (change: (list: DraftOption[]) => DraftOption[]) =>
    setDraft((d) => ({ ...d, options: change(d.options) }));
  const changeOption = (id: string, change: (o: DraftOption) => DraftOption) =>
    changeOptions((list) => list.map((o) => (o.id === id ? change(o) : o)));
  const changeFile = (id: string, key: string, fields: Partial<DraftFile>) =>
    changeOption(id, (o) => ({ ...o, files: o.files.map((f) => (f.key === key ? { ...f, ...fields } : f)) }));

  const actions = {
    setQuestion: (question: string) => set({ question }),
    setDetails: (details: string) => set({ details }),
    setKind: (kind: AnswerKind) => set({ kind }),
    setAsk: (ask: string | null) => set({ ask }),
    setRecommended: (recommended: string | null) => set({ recommended }),
    setReason: (reason: string) => set({ reason }),
    addOption: () => changeOptions((list) => [...list, blank()]),
    removeOption: (id: string) => changeOptions((list) => list.filter((o) => o.id !== id)),
    editOption: (id: string, fields: Partial<Pick<DraftOption, "label" | "description">>) =>
      changeOption(id, (o) => ({ ...o, ...fields })),
    moveOption: (index: number, delta: -1 | 1) =>
      changeOptions((list) => {
        const next = [...list];
        const [moved] = next.splice(index, 1);
        if (moved) next.splice(index + delta, 0, moved);
        return next;
      }),
    /** Shows each file at once and uploads it; the option keeps it once the upload is done. */
    addFiles: (id: string, files: File[]) => {
      const entries = files.map((file) => ({ key: newId(), name: file.name, source: file }));
      changeOption(id, (o) => ({ ...o, files: [...o.files, ...entries.map(({ key, name }) => ({ key, name }))] }));
      for (const entry of entries) {
        uploadFile(entry.source).then(
          (file) => changeFile(id, entry.key, { file }),
          (err) => changeFile(id, entry.key, { failed: errorMessage(err) }),
        );
      }
    },
    removeFile: (id: string, key: string) =>
      changeOption(id, (o) => ({ ...o, files: o.files.filter((f) => f.key !== key) })),
    setFileRole: (id: string, key: string, role: FileRole | undefined) => changeFile(id, key, { role }),

    /**
     * Looks for what is missing. Returns the question ready to send, or null
     * with the problems now on show.
     */
    check: (): NewDecision | null => {
      const { problems, decision } = examine(taskId, draft);
      set({ problems });
      return decision;
    },
  };

  const { problems } = draft;
  return {
    draft,
    actions,
    // A message stays only while what it points at is still wrong.
    questionError: !draft.question.trim() ? problems.question : undefined,
    optionsError: labelled(draft.options) < 2 ? problems.options : undefined,
    labelError: (option: DraftOption) =>
      problems.unlabelled.includes(option.id) && !option.label.trim() ? t("decision.new.needLabel") : undefined,
    uploading: draft.kind === "choice" && draft.options.some((o) => o.files.some((f) => !f.file && !f.failed)),
  };
}

export type NewDecisionDraft = ReturnType<typeof useNewDecision>;
