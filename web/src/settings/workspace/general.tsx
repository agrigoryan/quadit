import { type FormEvent, useState } from "react";
import { Download } from "lucide-react";
import { loadSession } from "@/auth/session";
import { ws } from "@/lib/api";
import { t } from "@/lib/i18n";
import { mutate } from "@/lib/mutate";
import { useMe } from "@/lib/selectors";
import { useStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import type { Workspace } from "@/lib/types";
import { useSettingsBase } from "@/settings/base";
import { download } from "@/settings/ui/bits";
import { FormAlert, FormField, FormFoot, useFieldErrors, useSubmit } from "@/settings/ui/form";
import { Card, Page, Section } from "@/settings/ui/layout";
import { DeleteWorkspaceDialog } from "@/settings/workspace/delete-workspace";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";

/** The workspace's name and icon, a way to take everything out of it, and (for an owner) the way to delete it. */
export function GeneralPage() {
  const base = useSettingsBase();
  const workspace = useStore((s) => s.workspace) as Workspace;
  const slug = useStore((s) => s.slug);
  const [name, setName] = useState(workspace.name);
  const [icon, setIcon] = useState(workspace.icon ?? "");
  const [deleting, setDeleting] = useState(false);
  const owner = useMe().role === "owner";
  const errors = useFieldErrors(["name", "icon"]);
  const { busy, run } = useSubmit(errors);
  const dirty = name.trim() !== workspace.name || icon.trim() !== (workspace.icon ?? "");

  async function save(e: FormEvent) {
    e.preventDefault();
    errors.clear();
    if (!name.trim()) return errors.set("name", t("s.required"));
    await run(async () => {
      await mutate({ type: "workspace.update", args: { name: name.trim(), icon: icon.trim() } }, undefined, {
        quiet: true,
      });
      // The list of workspaces in the switcher comes with the session.
      await loadSession();
      toast.info(t("s.saved"));
    });
  }

  function exportAll() {
    download(ws(slug, "/export"));
    toast.info(t("general.export.started"));
  }

  return (
    <Page title={t("general.title")} lead={t("general.lead")} back={base}>
      <Section>
        <Card>
          <form onSubmit={save} className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-[1fr_9rem]">
              <FormField label={t("general.name")} htmlFor="ws-name" error={errors.fields.name}>
                <Input id="ws-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
              </FormField>
              <FormField label={t("general.icon")} htmlFor="ws-icon" error={errors.fields.icon}>
                <Input
                  id="ws-icon"
                  value={icon}
                  onChange={(e) => setIcon(e.target.value)}
                  maxLength={4}
                  placeholder={name.slice(0, 1).toUpperCase()}
                />
              </FormField>
            </div>
            <p className="-mt-2 text-xs text-ink-3">{t("general.iconHint")}</p>
            <FormField label={t("general.address")} hint={t("general.addressHint")}>
              <code className="rounded-md border border-line bg-sunken px-2.5 py-1.5 font-mono text-xs text-ink-2">{`${location.origin}/${slug}`}</code>
            </FormField>
            <FormAlert>{errors.form}</FormAlert>
            <FormFoot>
              <Button type="submit" variant="primary" disabled={busy || !dirty}>
                {busy ? t("s.saving") : t("common.save")}
              </Button>
            </FormFoot>
          </form>
        </Card>
      </Section>

      <Section title={t("general.export.title")} lead={t("general.export.lead")}>
        <Button onClick={exportAll}>
          <Download className="size-3.5" aria-hidden />
          {t("general.export.button")}
        </Button>
      </Section>

      {owner && (
        <Section title={t("general.danger")}>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/40 bg-surface p-4">
            <div className="min-w-0 max-w-md">
              <p className="text-sm font-medium">{t("general.delete.heading")}</p>
              <p className="text-sm text-ink-2">{t("general.delete.lead")}</p>
            </div>
            <Button variant="danger-quiet" onClick={() => setDeleting(true)}>
              {t("general.delete.button")}
            </Button>
          </div>
        </Section>
      )}
      {deleting && <DeleteWorkspaceDialog workspace={workspace} onClose={() => setDeleting(false)} />}
    </Page>
  );
}
