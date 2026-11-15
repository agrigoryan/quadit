import { useState } from "react";
import { MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { t } from "@/lib/i18n";
import { useLookup } from "@/lib/selectors";
import type { Secret } from "@/types/core";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Button, IconButton } from "@/ui/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/ui/menu";
import { Tooltip } from "@/ui/tooltip";
import { useSettingsBase } from "@/settings/base";
import { deleteSecret, useLoadSecrets, useSecrets } from "@/settings/secrets/data";
import { SecretForm } from "@/settings/secrets/secret-form";
import { Fact } from "@/ui/fact";
import { LoadGate } from "@/ui/load-gate";
import { When } from "@/ui/when";
import { ConfirmDialog } from "@/ui/confirm-dialog";
import { CopyField } from "@/ui/reveal-dialog";
import { EmptyRow, Page, Rows, Section } from "@/ui/page-layout";

/** Who may use a secret: everyone, or the few it names. */
function UsedBy({ ids }: { ids: string[] }) {
  const members = useLookup("members");
  if (ids.length === 0) return <>{t("secrets.everyMember")}</>;
  const known = ids.map((id) => members[id]).filter((m) => m !== undefined);
  return (
    <span className="inline-flex items-center gap-1.5 align-middle">
      {known.map((m) => (
        <Tooltip key={m.user_id} label={`${m.name} · @${m.handle}`}>
          {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focusable so the keyboard can show the tooltip with the agent's name */}
          <span className="inline-flex" tabIndex={0}>
            <Avatar member={m} size="sm" />
            <span className="sr-only">@{m.handle}</span>
          </span>
        </Tooltip>
      ))}
      {/* Just one: there is room to say who. */}
      {known.length === 1 && <span aria-hidden>{known[0]?.name}</span>}
    </span>
  );
}

function SecretItem({ secret, onEdit, onDelete }: { secret: Secret; onEdit: () => void; onDelete: () => void }) {
  const hosts = secret.hosts ?? [];
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5">
      <div className="flex items-start gap-3">
        <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-mono text-sm font-medium text-ink">{secret.name}</span>
            {secret.env && (
              <Tooltip label={t("secrets.envBadgeHint")}>
                <Badge tone="wait">{t("secrets.env")}</Badge>
              </Tooltip>
            )}
          </span>
          {secret.description && <span className="block truncate text-xs text-ink-3">{secret.description}</span>}
        </button>
        <Menu>
          <MenuTrigger asChild>
            <IconButton label={t("s.actions")}>
              <MoreHorizontal className="size-4" />
            </IconButton>
          </MenuTrigger>
          <MenuContent align="end">
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
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
        {hosts.length === 0 ? (
          <span className="text-ink-3" title={t("secrets.noHostsHint")}>
            {t("secrets.noHosts")}
          </span>
        ) : (
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            {hosts.map((host) => (
              <span
                key={host}
                className="inline-flex h-5 max-w-full items-center rounded-sm border border-line bg-sunken px-1.5 font-mono text-xs text-ink-2"
              >
                <span className="truncate">{host}</span>
              </span>
            ))}
          </span>
        )}
        <Fact label={t("secrets.for")} className="items-center">
          <UsedBy ids={secret.agents ?? []} />
        </Fact>
        {secret.last_used_at ? (
          <Fact label={t("secrets.lastUsed")}>
            <When ms={secret.last_used_at} />
          </Fact>
        ) : (
          <span className="text-ink-3">{t("secrets.neverUsed")}</span>
        )}
      </div>
    </div>
  );
}

/** The vault: keys agents use through the server and never hold. */
export function SecretsPage() {
  const base = useSettingsBase();
  const loaded = useLoadSecrets();
  const secrets = useSecrets();
  const [form, setForm] = useState<{ secret?: Secret } | null>(null);
  const [removing, setRemoving] = useState<Secret | null>(null);

  return (
    <Page
      title={t("settings.nav.secrets")}
      lead={t("secrets.lead")}
      back={base}
      actions={
        <Button variant="primary" onClick={() => setForm({})}>
          <Plus className="size-4" aria-hidden />
          {t("secrets.new")}
        </Button>
      }
    >
      <LoadGate of={loaded}>
        {() =>
          secrets.length === 0 ? (
            <EmptyRow>{t("secrets.empty")}</EmptyRow>
          ) : (
            <Rows>
              {secrets.map((secret) => (
                <SecretItem
                  key={secret.id}
                  secret={secret}
                  onEdit={() => setForm({ secret })}
                  onDelete={() => setRemoving(secret)}
                />
              ))}
            </Rows>
          )
        }
      </LoadGate>

      <Section title={t("secrets.how")} lead={t("secrets.howLead")}>
        <div className="flex flex-col gap-3">
          <CopyField label={t("secrets.how.request")} value={t("secrets.how.requestCmd")} />
          <CopyField label={t("secrets.how.run")} value={t("secrets.how.runCmd")} />
        </div>
      </Section>

      {form && <SecretForm secret={form.secret} onClose={() => setForm(null)} />}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t("secrets.deleteTitle", { name: removing?.name ?? "" })}
        body={t("secrets.deleteBody")}
        confirm={t("s.delete")}
        onConfirm={async () => {
          if (removing) await deleteSecret(removing.id);
        }}
      />
    </Page>
  );
}
