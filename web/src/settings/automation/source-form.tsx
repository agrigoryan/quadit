import type { Changes } from "@/types/changes.gen";
import { useState } from "react";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { Input } from "@/ui/input";
import { FormField, NativeSelect, refuse, useFieldErrors } from "@/ui/form";
import { FormDialog } from "@/ui/form-dialog";
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

  async function submit() {
    if (!repo.trim()) refuse("repo", t("auto.src.repoMissing"));
    const args: Changes["source.create" | "source.update"] = {
      id: source?.id ?? newId(),
      repo: repo.trim(),
      branch: branch.trim(),
      subdir: subdir.trim().replace(/^\/+|\/+$/g, ""),
      authority,
      write_mode: writeMode,
    };
    if (!source && title.trim()) args.title = title.trim();
    await change(source ? "source.update" : "source.create", args);
    onSaved();
  }

  return (
    <FormDialog
      title={source ? t("auto.src.edit") : t("auto.src.new")}
      description={source ? undefined : t("auto.src.newLead")}
      submit={source ? t("common.save") : t("auto.src.create")}
      errors={errors}
      onSubmit={submit}
      onClose={onClose}
    >
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
          onChange={(e) => {
            setRepo(e.target.value);
            errors.set("repo", "");
          }}
        />
      </FormField>
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        <FormField
          label={t("auto.src.branch")}
          htmlFor="src-branch"
          error={errors.fields.branch}
          hint={t("auto.src.branchHint")}
        >
          <Input
            id="src-branch"
            spellCheck={false}
            autoCapitalize="off"
            className="font-mono"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
          />
        </FormField>
        <FormField
          label={t("auto.src.subdir")}
          htmlFor="src-subdir"
          error={errors.fields.subdir}
          hint={t("auto.src.subdirHint")}
        >
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
      <FormField
        label={t("auto.src.authority")}
        htmlFor="src-authority"
        error={errors.fields.authority}
        hint={t(`auto.src.authority.${authority}.hint`)}
      >
        <NativeSelect
          id="src-authority"
          value={authority}
          onChange={(v) => setAuthority(v as Authority)}
          options={AUTHORITIES.map((a) => ({ value: a, label: t(`auto.src.authority.${a}`) }))}
        />
      </FormField>
      <FormField
        label={t("auto.src.writeMode")}
        htmlFor="src-write"
        error={errors.fields.write_mode}
        hint={t(`auto.src.write.${writeMode}.hint`)}
      >
        <NativeSelect
          id="src-write"
          value={writeMode}
          onChange={(v) => setWriteMode(v as WriteMode)}
          options={WRITE_MODES.map((w) => ({ value: w, label: t(`auto.src.write.${w}`) }))}
        />
      </FormField>
      {!source && (
        <FormField
          label={t("auto.src.title")}
          htmlFor="src-title"
          error={errors.fields.title ?? errors.fields.root}
          hint={t("auto.src.titleHint")}
        >
          <Input id="src-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </FormField>
      )}
    </FormDialog>
  );
}
