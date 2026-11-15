import { useState } from "react";
import { KeyRound, Plus } from "lucide-react";
import { api, ws } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useCollection, useMe, useProjects, useSlug } from "@/lib/selectors";
import { useSettingsBase } from "@/settings/base";
import { Fact } from "@/ui/fact";
import { LoadGate } from "@/ui/load-gate";
import { When } from "@/ui/when";
import { ConfirmDialog, RevealDialog } from "@/ui/settings-dialogs";
import { Checkbox, FormField, NativeSelect } from "@/ui/form";
import { EmptyRow, Page, Row, Rows } from "@/ui/settings-layout";
import { type CreatedToken, CreateTokenDialog, ScopeBadges, type TokenFieldsProps } from "@/settings/ui/tokens";
import { useLoad } from "@/lib/use-load";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";

interface Token {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  /** Space-separated: "read" and "project:<id>" entries. Empty means everything the member may do. */
  scopes?: string;
  kind: string;
  created_at: number;
  expires_at?: number;
  last_used_at?: number;
}

const day = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const expiryChoices = ["0", "30", "90", "365"] as const;

/** The fields of a token of one's own: its name beside when it expires, then what it may do and where. */
function MyTokenFields({
  name,
  setName,
  readOnly,
  setReadOnly,
  projects: keys,
  setProjects: setKeys,
  days,
  setDays,
  errors,
}: TokenFieldsProps) {
  const projects = useProjects();
  const toggle = (key: string, on: boolean) => setKeys((list) => (on ? [...list, key] : list.filter((k) => k !== key)));

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-[1fr_11rem]">
        <FormField label={t("s.name")} htmlFor="token-name" hint={t("me.tokens.nameHint")} error={errors.fields.name}>
          <Input
            id="token-name"
            value={name}
            maxLength={80}
            placeholder={t("me.tokens.namePlaceholder")}
            onChange={(e) => setName(e.target.value)}
          />
        </FormField>
        <FormField label={t("me.tokens.expires")} htmlFor="token-expiry">
          <NativeSelect
            id="token-expiry"
            value={String(days)}
            onChange={(d) => setDays(Number(d))}
            options={expiryChoices.map((d) => ({ value: d, label: t(`me.tokens.expiry.${d}`) }))}
          />
        </FormField>
      </div>
      <FormField label={t("me.tokens.access")}>
        <Checkbox checked={readOnly} onChange={setReadOnly}>
          {t("me.tokens.readOnly")}
        </Checkbox>
      </FormField>
      {projects.length > 0 && (
        <FormField label={t("me.tokens.projects")} hint={t("me.tokens.projectsHint")} error={errors.fields.projects}>
          <div className="flex flex-wrap gap-x-5 gap-y-2 pt-0.5">
            {projects.map((p) => (
              <Checkbox key={p.id} checked={keys.includes(p.key)} onChange={(on) => toggle(p.key, on)}>
                {p.name}
              </Checkbox>
            ))}
          </div>
        </FormField>
      )}
    </>
  );
}

/** Me → API tokens: the person's own tokens in this workspace, for the CLI and scripts acting as them. */
export function MyTokensPage() {
  const base = useSettingsBase();
  const slug = useSlug();
  const me = useMe();
  const projects = useCollection("projects");
  const list = useLoad(
    () =>
      api.get<{ tokens: Token[] }>(ws(slug, "/tokens")).then((r) => r.tokens.filter((tk) => tk.user_id === me.user_id)),
    [slug, me.user_id],
  );
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [revoking, setRevoking] = useState<Token | null>(null);

  return (
    <Page
      title={t("settings.nav.tokens")}
      lead={t("me.tokens.lead")}
      back={base}
      actions={
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus className="size-3.5" aria-hidden />
          {t("me.tokens.new")}
        </Button>
      }
    >
      <LoadGate of={list}>
        {(tokens) =>
          tokens.length === 0 ? (
            <EmptyRow>{t("me.tokens.empty")}</EmptyRow>
          ) : (
            <Rows>
              {tokens.map((tk) => (
                <Row
                  key={tk.id}
                  lead={<KeyRound className="size-4 text-ink-3" aria-hidden />}
                  title={
                    <span className="flex items-center gap-2">
                      <span className="truncate">{tk.name}</span>
                      <ScopeBadges
                        scopes={tk.scopes}
                        readOnly={t("me.tokens.readOnlyBadge")}
                        projects={(ids) =>
                          ids.map((id) => <Badge key={id}>{projects[id]?.key ?? t("me.tokens.oneProject")}</Badge>)
                        }
                      />
                    </span>
                  }
                  sub={
                    <>
                      <span className="font-mono">{tk.prefix}…</span> · {t("me.tokens.created")}{" "}
                      <When ms={tk.created_at} />
                      {tk.expires_at ? (
                        <>
                          {" · "}
                          {tk.expires_at < Date.now()
                            ? t("me.tokens.expired")
                            : t("me.tokens.expiresOn", { when: day.format(tk.expires_at) })}
                        </>
                      ) : null}
                    </>
                  }
                  meta={
                    <Fact label={t("me.lastUsed")} className="max-sm:hidden">
                      <When ms={tk.last_used_at} />
                    </Fact>
                  }
                  actions={
                    <Button variant="ghost" onClick={() => setRevoking(tk)}>
                      {t("s.revoke")}
                    </Button>
                  }
                />
              ))}
            </Rows>
          )
        }
      </LoadGate>

      {creating && (
        <CreateTokenDialog
          user="me"
          title={t("me.tokens.createTitle")}
          description={t("me.tokens.createLead")}
          create={t("me.tokens.create")}
          days={90}
          fields={MyTokenFields}
          onClose={() => setCreating(false)}
          onCreated={(c) => {
            setCreating(false);
            setCreated(c);
            void list.reload();
          }}
        />
      )}
      <RevealDialog
        open={!!created}
        onClose={() => setCreated(null)}
        title={t("me.tokens.revealTitle", { name: created?.info.name ?? "" })}
        warning={t("me.tokens.revealWarning")}
        items={[
          { label: t("me.tokens.token"), value: created?.token ?? "" },
          {
            label: t("me.tokens.loginLine"),
            value: `quadit login ${window.location.origin} ${created?.token ?? ""}`,
            multiline: true,
          },
        ]}
      />
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={t("me.tokens.revokeTitle", { name: revoking?.name ?? "" })}
        body={t("me.tokens.revokeBody")}
        confirm={t("s.revoke")}
        onConfirm={async () => {
          await api.del(ws(slug, `/tokens/${revoking?.id}`));
          await list.reload();
        }}
      />
    </Page>
  );
}
