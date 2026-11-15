// The dialog that creates an epic or edits one: its name, what it is for,
// its state, who leads it and the dates it runs between.

import { type FormEvent, useState } from "react";
import { t } from "@/lib/i18n";
import { useMembers } from "@/lib/selectors";
import type { Epic } from "@/lib/types";
import { createEpic, type EpicFields, updateEpic } from "@/insights/plan/actions";
import { EPIC_STATES, epicStateName } from "@/insights/plan/stats";
import { Avatar } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { REFUSAL_IN_TOAST, useSubmit } from "@/ui/form";
import { Field, Input, Textarea } from "@/ui/input";
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
  const { busy, run } = useSubmit(REFUSAL_IN_TOAST, { once: true });
  const set = (patch: Partial<EpicFields>) => setF((cur) => ({ ...cur, ...patch }));
  const backwards = !!f.startOn && !!f.targetOn && f.targetOn < f.startOn;
  const ok = f.name.trim() !== "" && !backwards;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ok || busy) return;
    if (epic) {
      const args: Parameters<typeof updateEpic>[1] = {};
      if (f.name.trim() !== epic.name) args.name = f.name.trim();
      if (f.description !== (epic.description ?? "")) args.description = f.description;
      if (f.state !== epic.state) args.state = f.state;
      if (f.leadId !== (epic.lead_id ?? "")) args.lead = f.leadId || null;
      if (f.startOn !== (epic.start_on ?? "")) args.start_on = f.startOn || null;
      if (f.targetOn !== (epic.target_on ?? "")) args.target_on = f.targetOn || null;
      updateEpic(epic, args);
      onClose();
      return;
    }
    // A refusal leaves the form open to be fixed.
    await run(async () => {
      const id = await createEpic(projectId, f);
      onClose();
      onCreated?.(id);
    });
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={epic ? t("epic.edit") : t("epic.new")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" form="epic-form" disabled={!ok || busy}>
            {epic ? t("common.save") : t("epics.create")}
          </Button>
        </>
      }
    >
      <form id="epic-form" onSubmit={submit} className="flex flex-col gap-3">
        <Field label={t("epic.name")} htmlFor="epic-name">
          <Input
            id="epic-name"
            value={f.name}
            onChange={(e) => set({ name: e.target.value })}
            maxLength={120}
            placeholder={t("epic.namePlaceholder")}
          />
        </Field>
        <Field label={t("epic.description")} htmlFor="epic-description" hint={t("epic.descriptionHint")}>
          <Textarea
            id="epic-description"
            value={f.description}
            onChange={(e) => set({ description: e.target.value })}
            rows={4}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("epic.state")}>
            <Select
              items={EPIC_STATES.map((s) => ({ id: s, label: epicStateName(s) }))}
              value={f.state}
              onPick={(id) => set({ state: id as Epic["state"] })}
              label={t("epic.state")}
              buttonProps={{ className: "h-8 w-full" }}
            />
          </Field>
          <Field label={t("epic.lead")}>
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
          </Field>
          <Field label={t("epic.start")} htmlFor="epic-start">
            <Input
              id="epic-start"
              type="date"
              value={f.startOn}
              max={f.targetOn || undefined}
              onChange={(e) => set({ startOn: e.target.value })}
              className="tnum"
            />
          </Field>
          <Field label={t("epic.target")} htmlFor="epic-target" hint={backwards ? t("epic.datesBackwards") : undefined}>
            <Input
              id="epic-target"
              type="date"
              value={f.targetOn}
              min={f.startOn || undefined}
              onChange={(e) => set({ targetOn: e.target.value })}
              className="tnum"
            />
          </Field>
        </div>
      </form>
    </Dialog>
  );
}
