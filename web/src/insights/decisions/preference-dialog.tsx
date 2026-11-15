// Making a standing preference: a rule in words that holds from now on,
// for one project (optionally only tasks with certain labels) or for the
// whole workspace. It can start from an answered decision, whose question
// and answer become the first draft of the rule.

import { type FormEvent, useId, useState } from "react";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { sendOnModEnter } from "@/lib/mod-enter";
import { mutate, send } from "@/lib/mutate";
import { useLabels, useProjects } from "@/lib/selectors";
import { getState } from "@/lib/store";
import { toast } from "@/lib/toast";
import type { Decision } from "@/lib/types";
import { ProjectGlyph } from "@/ui/project-glyph";
import { LabelChip } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { REFUSAL_IN_TOAST, useSubmit } from "@/ui/form";
import { Field, Textarea } from "@/ui/input";
import { Picker, Select } from "@/ui/picker";
import { prefillRule } from "@/insights/decisions/data";
import type { Preference } from "@/lib/types-plan";

const WORKSPACE = "workspace";

interface NewPreference {
  body: string;
  projectId: string;
  labelIds: string[];
  decisionId?: string;
}

/** Saves a preference; it shows at once. Rejects (the server's message is shown) if refused. */
function createPreference(input: NewPreference): Promise<unknown> {
  const id = newId();
  const args: Record<string, unknown> = { id, body: input.body };
  if (input.decisionId) args.decision = input.decisionId;
  // Labels belong to a project, so a workspace-wide rule carries none.
  if (input.projectId) {
    args.project = input.projectId;
    if (input.labelIds.length) args.labels = input.labelIds;
  }
  return mutate({ type: "preference.create", args }, (tx) =>
    tx.insert("preferences", {
      id,
      body: input.body,
      project_id: input.projectId || undefined,
      decision_id: input.decisionId,
      label_ids: input.projectId && input.labelIds.length ? input.labelIds : undefined,
      created_by: getState().me?.user_id ?? "",
      created_at: Date.now(),
    }),
  );
}

/** Retired: kept on record, no longer given to anyone. */
export function setRetired(pref: Preference, retired: boolean) {
  send({ type: "preference.update", args: { id: pref.id, retired } }, (tx) =>
    tx.patch("preferences", pref.id, { retired_at: retired ? Date.now() : null }),
  );
}

export function deletePreference(pref: Preference) {
  send({ type: "preference.delete", args: { id: pref.id } }, (tx) =>
    tx.patch("preferences", pref.id, { deleted_at: Date.now() }),
  );
}

interface Props {
  /** The answered decision the rule comes from, with its task's project; leave out for a rule of its own. */
  from?: { decision: Decision; projectId: string };
  onClose: () => void;
}

export function PreferenceDialog({ from, onClose }: Props) {
  const projects = useProjects();
  const [body, setBody] = useState(() => (from ? prefillRule(from.decision) : ""));
  const [scope, setScope] = useState(from?.projectId ?? WORKSPACE);
  const [labelIds, setLabelIds] = useState<string[]>([]);
  // Only the empty rule is caught here; a refusal from the server is a toast, and the dialog stays.
  const [error, setError] = useState("");
  const { busy, run } = useSubmit(REFUSAL_IN_TOAST, { once: true });
  const projectId = scope === WORKSPACE ? "" : scope;
  // Only the project's own labels: the server looks a rule's labels up in its project.
  const labels = useLabels(projectId || undefined).filter((l) => l.project_id === projectId);
  const picked = labels.filter((l) => labelIds.includes(l.id));
  const bodyId = useId();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const rule = body.trim();
    if (!rule) {
      setError(t("prefs.bodyRequired"));
      return;
    }
    await run(async () => {
      await createPreference({
        body: rule,
        projectId,
        labelIds: picked.map((l) => l.id),
        decisionId: from?.decision.id,
      });
      toast.info(t("prefs.saved"));
      onClose();
    });
  }

  const scopes = [
    { id: WORKSPACE, label: t("prefs.scope.workspace") },
    ...projects.map((p) => ({ id: p.id, label: p.name, icon: <ProjectGlyph project={p} />, keywords: p.key })),
  ];

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("prefs.dialog.title")}
      description={from ? t("prefs.dialog.fromDecision", { question: from.decision.question }) : t("prefs.hint")}
      footer={
        <>
          <Button variant="ghost" className="max-sm:h-10" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form={`${bodyId}-form`} variant="primary" className="max-sm:h-10" disabled={busy}>
            {t("prefs.save")}
          </Button>
        </>
      }
    >
      <form id={`${bodyId}-form`} onSubmit={submit} className="flex flex-col gap-3">
        <Field label={t("prefs.body")} htmlFor={bodyId}>
          <Textarea
            id={bodyId}
            autoFocus
            autoGrow
            rows={3}
            value={body}
            maxLength={1000}
            placeholder={t("prefs.bodyPlaceholder")}
            aria-invalid={!!error}
            aria-describedby={error ? `${bodyId}-error` : undefined}
            onChange={(e) => {
              setBody(e.target.value);
              setError("");
            }}
            onKeyDown={(e) => sendOnModEnter(e, () => e.currentTarget.form?.requestSubmit())}
            className="max-sm:text-base"
          />
          {error && (
            <p id={`${bodyId}-error`} role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
        </Field>

        <div className="flex flex-wrap gap-x-4 gap-y-3">
          <Field label={t("prefs.scope")}>
            <Select
              value={scope}
              items={scopes}
              label={t("prefs.scope")}
              onPick={(id) => {
                setScope(id);
                setLabelIds([]);
              }}
              buttonProps={{ className: "max-w-64 self-start max-sm:h-10" }}
            />
          </Field>
          {projectId && labels.length > 0 && (
            <Field label={t("prefs.labels")} hint={t("prefs.labels.hint")}>
              <Picker
                multiple
                items={labels.map((l) => ({
                  id: l.id,
                  label: l.name,
                  icon: <span className="size-2 rounded-full" style={{ background: l.color || "var(--ink-3)" }} />,
                }))}
                value={labelIds}
                label={t("prefs.labels")}
                onPick={(id) => setLabelIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))}
              >
                <Button className="h-auto min-h-7 max-w-full flex-wrap justify-start self-start py-1 max-sm:min-h-10">
                  {picked.length === 0 ? (
                    <span className="text-ink-2">{t("prefs.labels.any")}</span>
                  ) : (
                    picked.map((l) => <LabelChip key={l.id} name={l.name} color={l.color} />)
                  )}
                </Button>
              </Picker>
            </Field>
          )}
        </div>
      </form>
    </Dialog>
  );
}
