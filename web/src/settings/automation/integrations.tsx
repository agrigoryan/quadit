import { useState } from "react";
import { GitPullRequest, MoreHorizontal, Pencil, Plus, RefreshCw, Trash2, Webhook as WebhookIcon } from "lucide-react";
import { api, errorMessage, workspacePath } from "@/lib/api";
import { cx } from "@/lib/cx";
import { t, tMaybe } from "@/lib/i18n";
import { useCollection, useSlug } from "@/lib/selectors";
import { toast } from "@/lib/toast";
import { Badge } from "@/ui/badge";
import { Button, IconButton } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/ui/menu";
import { useSettingsBase } from "@/settings/base";
import { Fact } from "@/ui/fact";
import { LoadGate } from "@/ui/load-gate";
import { When } from "@/ui/when";
import { ConfirmDialog, CopyField } from "@/ui/settings-dialogs";
import { Note, Switch } from "@/ui/form";
import { EmptyRow, Page, Rows } from "@/ui/settings-layout";
import { useLoad } from "@/lib/use-load";
import { change, type HookInfo, type Integration, listRows } from "@/settings/automation/data";
import { IntegrationForm } from "@/settings/automation/integration-form";
import { SyncLine, type SyncState } from "@/settings/automation/sync-line";

/** The address and secret to paste into the repository's webhook settings on GitHub. */
function HookDialog({ integration, onClose }: { integration: Integration; onClose: () => void }) {
  const slug = useSlug();
  const info = useLoad(
    () => api.get<HookInfo>(workspacePath(slug, `/integrations/${integration.id}/webhook`)),
    [slug, integration.id],
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("auto.gh.hookTitle")}
      description={t("auto.gh.hookLead", { repo: integration.config?.repo ?? "" })}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t("s.done")}
        </Button>
      }
    >
      <LoadGate of={info}>
        {(hook) => (
          <div className="flex flex-col gap-3.5">
            <CopyField label={t("auto.gh.hookUrl")} value={hook.url} />
            <CopyField label={t("auto.gh.hookContentType")} value={hook.content_type} />
            <CopyField label={t("auto.gh.hookSecret")} value={hook.secret} />
            <CopyField label={t("auto.gh.hookEvents")} value={hook.events.join(", ")} />
            <Note>{t("auto.gh.hookNote")}</Note>
          </div>
        )}
      </LoadGate>
    </Dialog>
  );
}

interface ItemProps {
  it: Integration;
  sync: SyncState | undefined;
  onSync: () => void;
  onToggle: (active: boolean) => void;
  onEdit: () => void;
  onHook: () => void;
  onDelete: () => void;
}

function IntegrationItem({ it, sync, onSync, onToggle, onEdit, onHook, onDelete }: ItemProps) {
  const projects = useCollection("projects");
  const project = it.project_id ? projects[it.project_id] : undefined;
  const cfg = it.config ?? {};
  const name = it.name || cfg.repo || t("auto.gh.unnamed");
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <Switch checked={it.active} onChange={onToggle} label={t("auto.gh.activeFor", { name })} />
        <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left">
          <span className={cx("block truncate text-sm font-medium", it.active ? "text-ink" : "text-ink-3")}>
            {name}
          </span>
          {cfg.repo !== name && (
            <span className="flex min-w-0 items-center gap-1 font-mono text-xs text-ink-3">
              <GitPullRequest className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{cfg.repo}</span>
            </span>
          )}
        </button>
        <Button size="sm" onClick={onSync} disabled={sync?.busy}>
          <RefreshCw className="size-3" aria-hidden />
          {t("auto.syncNow")}
        </Button>
        <Menu>
          <MenuTrigger asChild>
            <IconButton label={t("s.actions")}>
              <MoreHorizontal className="size-4" />
            </IconButton>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem icon={<WebhookIcon />} onSelect={onHook}>
              {t("auto.gh.hookTitle")}
            </MenuItem>
            <MenuItem icon={<Pencil />} onSelect={onEdit}>
              {t("common.edit")}
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Trash2 />} danger onSelect={onDelete}>
              {t("s.delete")}
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-11 text-xs">
        <Badge>{project ? project.key : t("s.everyProject")}</Badge>
        {!it.has_secret && <Badge tone="wait">{t("auto.gh.noToken")}</Badge>}
        {cfg.on_open && <Fact label={t("auto.gh.onOpenShort")}>{tMaybe(`category.${cfg.on_open}`)}</Fact>}
        {cfg.on_merge && <Fact label={t("auto.gh.onMergeShort")}>{tMaybe(`category.${cfg.on_merge}`)}</Fact>}
        {cfg.comment_back && <span className="text-ink-2">{t("auto.gh.commentsBack")}</span>}
        {cfg.issues_label && (
          <Fact label={t("auto.gh.issuesShort")}>
            {cfg.issues_label === "*" ? t("auto.gh.issuesEvery") : cfg.issues_label}
            {cfg.issues_project ? ` → ${cfg.issues_project}` : ""}
          </Fact>
        )}
        <Fact label={t("auto.lastSync")}>
          <When ms={it.last_sync_at} />
        </Fact>
      </div>
      {(sync || it.last_error) && (
        <div className="pl-11">
          {sync ? (
            <SyncLine state={sync} />
          ) : (
            <SyncLine state={{ busy: false, ok: false, text: t("auto.lastError", { error: it.last_error ?? "" }) }} />
          )}
        </div>
      )}
    </div>
  );
}

/** Integrations: for now GitHub, which links pull requests to the tasks they name. */
export function IntegrationsPage() {
  const slug = useSlug();
  const base = useSettingsBase();
  const list = useLoad(() => listRows<Integration>(slug, "integrations"), [slug]);
  const [form, setForm] = useState<{ it?: Integration } | null>(null);
  const [hookFor, setHookFor] = useState<Integration | null>(null);
  const [removing, setRemoving] = useState<Integration | null>(null);
  const [syncs, setSyncs] = useState<Record<string, SyncState>>({});

  async function sync(it: Integration) {
    setSyncs((s) => ({ ...s, [it.id]: { busy: true } }));
    try {
      const out = await api.post<{ pull_requests: number }>(workspacePath(slug, `/integrations/${it.id}/sync`));
      setSyncs((s) => ({
        ...s,
        [it.id]: { busy: false, ok: true, text: t("auto.gh.synced", { n: out.pull_requests }) },
      }));
    } catch (err) {
      setSyncs((s) => ({ ...s, [it.id]: { busy: false, ok: false, text: errorMessage(err) } }));
    }
    await list.reload();
  }

  async function toggle(it: Integration, active: boolean) {
    list.set((rows) => rows?.map((r) => (r.id === it.id ? { ...r, active } : r)));
    try {
      await change("integration.update", { id: it.id, kind: it.kind, active });
    } catch (err) {
      toast.error(errorMessage(err));
    }
    await list.reload();
  }

  return (
    <Page
      title={t("settings.nav.integrations")}
      lead={t("auto.gh.lead")}
      back={base}
      actions={
        <Button variant="primary" onClick={() => setForm({})}>
          <Plus className="size-4" aria-hidden />
          {t("auto.gh.new")}
        </Button>
      }
    >
      <LoadGate of={list}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyRow>{t("auto.gh.empty")}</EmptyRow>
          ) : (
            <Rows>
              {rows.map((it) => (
                <IntegrationItem
                  key={it.id}
                  it={it}
                  sync={syncs[it.id]}
                  onSync={() => void sync(it)}
                  onToggle={(active) => void toggle(it, active)}
                  onEdit={() => setForm({ it })}
                  onHook={() => setHookFor(it)}
                  onDelete={() => setRemoving(it)}
                />
              ))}
            </Rows>
          )
        }
      </LoadGate>

      {form && (
        <IntegrationForm
          integration={form.it}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            void list.reload();
          }}
        />
      )}
      {hookFor && <HookDialog integration={hookFor} onClose={() => setHookFor(null)} />}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t("auto.gh.deleteTitle", { name: removing?.name || removing?.config?.repo || "" })}
        body={t("auto.gh.deleteBody")}
        confirm={t("s.delete")}
        onConfirm={async () => {
          if (removing) await change("integration.delete", { id: removing.id });
          await list.reload();
        }}
      />
    </Page>
  );
}
