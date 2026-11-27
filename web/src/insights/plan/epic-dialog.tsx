// The dialog that creates an epic or edits one: its name, what it is for,
// its state, who leads it and the dates it runs between.

import { useState } from "react";
import { t } from "@/lib/i18n";
import { useMembers } from "@/data/selectors";
import type { Epic } from "@/types/core";
import { createEpic, type EpicFields, updateEpic } from "@/insights/plan/actions";
import { EPIC_STATES, epicStateName } from "@/insights/plan/stats";
import { Avatar } from "@/ui/avatar";
import { FormField, useFieldErrors } from "@/ui/form";
import { FormDialog } from "@/ui/form-dialog";
import { DateField } from "@/ui/date-picker";
import { Input, Textarea } from "@/ui/input";
import { Select } from "@/ui/picker";

const NOBODY = "none";

interface Props {
  projectId: string;
  /** The epic to edit; leave out to create one. */
  epic?: Epic;
  onClose: () => void;
  onCreated?: (id: string) => void;
}

export function EpicDialog({ projectId, epic, onClose, onCreated }: Props) {
  const members = useMembers();
  const [f, setF] = useState<EpicFields>({
    name: epic?.name ?? "",
    description: epic?.description ?? "",
    state: epic?.state ?? "planned",
    leadId: epic?.lead_id ?? "",
    startOn: epic?.start_on ?? "",
    targetOn: epic?.target_on ?? "",
  });
  const errors = useFieldErrors(["name"]);
  const set = (patch: Partial<EpicFields>) => setF((cur) => ({ ...cur, ...patch }));
  const backwards = !!f.startOn && !!f.targetOn && f.targetOn < f.startOn;
  const ok = f.name.trim() !== "" && !backwards;
  // Each of the two dates' months shows the days the epic runs between.
  const span = f.startOn && f.targetOn && !backwards ? { from: f.startOn, to: f.targetOn } : undefined;

  async function submit() {
    if (epic) {
      const args: Parameters<typeof updateEpic>[1] = {};
      if (f.name.trim() !== epic.name) args.name = f.name.trim();
      if (f.description !== (epic.description ?? "")) args.description = f.description;
      if (f.state !== epic.state) args.state = f.state;
      if (f.leadId !== (epic.lead_id ?? "")) args.lead = f.leadId || null;
      if (f.startOn !== (epic.start_on ?? "")) args.start_on = f.startOn || null;
      if (f.targetOn !== (epic.target_on ?? "")) args.target_on = f.targetOn || null;
      // Shown at once; a refusal is a toast and puts it back.
      updateEpic(epic, args);
      return;
    }
    // Made whether or not anyone asks for its id: an optional call would leave out its argument.
    const id = await createEpic(projectId, f);
    onCreated?.(id);
  }

  return (
    <FormDialog
      title={epic ? t("epic.edit") : t("epic.new")}
      submit={epic ? t("common.save") : t("epics.create")}
      ready={ok}
      errors={errors}
      onSubmit={submit}
      onClose={onClose}
    >
      <FormField label={t("epic.name")} htmlFor="epic-name" error={errors.fields.name}>
        <Input
          id="epic-name"
          value={f.name}
          onChange={(e) => set({ name: e.target.value })}
          maxLength={120}
          placeholder={t("epic.namePlaceholder")}
        />
      </FormField>
      <FormField label={t("epic.description")} htmlFor="epic-description" hint={t("epic.descriptionHint")}>
        <Textarea
          id="epic-description"
          value={f.description}
          onChange={(e) => set({ description: e.target.value })}
          rows={4}
        />
      </FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label={t("epic.state")}>
          <Select
            items={EPIC_STATES.map((s) => ({ id: s, label: epicStateName(s) }))}
            value={f.state}
            onPick={(id) => set({ state: id as Epic["state"] })}
            label={t("epic.state")}
            buttonProps={{ className: "h-8 w-full" }}
          />
        </FormField>
        <FormField label={t("epic.lead")}>
          <Select
            items={[
              { id: NOBODY, label: t("epic.noLead"), icon: <Avatar member={undefined} size="xs" /> },
              ...members.map((m) => ({
                id: m.user_id,
                label: m.name,
                icon: <Avatar member={m} size="xs" />,
                keywords: m.handle,
              })),
            ]}
            value={f.leadId || NOBODY}
            onPick={(id) => set({ leadId: id === NOBODY ? "" : id })}
            label={t("epic.lead")}
            buttonProps={{ className: "h-8 w-full" }}
          />
        </FormField>
        <FormField label={t("epic.start")} htmlFor="epic-start">
          <DateField
            id="epic-start"
            label={t("epic.start")}
            value={f.startOn || undefined}
            max={f.targetOn || undefined}
            stretch={span}
            clearable
            onChange={(day) => set({ startOn: day ?? "" })}
            className="h-8 w-full"
          />
        </FormField>
        <FormField
          label={t("epic.target")}
          htmlFor="epic-target"
          hint={backwards ? t("epic.datesBackwards") : undefined}
        >
          <DateField
            id="epic-target"
            label={t("epic.target")}
            value={f.targetOn || undefined}
            min={f.startOn || undefined}
            stretch={span}
            clearable
            onChange={(day) => set({ targetOn: day ?? "" })}
            className="h-8 w-full"
          />
        </FormField>
      </div>
    </FormDialog>
  );
}
