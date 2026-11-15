import { type FormEvent, useState } from "react";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Input } from "@/ui/input";
import { FormAlert, FormField, NativeSelect, useFieldErrors, useSubmit } from "@/settings/ui/form";
import { type Authority, change, type Source, type WriteMode } from "@/settings/automation/data";

interface Props {
  /** The source to edit; none to add a repository. */
  source?: Source;
  onClose: () => void;
  onSaved: () => void;
}

const AUTHORITIES: Authority[] = ["repo", "pages"];
const WRITE_MODES: WriteMode[] = ["commit", "propose", "none"];

export function SourceForm({ source, onClose, onSaved }: Props) {
  const [repo, setRepo] = useState(source?.repo ?? "");
  const [branch, setBranch] = useState(source?.branch ?? "");
  const [subdir, setSubdir] = useState(source?.subdir ?? "");
  const [authority, setAuthority] = useState<Authority>(source?.authority ?? "repo");
  const [writeMode, setWriteMode] = useState<WriteMode>(source?.write_mode ?? "commit");
  const [title, setTitle] = useState("");
  const errors = useFieldErrors(["repo", "branch", "subdir", "authority", "write_mode", "title", "root"]);
  const { busy, run } = useSubmit(errors);

  async function submit(e: FormEvent) {
    e.preventDefault();
    errors.clear();
    if (!repo.trim()) return errors.set("repo", t("auto.src.repoMissing"));
    const args: Record<string, unknown> = {
      id: source?.id ?? newId(),
      repo: repo.trim(),
      branch: branch.trim(),
      subdir: subdir.trim().replace(/^\/+|\/+$/g, ""),
      authority,
      write_mode: writeMode,
    };
    if (!source && title.trim()) args.title = title.trim();
    await run(async () => {
      await change(source ? "source.update" : "source.create", args);
      onSaved();
    });
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={source ? t("auto.src.edit") : t("auto.src.new")}
      description={source ? undefined : t("auto.src.newLead")}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" type="submit" form="source-form" disabled={busy}>
            {source ? t("common.save") : t("auto.src.create")}
          </Button>
        </>
      }
    >
      <form id="source-form" onSubmit={submit} className="flex flex-col gap-3.5" noValidate>
        <FormField label={t("auto.src.repo")} htmlFor="src-repo" error={errors.fields.repo} hint={t("auto.src.repoHint")}>
          <Input
            id="src-repo"
            autoFocus
            required
            spellCheck={false}
            autoCapitalize="off"
            className="font-mono"
            placeholder="https://github.com/owner/docs.git"
            value={repo}
            onChange={(e) => (setRepo(e.target.value), errors.set("repo", ""))}
          />
        </FormField>
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          <FormField label={t("auto.src.branch")} htmlFor="src-branch" error={errors.fields.branch} hint={t("auto.src.branchHint")}>
            <Input id="src-branch" spellCheck={false} autoCapitalize="off" className="font-mono" value={branch} onChange={(e) => setBranch(e.target.value)} />
          </FormField>
          <FormField label={t("auto.src.subdir")} htmlFor="src-subdir" error={errors.fields.subdir} hint={t("auto.src.subdirHint")}>
            <Input
              id="src-subdir"
              spellCheck={false}
              autoCapitalize="off"
              className="font-mono"
              placeholder="docs"
              value={subdir}
              onChange={(e) => setSubdir(e.target.value)}
            />
          </FormField>
        </div>
        <FormField label={t("auto.src.authority")} htmlFor="src-authority" error={errors.fields.authority} hint={t(`auto.src.authority.${authority}.hint`)}>
          <NativeSelect
            id="src-authority"
            value={authority}
            onChange={(v) => setAuthority(v as Authority)}
            options={AUTHORITIES.map((a) => ({ value: a, label: t(`auto.src.authority.${a}`) }))}
          />
        </FormField>
        <FormField label={t("auto.src.writeMode")} htmlFor="src-write" error={errors.fields.write_mode} hint={t(`auto.src.write.${writeMode}.hint`)}>
          <NativeSelect
            id="src-write"
            value={writeMode}
            onChange={(v) => setWriteMode(v as WriteMode)}
            options={WRITE_MODES.map((w) => ({ value: w, label: t(`auto.src.write.${w}`) }))}
          />
        </FormField>
        {!source && (
          <FormField label={t("auto.src.title")} htmlFor="src-title" error={errors.fields.title ?? errors.fields.root} hint={t("auto.src.titleHint")}>
            <Input id="src-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </FormField>
        )}
        <FormAlert>{errors.form}</FormAlert>
      </form>
    </Dialog>
  );
}
