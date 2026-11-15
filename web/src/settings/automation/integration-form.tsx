import type { Changes } from "@/lib/changes.gen";
import { type FormEvent, useState } from "react";
import { t, tMaybe } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { useProjects } from "@/lib/selectors";
import { CATEGORIES } from "@/lib/types";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Input } from "@/ui/input";
import { FormAlert, FormField, NativeSelect, SwitchRow, useFieldErrors, useSubmit } from "@/ui/form";
import { change } from "@/settings/automation/data";
import type { GitHubConfig, Integration } from "@/lib/types-automation";

interface Props {
  /** The integration to edit; none to connect a repository. */
  integration?: Integration;
  onClose: () => void;
  onSaved: () => void;
}

export function IntegrationForm({ integration: it, onClose, onSaved }: Props) {
  const projects = useProjects();
  const cfg = it?.config ?? {};
  const [name, setName] = useState(it?.name ?? "");
  const [repo, setRepo] = useState(cfg.repo ?? "");
  const [apiUrl, setApiUrl] = useState(cfg.api_url ?? "");
  const [token, setToken] = useState("");
  const [projectId, setProjectId] = useState(it?.project_id ?? "");
  const [onOpen, setOnOpen] = useState<string>(cfg.on_open ?? "");
  const [onMerge, setOnMerge] = useState<string>(cfg.on_merge ?? "");
  const [commentBack, setCommentBack] = useState(cfg.comment_back ?? false);
  const [issuesLabel, setIssuesLabel] = useState(cfg.issues_label ?? "");
  const [issuesProject, setIssuesProject] = useState(cfg.issues_project ?? "");
  const [active, setActive] = useState(it?.active ?? true);
  const errors = useFieldErrors(["name", "project", "repo", "secret", "config", "kind", "issues_project"]);
  const { busy, run } = useSubmit(errors);
  // Tasks made from issues need a project: the one chosen for them, or the one the integration is limited to.
  const issueProjectKey = issuesProject || projects.find((p) => p.id === projectId)?.key || "";

  async function submit(e: FormEvent) {
    e.preventDefault();
    errors.clear();
    const cleanRepo = repo
      .trim()
      .replace(/^https?:\/\/github\.com\//i, "")
      .replace(/\.git$/, "")
      .replace(/\/+$/, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(cleanRepo)) return errors.set("repo", t("auto.gh.repoInvalid"));
    if (apiUrl.trim() && !/^https?:\/\/\S+$/i.test(apiUrl.trim()))
      return errors.set("config", t("auto.hook.urlInvalid"));

    const config: GitHubConfig = { repo: cleanRepo };
    if (apiUrl.trim()) config.api_url = apiUrl.trim();
    if (onOpen) config.on_open = onOpen as GitHubConfig["on_open"];
    if (onMerge) config.on_merge = onMerge as GitHubConfig["on_merge"];
    if (commentBack) config.comment_back = true;
    if (issuesLabel.trim()) {
      if (!issueProjectKey) return errors.set("issues_project", t("auto.gh.issuesProjectNeeded"));
      config.issues_label = issuesLabel.trim();
      if (issuesProject) config.issues_project = issuesProject;
    }
    const args: Changes["integration.create" | "integration.update"] = {
      id: it?.id ?? newId(),
      kind: "github",
      name: name.trim() || cleanRepo,
      project: projectId,
      config,
      active,
    };
    // The token never comes back; an empty field keeps the one that is stored.
    if (token.trim()) args.secret = token.trim();

    await run(async () => {
      await change(it ? "integration.update" : "integration.create", args);
      onSaved();
    });
  }

  const categories = [
    { value: "", label: t("auto.gh.leaveAlone") },
    ...CATEGORIES.map((c) => ({ value: c, label: tMaybe(`category.${c}`) })),
  ];

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={it ? t("auto.gh.edit") : t("auto.gh.new")}
      description={it ? undefined : t("auto.gh.newLead")}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" type="submit" form="integration-form" disabled={busy}>
            {it ? t("common.save") : t("auto.gh.create")}
          </Button>
        </>
      }
    >
      <form id="integration-form" onSubmit={submit} className="flex flex-col gap-3.5" noValidate>
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          <FormField
            label={t("auto.gh.repo")}
            htmlFor="gh-repo"
            error={errors.fields.repo}
            hint={t("auto.gh.repoHint")}
          >
            <Input
              id="gh-repo"
              autoFocus
              required
              placeholder="owner/name"
              spellCheck={false}
              autoCapitalize="off"
              className="font-mono"
              value={repo}
              onChange={(e) => {
                setRepo(e.target.value);
                errors.set("repo", "");
              }}
            />
          </FormField>
          <FormField label={t("s.name")} htmlFor="gh-name" error={errors.fields.name} hint={t("auto.gh.nameHint")}>
            <Input id="gh-name" value={name} onChange={(e) => setName(e.target.value)} />
          </FormField>
        </div>
        <FormField
          label={t("auto.gh.token")}
          htmlFor="gh-token"
          error={errors.fields.secret}
          hint={it?.has_secret ? t("auto.gh.tokenKept") : t("auto.gh.tokenHint")}
        >
          <Input
            id="gh-token"
            type="password"
            autoComplete="off"
            placeholder={it?.has_secret ? "••••••••••••" : "github_pat_…"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </FormField>
        <FormField
          label={t("auto.project")}
          htmlFor="gh-project"
          error={errors.fields.project}
          hint={t("auto.gh.projectHint")}
        >
          <NativeSelect
            id="gh-project"
            value={projectId}
            onChange={setProjectId}
            options={[
              { value: "", label: t("s.everyProject") },
              ...projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` })),
            ]}
          />
        </FormField>
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          <FormField label={t("auto.gh.onOpen")} htmlFor="gh-open" hint={t("auto.gh.onOpenHint")}>
            <NativeSelect id="gh-open" value={onOpen} onChange={setOnOpen} options={categories} />
          </FormField>
          <FormField label={t("auto.gh.onMerge")} htmlFor="gh-merge" hint={t("auto.gh.onMergeHint")}>
            <NativeSelect id="gh-merge" value={onMerge} onChange={setOnMerge} options={categories} />
          </FormField>
        </div>
        <SwitchRow
          title={t("auto.gh.commentBack")}
          hint={t("auto.gh.commentBackHint")}
          checked={commentBack}
          onChange={setCommentBack}
        />
        <div className="border-t border-line pt-3.5">
          <p className="text-sm font-medium text-ink">{t("auto.gh.issues")}</p>
          <p className="mb-2.5 text-xs text-ink-3">{t("auto.gh.issuesLead")}</p>
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <FormField label={t("auto.gh.issuesLabel")} htmlFor="gh-issues-label" hint={t("auto.gh.issuesLabelHint")}>
              <Input
                id="gh-issues-label"
                spellCheck={false}
                autoCapitalize="off"
                placeholder="quadit"
                value={issuesLabel}
                onChange={(e) => setIssuesLabel(e.target.value)}
              />
            </FormField>
            <FormField
              label={t("auto.gh.issuesProject")}
              htmlFor="gh-issues-project"
              error={errors.fields.issues_project}
              hint={t("auto.gh.issuesProjectHint")}
            >
              <NativeSelect
                id="gh-issues-project"
                value={issuesProject}
                onChange={(v) => {
                  setIssuesProject(v);
                  errors.set("issues_project", "");
                }}
                disabled={!issuesLabel.trim()}
                options={[
                  { value: "", label: t("auto.gh.issuesProjectSame") },
                  ...projects.map((p) => ({ value: p.key, label: `${p.key} · ${p.name}` })),
                  // A key saved earlier whose project is gone from the list: still show what is stored.
                  ...(issuesProject && !projects.some((p) => p.key === issuesProject)
                    ? [{ value: issuesProject, label: issuesProject }]
                    : []),
                ]}
              />
            </FormField>
          </div>
        </div>
        <FormField
          label={t("auto.gh.apiUrl")}
          htmlFor="gh-api"
          error={errors.fields.config}
          hint={t("auto.gh.apiUrlHint")}
        >
          <Input
            id="gh-api"
            type="url"
            placeholder="https://api.github.com"
            value={apiUrl}
            onChange={(e) => setApiUrl(e.target.value)}
          />
        </FormField>
        <SwitchRow title={t("auto.active")} hint={t("auto.gh.activeHint")} checked={active} onChange={setActive} />
        <FormAlert>{errors.form}</FormAlert>
      </form>
    </Dialog>
  );
}
