import { type FormEvent, useState } from "react";
import { KeyRound, Plus } from "lucide-react";
import { api, ws } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useCollection, useMe, useProjects, useSlug } from "@/lib/selectors";
import { useSettingsBase } from "@/settings/base";
import { Fact, LoadGate, When } from "@/settings/ui/bits";
import { ConfirmDialog, RevealDialog } from "@/settings/ui/dialogs";
import { Checkbox, FormAlert, FormField, NativeSelect, useFieldErrors } from "@/settings/ui/form";
import { EmptyRow, Page, Row, Rows } from "@/settings/ui/layout";
import { useLoad } from "@/settings/ui/use-load";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
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

interface Created {
  token: string;
  info: Token;
}

const day = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const expiryChoices = ["0", "30", "90", "365"] as const;

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (c: Created) => void }) {
  const slug = useSlug();
  const projects = useProjects();
  const [name, setName] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [keys, setKeys] = useState<string[]>([]);
  const [days, setDays] = useState<string>("90");
  const [busy, setBusy] = useState(false);
  const errors = useFieldErrors(["name", "projects"]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    errors.clear();
    setBusy(true);
    try {
      onCreated(
        await api.post<Created>(ws(slug, "/tokens"), { user: "me", name: name.trim(), read_only: readOnly, projects: keys, expires_days: Number(days) }),
      );
    } catch (err) {
      errors.fail(err);
    } finally {
      setBusy(false);
    }
  }

  const toggle = (key: string, on: boolean) => setKeys((list) => (on ? [...list, key] : list.filter((k) => k !== key)));

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("me.tokens.createTitle")}
      description={t("me.tokens.createLead")}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" form="token-create" variant="primary" disabled={busy}>
            {t("me.tokens.create")}
          </Button>
        </>
      }
    >
      <form id="token-create" onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-[1fr_11rem]">
          <FormField label={t("s.name")} htmlFor="token-name" hint={t("me.tokens.nameHint")} error={errors.fields.name}>
            <Input id="token-name" value={name} maxLength={80} placeholder={t("me.tokens.namePlaceholder")} onChange={(e) => setName(e.target.value)} />
          </FormField>
          <FormField label={t("me.tokens.expires")} htmlFor="token-expiry">
            <NativeSelect id="token-expiry" value={days} onChange={setDays} options={expiryChoices.map((d) => ({ value: d, label: t(`me.tokens.expiry.${d}`) }))} />
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
        <FormAlert>{errors.form}</FormAlert>
      </form>
    </Dialog>
  );
}

/** What a token may do, as badges: read-only, and the projects it is held to. */
function Scopes({ scopes }: { scopes: string | undefined }) {
  const projects = useCollection("projects");
  const parts = (scopes ?? "").split(" ").filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <>
      {parts.includes("read") && <Badge>{t("me.tokens.readOnlyBadge")}</Badge>}
      {parts
        .filter((s) => s.startsWith("project:"))
        .map((s) => (
          <Badge key={s}>{projects[s.slice("project:".length)]?.key ?? t("me.tokens.oneProject")}</Badge>
        ))}
    </>
  );
}

/** Me → API tokens: the person's own tokens in this workspace, for the CLI and scripts acting as them. */
export function MyTokensPage() {
  const base = useSettingsBase();
  const slug = useSlug();
  const me = useMe();
  const list = useLoad(
    () => api.get<{ tokens: Token[] }>(ws(slug, "/tokens")).then((r) => r.tokens.filter((tk) => tk.user_id === me.user_id)),
    [slug, me.user_id],
  );
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
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
                      <Scopes scopes={tk.scopes} />
                    </span>
                  }
                  sub={
                    <>
                      <span className="font-mono">{tk.prefix}…</span> · {t("me.tokens.created")} <When ms={tk.created_at} />
                      {tk.expires_at ? (
                        <>
                          {" · "}
                          {tk.expires_at < Date.now() ? t("me.tokens.expired") : t("me.tokens.expiresOn", { when: day.format(tk.expires_at) })}
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
        <CreateDialog
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
          { label: t("me.tokens.loginLine"), value: `quadit login ${window.location.origin} ${created?.token ?? ""}`, multiline: true },
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
