import { useState } from "react";
import { Plus, X } from "lucide-react";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { mutate } from "@/lib/mutate";
import { useLabels, useStatuses } from "@/lib/selectors";
import type { Project, Template } from "@/lib/types";
import type { DecisionSkeleton, Preset } from "@/settings/projects/templates";
import { Dot } from "@/ui/dot";
import { FormField, NativeSelect, refuse, SwitchRow, useFieldErrors } from "@/ui/form";
import { FormDialog } from "@/ui/form-dialog";
import { MultiPick } from "@/settings/ui/multi-pick";
import { Button, IconButton } from "@/ui/button";
import { Input, Textarea } from "@/ui/input";

interface Option {
  label: string;
  description: string;
}

const blankOptions = (): Option[] => [
  { label: "", description: "" },
  { label: "", description: "" },
];

/** Makes or edits a task template: what the task starts with, and the question it may open. */
export function TemplateDialog({
  project,
  template,
  onClose,
}: {
  project: Project;
  template?: Template;
  onClose: () => void;
}) {
  const preset = (template?.preset ?? {}) as Preset;
  const statuses = useStatuses(project.id);
  const labels = useLabels(project.id);
  const [name, setName] = useState(template?.name ?? "");
  const [title, setTitle] = useState(template?.title ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [status, setStatus] = useState(preset.status ?? "");
  const [priority, setPriority] = useState(preset.priority ?? 0);
  const [picked, setPicked] = useState<string[]>(preset.labels ?? []);
  const [asks, setAsks] = useState(!!preset.decision);
  const [kind, setKind] = useState<"choice" | "approval">(preset.decision?.kind ?? "choice");
  const [question, setQuestion] = useState(preset.decision?.question ?? "");
  const [details, setDetails] = useState(preset.decision?.details ?? "");
  const [options, setOptions] = useState<Option[]>(
    preset.decision?.options?.length
      ? preset.decision.options.map((o) => ({ label: o.label, description: o.description ?? "" }))
      : blankOptions(),
  );
  const errors = useFieldErrors(["name", "title", "description", "question", "options"]);

  // A preset names its status and labels, so the same template works when they are renamed back or shared.
  const statusChoices = [
    { value: "", label: t("templates.statusDefault") },
    ...statuses.map((s) => ({ value: s.name, label: s.name })),
  ];
  if (status && !statuses.some((s) => s.name === status)) statusChoices.push({ value: status, label: status });
  const labelItems = [...new Set([...labels.map((l) => l.name), ...picked])].map((n) => ({
    id: n,
    label: n,
    icon: <Dot color={labels.find((l) => l.name === n)?.color} />,
  }));

  const setOption = (i: number, patch: Partial<Option>) =>
    setOptions((list) => list.map((o, at) => (at === i ? { ...o, ...patch } : o)));

  async function save() {
    if (!name.trim()) refuse("name", t("s.required"));
    const next: Preset = {};
    if (status) next.status = status;
    if (priority) next.priority = priority;
    if (picked.length) next.labels = picked;
    if (preset.assignee) next.assignee = preset.assignee;
    if (preset.estimate) next.estimate = preset.estimate;
    if (asks) {
      if (!question.trim()) refuse("question", t("templates.questionNeed"));
      const decision: DecisionSkeleton = { kind, question: question.trim() };
      if (details.trim()) decision.details = details.trim();
      if (kind === "choice") {
        const named = options.filter((o) => o.label.trim());
        if (named.length < 2) refuse("options", t("templates.optionsNeed"));
        decision.options = named.map((o) => ({
          label: o.label.trim(),
          ...(o.description.trim() ? { description: o.description.trim() } : {}),
        }));
      }
      next.decision = decision;
    }
    const fields = { name: name.trim(), title, description, preset: next };
    await mutate(
      template
        ? { type: "template.update", args: { id: template.id, ...fields } }
        : { type: "template.create", args: { id: newId(), project: project.id, ...fields } },
      undefined,
      { quiet: true },
    );
  }

  return (
    <FormDialog
      title={template ? t("templates.edit") : t("templates.new")}
      submit={template ? t("common.save") : t("s.create")}
      errors={errors}
      onSubmit={save}
      onClose={onClose}
    >
      <FormField label={t("templates.name")} htmlFor="tpl-name" error={errors.fields.name}>
        <Input
          id="tpl-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("templates.namePlaceholder")}
          maxLength={80}
        />
      </FormField>
      <FormField
        label={t("templates.taskTitle")}
        htmlFor="tpl-title"
        hint={t("templates.taskTitleHint")}
        error={errors.fields.title}
      >
        <Input id="tpl-title" value={title} onChange={(e) => setTitle(e.target.value)} />
      </FormField>
      <FormField
        label={t("templates.description")}
        htmlFor="tpl-desc"
        hint={t("templates.descriptionHint")}
        error={errors.fields.description}
      >
        <Textarea
          id="tpl-desc"
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="font-mono text-xs"
        />
      </FormField>
      <div className="grid grid-cols-2 gap-3.5">
        <FormField label={t("templates.status")} htmlFor="tpl-status">
          <NativeSelect id="tpl-status" value={status} onChange={setStatus} options={statusChoices} />
        </FormField>
        <FormField label={t("templates.priority")} htmlFor="tpl-priority">
          <NativeSelect
            id="tpl-priority"
            value={String(priority)}
            onChange={(v) => setPriority(Number(v))}
            options={[0, 1, 2, 3, 4].map((p) => ({
              value: String(p),
              label: t(`priority.${p as 0 | 1 | 2 | 3 | 4}`),
            }))}
          />
        </FormField>
      </div>
      <FormField label={t("templates.labels")}>
        <MultiPick
          items={labelItems}
          value={picked}
          onChange={setPicked}
          addLabel={t("templates.labelsAdd")}
          empty={t("templates.labelsNone")}
        />
      </FormField>

      <div className="border-t border-line pt-3">
        <SwitchRow
          title={t("templates.decision")}
          hint={t("templates.decisionHint")}
          checked={asks}
          onChange={setAsks}
        />
      </div>
      {asks && (
        <div className="flex flex-col gap-3.5 rounded-lg border border-line bg-sunken/50 p-3">
          <FormField label={t("templates.decisionKind")} htmlFor="tpl-kind">
            <NativeSelect
              id="tpl-kind"
              value={kind}
              onChange={(v) => setKind(v as "choice" | "approval")}
              options={[
                { value: "choice", label: t("templates.decisionKind.choice") },
                { value: "approval", label: t("templates.decisionKind.approval") },
              ]}
            />
          </FormField>
          <FormField label={t("templates.question")} htmlFor="tpl-question" error={errors.fields.question}>
            <Input
              id="tpl-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={t("templates.questionPlaceholder")}
            />
          </FormField>
          <FormField label={`${t("templates.details")} (${t("s.optional")})`} htmlFor="tpl-details">
            <Textarea id="tpl-details" rows={2} value={details} onChange={(e) => setDetails(e.target.value)} />
          </FormField>
          {kind === "choice" && (
            <FormField label={t("templates.options")} error={errors.fields.options}>
              <div className="flex flex-col gap-2">
                {options.map((o, i) => (
                  <div key={i} className="flex items-start gap-1.5">
                    <div className="grid min-w-0 flex-1 gap-1.5 sm:grid-cols-[10rem_1fr]">
                      <Input
                        aria-label={t("templates.optionLabel", { n: i + 1 })}
                        placeholder={t("templates.optionLabel", { n: i + 1 })}
                        value={o.label}
                        onChange={(e) => setOption(i, { label: e.target.value })}
                      />
                      <Input
                        aria-label={t("templates.description")}
                        placeholder={`${t("templates.description")} (${t("s.optional")})`}
                        value={o.description}
                        onChange={(e) => setOption(i, { description: e.target.value })}
                      />
                    </div>
                    <IconButton
                      label={t("templates.optionRemove", { n: i + 1 })}
                      disabled={options.length <= 2}
                      onClick={() => setOptions((list) => list.filter((_, at) => at !== i))}
                      className="mt-0.5"
                    >
                      <X className="size-3.5" />
                    </IconButton>
                  </div>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  className="self-start"
                  onClick={() => setOptions((list) => [...list, { label: "", description: "" }])}
                >
                  <Plus className="size-3" aria-hidden />
                  {t("templates.optionAdd")}
                </Button>
              </div>
            </FormField>
          )}
        </div>
      )}
    </FormDialog>
  );
}
