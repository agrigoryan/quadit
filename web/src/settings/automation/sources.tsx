import { useState } from "react";
import { FolderGit2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Link } from "react-router";
import { api, errorMessage, ws } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useCollection, useSlug } from "@/lib/selectors";
import { useStore } from "@/lib/store";
import { Badge } from "@/ui/badge";
import { Button, IconButton } from "@/ui/button";
import { ProjectGlyph } from "@/ui/project-glyph";
import { useSettingsBase } from "@/settings/base";
import { Fact } from "@/ui/fact";
import { LoadGate } from "@/ui/load-gate";
import { When } from "@/ui/when";
import { ConfirmDialog } from "@/ui/settings-dialogs";
import { EmptyRow, Page, Rows } from "@/ui/settings-layout";
import { useLoad } from "@/lib/use-load";
import { change, listSources, type Source, type SyncResult } from "@/settings/automation/data";
import { SourceForm } from "@/settings/automation/source-form";
import { SyncLine, type SyncState } from "@/settings/automation/sync-line";

/** "docs" for ".../owner/docs.git": what to call a source whose root page is not in view. */
const repoName = (repo: string) =>
  repo
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split(/[/:]/)
    .pop() || repo;

function syncText(r: SyncResult): string {
  const parts = [
    t("auto.src.result.created", { n: r.pages_created }),
    t("auto.src.result.updated", { n: r.pages_updated }),
    t("auto.src.result.trashed", { n: r.pages_trashed }),
    t("auto.src.result.written", { n: r.files_written }),
  ];
  let text = t("auto.src.result", { commit: (r.commit || "").slice(0, 8) || "–", parts: parts.join(", ") });
  if (r.pushed) text += ` ${t("auto.src.result.pushed", { branch: r.pushed })}`;
  if (r.note) text += ` ${r.note.charAt(0).toUpperCase()}${r.note.slice(1)}.`;
  return text;
}

interface ItemProps {
  src: Source;
  sync: SyncState | undefined;
  onSync: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function SourceItem({ src, sync, onSync, onEdit, onDelete }: ItemProps) {
  const slug = useSlug();
  const docs = useCollection("docs");
  const root = docs[src.root_doc_id] as { title?: string; project_id?: string } | undefined;
  const project = useStore((s) => (root?.project_id ? s.c.projects[root.project_id] : undefined));
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <FolderGit2 className="size-4 shrink-0 text-ink-3" aria-hidden />
        <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left">
          <span className="block truncate text-sm font-medium text-ink">{root?.title || repoName(src.repo)}</span>
          <span className="block truncate font-mono text-xs text-ink-3">
            {src.repo}
            {src.branch && ` @ ${src.branch}`}
            {src.subdir && ` / ${src.subdir}`}
          </span>
        </button>
        <Button size="sm" onClick={onSync} disabled={sync?.busy}>
          <RefreshCw className="size-3" aria-hidden />
          {t("auto.syncNow")}
        </Button>
        <span className="flex shrink-0 items-center gap-0.5">
          <IconButton label={t("common.edit")} onClick={onEdit}>
            <Pencil className="size-3.5" />
          </IconButton>
          <IconButton label={t("s.delete")} onClick={onDelete}>
            <Trash2 className="size-3.5" />
          </IconButton>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-7 text-xs">
        <Badge>{t(`auto.src.authority.${src.authority}.short`)}</Badge>
        <Badge>{t(`auto.src.write.${src.write_mode}.short`)}</Badge>
        <Fact label={t("auto.lastSync")}>
          <When ms={src.last_sync_at} />
        </Fact>
        {src.last_commit && (
          <Fact label={t("auto.src.commit")}>
            <span className="font-mono">{src.last_commit.slice(0, 8)}</span>
          </Fact>
        )}
        {root && (
          <Fact label={t("auto.src.project")}>
            <span className="inline-flex items-center gap-1 align-bottom" title={t("auto.src.projectHint")}>
              {project && <ProjectGlyph project={project} />}
              {project ? project.name : t("auto.src.noProject")}
            </span>
          </Fact>
        )}
        <Link to={`/${slug}/docs/${src.root_doc_id}`} className="text-accent-text underline-offset-2 hover:underline">
          {t("auto.src.openPages")}
        </Link>
      </div>
      {(sync || src.last_error) && (
        <div className="pl-7">
          {sync ? (
            <SyncLine state={sync} />
          ) : (
            <SyncLine state={{ busy: false, ok: false, text: t("auto.lastError", { error: src.last_error ?? "" }) }} />
          )}
        </div>
      )}
    </div>
  );
}

/** Repository sources: folders of Markdown in git, mirrored as pages. */
export function SourcesPage() {
  const slug = useSlug();
  const base = useSettingsBase();
  const list = useLoad(() => listSources(slug), [slug]);
  const [form, setForm] = useState<{ src?: Source } | null>(null);
  const [removing, setRemoving] = useState<Source | null>(null);
  const [syncs, setSyncs] = useState<Record<string, SyncState>>({});

  async function sync(src: Source) {
    setSyncs((s) => ({ ...s, [src.id]: { busy: true } }));
    try {
      const out = await api.post<SyncResult>(ws(slug, `/sources/${src.id}/sync`));
      setSyncs((s) => ({ ...s, [src.id]: { busy: false, ok: true, text: syncText(out) } }));
    } catch (err) {
      setSyncs((s) => ({ ...s, [src.id]: { busy: false, ok: false, text: errorMessage(err) } }));
    }
    await list.reload();
  }

  return (
    <Page
      title={t("settings.nav.sources")}
      lead={t("auto.src.lead")}
      back={base}
      actions={
        <Button variant="primary" onClick={() => setForm({})}>
          <Plus className="size-4" aria-hidden />
          {t("auto.src.new")}
        </Button>
      }
    >
      <LoadGate of={list}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyRow>{t("auto.src.empty")}</EmptyRow>
          ) : (
            <Rows>
              {rows.map((src) => (
                <SourceItem
                  key={src.id}
                  src={src}
                  sync={syncs[src.id]}
                  onSync={() => void sync(src)}
                  onEdit={() => setForm({ src })}
                  onDelete={() => setRemoving(src)}
                />
              ))}
            </Rows>
          )
        }
      </LoadGate>

      {form && (
        <SourceForm
          source={form.src}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            void list.reload();
          }}
        />
      )}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t("auto.src.deleteTitle", { name: removing ? repoName(removing.repo) : "" })}
        body={t("auto.src.deleteBody")}
        confirm={t("auto.src.deleteConfirm")}
        onConfirm={async () => {
          if (removing) await change("source.delete", { id: removing.id });
          await list.reload();
        }}
      />
    </Page>
  );
}
