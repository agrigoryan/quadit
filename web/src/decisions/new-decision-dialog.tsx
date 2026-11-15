// "Ask a question" on a task: the question, its details, a choice between
// options (each with media) or a plain approval, the asker's recommendation
// and who should answer. Checked here before it is sent.

import { useId, useRef, useState } from "react";
import { ChevronDown, Plus, Users } from "lucide-react";
import { errorMessage } from "@/lib/api";
import { cx } from "@/lib/cx";
import { uploadFile } from "@/lib/files";
import { MOD } from "@/lib/hotkeys";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { useMe, useMembers, useTask } from "@/lib/selectors";
import { memberItems } from "@/tasks/property-picker";
import { Avatar } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Field, Input } from "@/ui/input";
import { MentionTextarea } from "@/ui/mention-textarea";
import { Picker } from "@/ui/picker";
import { type NewOptionFile, openDecision } from "@/decisions/actions";
import { useReturnFocus } from "@/decisions/data";
import { type DraftFile, type DraftOption, OptionEditor } from "@/decisions/option-editor";

const ANYONE = "anyone";
const blank = (): DraftOption => ({ id: newId(), label: "", description: "", files: [] });
const hasContent = (o: DraftOption) => !!o.label.trim() || !!o.description.trim() || o.files.length > 0;

interface Problems {
  question?: string;
  options?: string;
  /** Options that have content but no label. */
  unlabelled: string[];
}

/** Mount it only while it is open, so each question starts empty. */
export function NewDecisionDialog({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const me = useMe();
  const task = useTask(taskId);
  const members = useMembers();
  const others = members.filter((m) => m.user_id !== me.user_id && !m.suspended_at);
  const ids = { question: useId(), details: useId() };
  const form = useRef<HTMLDivElement | null>(null);
  useReturnFocus();

  const [question, setQuestion] = useState("");
  const [details, setDetails] = useState("");
  const [kind, setKind] = useState<"choice" | "approval">("choice");
  const [options, setOptions] = useState<DraftOption[]>(() => [blank(), blank()]);
  const [recommended, setRecommended] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  // Whoever works on the task is the likely one to ask.
  const [ask, setAsk] = useState<string | null>(() => (task?.assignee_id && task.assignee_id !== me.user_id ? task.assignee_id : null));
  const [problems, setProblems] = useState<Problems>({ unlabelled: [] });
  const [refused, setRefused] = useState("");
  const [sending, setSending] = useState(false);

  const asked = others.find((m) => m.user_id === ask);
  // A message stays only while what it points at is still wrong.
  const questionError = !question.trim() ? problems.question : undefined;
  const optionsError = options.filter((o) => o.label.trim()).length < 2 ? problems.options : undefined;
  const uploading = kind === "choice" && options.some((o) => o.files.some((f) => !f.file && !f.failed));

  const patchOption = (id: string, change: (o: DraftOption) => DraftOption) => setOptions((list) => list.map((o) => (o.id === id ? change(o) : o)));
  const patchFile = (id: string, key: string, fields: Partial<DraftFile>) =>
    patchOption(id, (o) => ({ ...o, files: o.files.map((f) => (f.key === key ? { ...f, ...fields } : f)) }));

  function addFiles(id: string, files: File[]) {
    const entries = files.map((file) => ({ key: newId(), name: file.name, source: file }));
    patchOption(id, (o) => ({ ...o, files: [...o.files, ...entries.map(({ key, name }) => ({ key, name }))] }));
    for (const entry of entries) {
      uploadFile(entry.source).then(
        (file) => patchFile(id, entry.key, { file }),
        (err) => patchFile(id, entry.key, { failed: errorMessage(err) }),
      );
    }
  }

  function move(index: number, delta: -1 | 1) {
    setOptions((list) => {
      const next = [...list];
      const [moved] = next.splice(index, 1);
      if (moved) next.splice(index + delta, 0, moved);
      return next;
    });
  }

  async function submit() {
    if (sending || uploading) return;
    const kept = kind === "choice" ? options.filter(hasContent) : [];
    const found: Problems = { unlabelled: kept.filter((o) => !o.label.trim()).map((o) => o.id) };
    if (!question.trim()) found.question = t("decision.new.needQuestion");
    if (kind === "choice" && kept.filter((o) => o.label.trim()).length < 2) found.options = t("decision.new.needOptions");
    setProblems(found);
    setRefused("");
    if (found.question || found.options || found.unlabelled.length > 0) {
      // Bring the first thing to fix into view once it is drawn.
      requestAnimationFrame(() => form.current?.querySelector('[role="alert"]')?.scrollIntoView({ block: "center" }));
      return;
    }

    setSending(true);
    try {
      await openDecision({
        taskId,
        kind,
        question,
        details,
        options: kept.map((o) => ({ ...o, files: o.files.flatMap((f): NewOptionFile[] => (f.file ? [{ file: f.file, role: f.role }] : [])) })),
        recommended: kept.some((o) => o.id === recommended) ? (recommended ?? undefined) : undefined,
        recommendation: reason,
        ask: ask ?? undefined,
      });
      onClose();
    } catch (err) {
      setRefused(errorMessage(err));
      setSending(false);
    }
  }

  const kindButton = (value: "choice" | "approval", label: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={kind === value}
      onClick={() => setKind(value)}
      className={cx(
        "h-7 rounded-sm px-2.5 text-sm font-medium max-sm:h-9 max-sm:flex-1",
        kind === value ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:text-ink",
      )}
    >
      {label}
    </button>
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("decision.new.title")}
      description={task ? t("decision.new.onTask", { key: task.key, title: task.title }) : undefined}
      size="lg"
      footer={
        <>
          {refused && (
            <p role="alert" className="mr-auto min-w-0 text-xs text-danger">
              {refused}
            </p>
          )}
          <Button variant="ghost" className="max-sm:h-10" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" className="max-sm:h-10 max-sm:flex-1" disabled={sending || uploading} onClick={() => void submit()}>
            {uploading ? t("decision.new.waitUploads") : asked ? t("decision.new.submitTo", { name: asked.name }) : t("decision.new.submit")}
          </Button>
        </>
      }
    >
      <div
        ref={form}
        className="flex flex-col gap-4"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <Field label={t("decision.new.question")} htmlFor={ids.question}>
          <Input
            id={ids.question}
            autoFocus
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={t("decision.new.questionPlaceholder")}
            aria-invalid={!!questionError}
            className={cx("h-9! text-base! font-medium max-sm:h-10!", questionError && "border-danger!")}
          />
          {questionError && (
            <p role="alert" className="text-xs text-danger">
              {questionError}
            </p>
          )}
        </Field>

        <Field label={t("decision.new.details")} htmlFor={ids.details} hint={t("decision.new.detailsHint", { mod: MOD })}>
          <MentionTextarea
            id={ids.details}
            value={details}
            onChange={setDetails}
            rows={2}
            placeholder={t("decision.new.detailsPlaceholder")}
            className="min-h-14 max-sm:text-base"
          />
        </Field>

        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <div className="flex flex-col gap-1 max-sm:w-full">
            <span id={`${ids.question}-kind`} className="text-xs font-medium text-ink-2">
              {t("decision.new.kind")}
            </span>
            <div role="radiogroup" aria-labelledby={`${ids.question}-kind`} className="inline-flex gap-0.5 rounded-md bg-sunken p-0.5">
              {kindButton("choice", t("decision.new.choice"))}
              {kindButton("approval", t("decision.new.approval"))}
            </div>
          </div>
          <div className="flex flex-col gap-1 max-sm:w-full">
            <span className="text-xs font-medium text-ink-2">{t("decision.new.ask")}</span>
            <Picker
              label={t("decision.new.ask")}
              value={ask ?? ANYONE}
              onPick={(id) => setAsk(id === ANYONE ? null : id)}
              items={[
                { id: ANYONE, label: t("decision.new.anyone"), icon: <Users className="size-3.5 text-ink-3" aria-hidden /> },
                ...memberItems(others, me.user_id),
              ]}
            >
              <Button className="h-8! justify-between! gap-2! max-sm:h-10! max-sm:w-full">
                <span className="flex min-w-0 items-center gap-1.5">
                  {asked ? <Avatar member={asked} size="xs" /> : <Users className="size-3.5 text-ink-3" aria-hidden />}
                  <span className="truncate">{asked ? asked.name : t("decision.new.anyone")}</span>
                </span>
                <ChevronDown className="size-3.5 text-ink-3" aria-hidden />
              </Button>
            </Picker>
          </div>
        </div>

        {kind === "choice" ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-medium text-ink-2">{t("decision.new.options")}</span>
              <span className="text-xs text-ink-3 max-sm:hidden">{t("decision.new.dropHint")}</span>
            </div>
            <ol className="flex flex-col gap-2">
              {options.map((option, index) => (
                <OptionEditor
                  key={option.id}
                  option={option}
                  index={index}
                  total={options.length}
                  labelError={problems.unlabelled.includes(option.id) && !option.label.trim() ? t("decision.new.needLabel") : undefined}
                  recommended={recommended === option.id}
                  reason={reason}
                  onChange={(fields) => patchOption(option.id, (o) => ({ ...o, ...fields }))}
                  onMove={(delta) => move(index, delta)}
                  onRemove={() => setOptions((list) => list.filter((o) => o.id !== option.id))}
                  onRecommend={(on) => setRecommended(on ? option.id : null)}
                  onReason={setReason}
                  onAddFiles={(files) => addFiles(option.id, files)}
                  onRemoveFile={(key) => patchOption(option.id, (o) => ({ ...o, files: o.files.filter((f) => f.key !== key) }))}
                  onFileRole={(key, role) => patchFile(option.id, key, { role })}
                />
              ))}
            </ol>
            {optionsError && (
              <p role="alert" className="text-xs text-danger">
                {optionsError}
              </p>
            )}
            <Button variant="ghost" className="self-start max-sm:h-10" onClick={() => setOptions((list) => [...list, blank()])}>
              <Plus className="size-4" aria-hidden />
              {t("decision.new.addOption")}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-ink-2">{t("decision.new.approvalHint")}</p>
        )}
      </div>
    </Dialog>
  );
}
