import { type FormEvent, useMemo, useState } from "react";
import { MoreHorizontal, RotateCcw, Trash2, Archive } from "lucide-react";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { mutate, send } from "@/data/mutate";
import { useLabels, useLookup, useLookupEvenIfGone, useRows } from "@/data/selectors";
import type { Project } from "@/types/core";
import type { Preference } from "@/types/plan";
import { MultiPick } from "@/settings/ui/multi-pick";
import { Dot } from "@/ui/dot";
import { When } from "@/ui/when";
import { ConfirmDialog } from "@/ui/confirm-dialog";
import { FormAlert, FormField, FormFoot, useFieldErrors, useSubmit } from "@/ui/form";
import { Card, EmptyRow, Rows, Section } from "@/ui/page-layout";
import { Badge, LabelChip } from "@/ui/badge";
import { Button, IconButton } from "@/ui/button";
import { Textarea } from "@/ui/input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/ui/menu";

/** The standing preferences of a project: what the team has settled, for agents to read before they work. */
export function ProjectPreferences({ project, admin }: { project: Project; admin: boolean }) {
  const rows = useRows("preferences");
  // Who wrote a preference, one since removed included.
  const members = useLookupEvenIfGone("members");
  const labels = useLookup("labels");
  const [deleting, setDeleting] = useState<Preference | null>(null);

  const { active, retired } = useMemo(() => {
    const mine = rows
      .filter((p) => !p.project_id || p.project_id === project.id)
      .sort((a, b) => b.created_at - a.created_at);
    return { active: mine.filter((p) => !p.retired_at), retired: mine.filter((p) => p.retired_at) };
  }, [rows, project.id]);

  const retire = (p: Preference, on: boolean) =>
    send({ type: "preference.update", args: { id: p.id, retired: on } }, (tx) =>
      tx.patch("preferences", p.id, { retired_at: on ? Date.now() : null }),
    );

  const list = (items: Preference[]) => (
    <Rows>
      {items.map((p) => (
        <div key={p.id} className="flex items-start gap-3 px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <p className={p.retired_at ? "text-sm text-ink-3 line-through" : "text-sm text-ink"}>{p.body}</p>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
              {(p.label_ids ?? []).map(
                (id) => labels[id] && <LabelChip key={id} name={labels[id].name} color={labels[id].color} />,
              )}
              <span>{members[p.created_by]?.name ?? t("common.someone")}</span>
              <When ms={p.created_at} />
              {p.decision_id && <span>· {t("prefs.fromDecision")}</span>}
              {p.retired_at && <Badge>{t("prefs.retired")}</Badge>}
            </p>
          </div>
          {admin && (
            <Menu>
              <MenuTrigger asChild>
                <IconButton label={t("s.actions")}>
                  <MoreHorizontal className="size-4" />
                </IconButton>
              </MenuTrigger>
              <MenuContent align="end">
                {p.retired_at ? (
                  <MenuItem icon={<RotateCcw />} onSelect={() => retire(p, false)}>
                    {t("prefs.restore")}
                  </MenuItem>
                ) : (
                  <MenuItem icon={<Archive />} onSelect={() => retire(p, true)}>
                    {t("prefs.retire")}
                  </MenuItem>
                )}
                <MenuSeparator />
                <MenuItem danger icon={<Trash2 />} onSelect={() => setDeleting(p)}>
                  {t("s.delete")}
                </MenuItem>
              </MenuContent>
            </Menu>
          )}
        </div>
      ))}
    </Rows>
  );

  return (
    <div className="flex flex-col gap-6">
      <p className="max-w-prose text-sm text-ink-2">{t("prefs.lead")}</p>
      {active.length === 0 ? <EmptyRow>{t("prefs.none")}</EmptyRow> : list(active)}
      {admin && <AddPreference project={project} />}
      {retired.length > 0 && <Section title={t("prefs.retiredTitle")}>{list(retired)}</Section>}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("prefs.delete.title")}
        body={t("prefs.delete.body")}
        confirm={t("s.delete")}
        onConfirm={() =>
          deleting
            ? mutate({ type: "preference.delete", args: { id: deleting.id } }, undefined, { quiet: true })
            : undefined
        }
      />
    </div>
  );
}

function AddPreference({ project }: { project: Project }) {
  const labels = useLabels(project.id);
  const [body, setBody] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const errors = useFieldErrors(["body", "labels"]);
  const { busy, run } = useSubmit(errors);

  async function add(e: FormEvent) {
    e.preventDefault();
    errors.clear();
    if (!body.trim()) return errors.set("body", t("s.required"));
    await run(async () => {
      await mutate(
        { type: "preference.create", args: { id: newId(), body: body.trim(), project: project.id, labels: picked } },
        undefined,
        { quiet: true },
      );
      setBody("");
      setPicked([]);
    });
  }

  return (
    <Card>
      <form onSubmit={add} className="flex flex-col gap-3.5">
        <FormField label={t("prefs.body")} htmlFor="pref-body" error={errors.fields.body}>
          <Textarea
            id="pref-body"
            rows={2}
            autoGrow
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t("prefs.bodyPlaceholder")}
          />
        </FormField>
        <FormField label={t("prefs.labels")} error={errors.fields.labels}>
          <MultiPick
            items={labels.map((l) => ({ id: l.id, label: l.name, icon: <Dot color={l.color} /> }))}
            value={picked}
            onChange={setPicked}
            addLabel={t("templates.labelsAdd")}
            empty={t("prefs.labelsAny")}
          />
        </FormField>
        <FormAlert>{errors.form}</FormAlert>
        <FormFoot>
          <Button type="submit" disabled={busy}>
            {t("prefs.add")}
          </Button>
        </FormFoot>
      </form>
    </Card>
  );
}
