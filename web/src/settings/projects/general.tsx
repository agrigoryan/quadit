import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router";
import { errorMessage } from "@/data/api";
import { joinPhrases, t } from "@/lib/i18n";
import { daysFrom } from "@/lib/days";
import { weekdayName } from "@/lib/time";
import { mutate, send } from "@/data/mutate";
import { toast } from "@/lib/toast";
import type { Project, ProjectSettings } from "@/types/core";
import { extendedValues, SCALES, scaleValues, sizeOf } from "@/tasks/estimates";
import { useSettingsBase } from "@/settings/base";
import { KEY_RE, PROJECT_FIELDS, type ProjectDraft, ProjectFields } from "@/settings/projects/project-form";
import { ConfirmDialog } from "@/ui/confirm-dialog";
import { FormAlert, FormField, FormFoot, NativeSelect, SwitchRow, useFieldErrors, useSubmit } from "@/ui/form";
import { Card, Section } from "@/ui/page-layout";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";

/** Weekday names in the person's language; 0 is Sunday, as the server counts. 7 January 2024 was a Sunday. */
const WEEKDAYS = daysFrom("2024-01-07", 7).map((day, i) => ({ value: String(i), label: weekdayName(day, "long") }));
const WEEKS = [1, 2, 3, 4, 6];

/** A scale's values as the settings list them: the numbers, or the sizes "XS", "S"… */
const valueWords = (values: number[], sizes: boolean) => values.map((v) => (sizes && sizeOf(v)) || String(v));

/** How the project estimates: its scale, and the three choices that go with it. */
function EstimateOptions({
  settings,
  disabled,
  onChange,
}: {
  settings: ProjectSettings;
  disabled: boolean;
  onChange: (patch: ProjectSettings) => void;
}) {
  const scale = settings.estimate_scale || "points";
  const sizes = scale === "tshirt";
  return (
    <div className="flex flex-col gap-3 pb-1">
      <FormField label={t("project.estimateScale")} htmlFor="project-estimate-scale" className="max-w-md">
        <NativeSelect
          id="project-estimate-scale"
          value={scale}
          disabled={disabled}
          onChange={(v) => onChange({ estimate_scale: v as typeof scale })}
          options={SCALES.map((name) => ({
            value: name,
            label:
              name === "points"
                ? t("project.scale.points")
                : t("project.scale.withValues", {
                    name: t(`project.scale.${name}`),
                    values: valueWords(scaleValues(name, false), name === "tshirt").join(", "),
                  }),
          }))}
        />
      </FormField>
      {scale !== "points" && (
        <SwitchRow
          title={t("project.estimateExtended")}
          hint={t("project.estimateExtendedHint", { values: joinPhrases(valueWords(extendedValues(scale), sizes)) })}
          checked={!!settings.estimate_extended}
          disabled={disabled}
          onChange={(estimate_extended) => onChange({ estimate_extended })}
        />
      )}
      <SwitchRow
        title={t("project.estimateZero")}
        hint={t("project.estimateZeroHint")}
        checked={!!settings.estimate_zero}
        disabled={disabled}
        onChange={(estimate_zero) => onChange({ estimate_zero })}
      />
      <SwitchRow
        title={t("project.estimateCountUnestimated")}
        hint={t("project.estimateCountUnestimatedHint")}
        checked={!settings.estimate_ignore_unestimated}
        disabled={disabled}
        onChange={(count) => onChange({ estimate_ignore_unestimated: !count })}
      />
    </div>
  );
}

/** A project's name, key and colour, its switches, and archiving or deleting it. */
export function ProjectGeneral({ project, admin }: { project: Project; admin: boolean }) {
  const base = useSettingsBase();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<ProjectDraft>({
    key: project.key,
    name: project.name,
    icon: project.icon ?? "",
    color: project.color ?? "",
    description: project.description ?? "",
  });
  const [ask, setAsk] = useState<"archive" | "delete" | null>(null);
  const [typed, setTyped] = useState("");
  const errors = useFieldErrors(PROJECT_FIELDS);
  const { busy, run } = useSubmit(errors);
  const set = (patch: Partial<ProjectDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const settings: ProjectSettings = project.settings ?? {};

  async function save(e: FormEvent) {
    e.preventDefault();
    errors.clear();
    if (!draft.name.trim()) return errors.set("name", t("s.required"));
    if (!KEY_RE.test(draft.key)) return errors.set("key", t("project.keyBad"));
    await run(async () => {
      await mutate(
        {
          type: "project.update",
          args: {
            id: project.id,
            key: draft.key,
            name: draft.name.trim(),
            icon: draft.icon.trim(),
            color: draft.color,
            description: draft.description.trim(),
          },
        },
        undefined,
        { quiet: true },
      );
      toast.info(t("s.saved"));
      if (draft.key !== project.key) void navigate(`${base}/projects/${draft.key}/general`, { replace: true });
    });
  }

  /** Switches save as they are flipped. */
  function setOption(patch: ProjectSettings) {
    const next = { ...settings, ...patch };
    send({ type: "project.update", args: { id: project.id, settings: next } }, (tx) =>
      tx.patch("projects", project.id, { settings: next }),
    );
  }

  const archive = (archived: boolean) =>
    mutate({ type: "project.update", args: { id: project.id, archived } }, undefined, { quiet: true });

  return (
    <div className="flex flex-col gap-8">
      <Card>
        <form onSubmit={save} className="flex flex-col gap-3.5">
          <ProjectFields draft={draft} set={set} errors={errors} currentKey={project.key} disabled={!admin} />
          <FormAlert>{errors.form}</FormAlert>
          {admin && (
            <FormFoot>
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? t("s.saving") : t("common.save")}
              </Button>
            </FormFoot>
          )}
        </form>
      </Card>

      <Section title={t("project.options")}>
        <Card className="flex flex-col gap-3">
          <SwitchRow
            title={t("project.cycles")}
            hint={t("project.cyclesHint")}
            checked={!!settings.cycles}
            disabled={!admin}
            onChange={(cycles) => setOption({ cycles, cycle_days: settings.cycle_days || 14 })}
          />
          {settings.cycles && (
            <div className="grid max-w-md grid-cols-2 gap-3.5 pb-1">
              <FormField label={t("project.cycleDays")} htmlFor="project-cycle-days">
                <NativeSelect
                  id="project-cycle-days"
                  value={String(Math.max(1, Math.round((settings.cycle_days || 14) / 7)))}
                  disabled={!admin}
                  onChange={(v) => setOption({ cycle_days: Number(v) * 7 })}
                  options={WEEKS.map((n) => ({ value: String(n), label: t("project.cycleWeeks", { n }) }))}
                />
              </FormField>
              <FormField label={t("project.cycleStart")} htmlFor="project-cycle-start">
                <NativeSelect
                  id="project-cycle-start"
                  value={String(settings.cycle_start ?? 0)}
                  disabled={!admin}
                  onChange={(v) => setOption({ cycle_start: Number(v) })}
                  options={WEEKDAYS}
                />
              </FormField>
            </div>
          )}
          <div className="border-t border-line pt-3">
            <SwitchRow
              title={t("project.estimates")}
              hint={t("project.estimatesHint")}
              checked={!!settings.estimates}
              disabled={!admin}
              // Turned on with no scale named, the server names Fibonacci; named here, the scale shows at once.
              onChange={(estimates) =>
                setOption(
                  estimates && !settings.estimate_scale ? { estimates, estimate_scale: "fibonacci" } : { estimates },
                )
              }
            />
          </div>
          {settings.estimates && <EstimateOptions settings={settings} disabled={!admin} onChange={setOption} />}
        </Card>
      </Section>

      {admin && (
        <Section title={`${t("project.archive.title")} · ${t("project.delete.title")}`}>
          <Card className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-md text-sm text-ink-2">{t("project.archive.lead")}</p>
              {project.archived_at ? (
                <Button onClick={() => void archive(false).catch((err: unknown) => toast.error(errorMessage(err)))}>
                  {t("project.unarchive")}
                </Button>
              ) : (
                <Button onClick={() => setAsk("archive")}>{t("project.archive")}</Button>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
              <p className="max-w-md text-sm text-ink-2">{t("project.delete.lead")}</p>
              <Button
                variant="danger-quiet"
                onClick={() => {
                  setTyped("");
                  setAsk("delete");
                }}
              >
                {t("project.delete")}
              </Button>
            </div>
          </Card>
        </Section>
      )}

      <ConfirmDialog
        open={ask === "archive"}
        onOpenChange={(open) => !open && setAsk(null)}
        title={t("project.archive.confirm", { name: project.name })}
        body={t("project.archive.lead")}
        confirm={t("project.archive")}
        safe
        onConfirm={() => archive(true)}
      />
      <ConfirmDialog
        open={ask === "delete"}
        onOpenChange={(open) => !open && setAsk(null)}
        title={t("project.delete.confirm", { name: project.name })}
        body={t("project.delete.lead")}
        confirm={t("project.delete")}
        onConfirm={async () => {
          if (typed.trim().toUpperCase() !== project.key)
            throw new Error(t("project.delete.type", { key: project.key }));
          await mutate({ type: "project.delete", args: { id: project.id } }, undefined, { quiet: true });
          void navigate(`${base}/projects`);
        }}
      >
        <FormField label={t("project.delete.type", { key: project.key })} htmlFor="delete-key">
          <Input
            id="delete-key"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoCapitalize="characters"
            spellCheck={false}
            className="font-mono"
          />
        </FormField>
      </ConfirmDialog>
    </div>
  );
}
