import { type FormEvent, useState } from "react";
import { Link2, Mail, UserPlus } from "lucide-react";
import { api, ws } from "@/lib/api";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useMe, useSlug } from "@/lib/selectors";
import { useStore } from "@/lib/store";
import type { Role } from "@/lib/types";
import { Fact, When } from "@/settings/ui/bits";
import { ConfirmDialog, RevealDialog } from "@/settings/ui/dialogs";
import { FormAlert, FormField, NativeSelect, useFieldErrors } from "@/settings/ui/form";
import { EmptyRow, Row, Rows, Section } from "@/settings/ui/layout";
import { useLoad } from "@/settings/ui/use-load";
import { roleChoices, ROLES } from "@/settings/workspace/roles";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Input } from "@/ui/input";

interface Invite {
  id: string;
  email?: string;
  role: Role;
  created_by: string;
  created_at: number;
  expires_at: number;
  max_uses: number;
  uses: number;
}

interface Created {
  invite: Invite;
  link: string;
  mailed: boolean;
}

const DAYS = [1, 3, 7, 14, 30];
const USES = [1, 5, 10, 25, 100];

/** Invitations that are still good, and the way to make one. */
export function InvitesSection() {
  const slug = useSlug();
  const members = useStore((s) => s.c.members);
  const invites = useLoad(() => api.get<{ invites: Invite[] }>(ws(slug, "/invites")).then((r) => r.invites), [slug]);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const [revoke, setRevoke] = useState<Invite | null>(null);

  return (
    <Section
      title={t("invites.title")}
      lead={t("invites.lead")}
      actions={
        <Button variant="primary" onClick={() => setCreating(true)}>
          <UserPlus className="size-3.5" aria-hidden />
          {t("invites.new")}
        </Button>
      }
    >
      {invites.error && <FormAlert>{invites.error}</FormAlert>}
      {invites.data?.length === 0 && <EmptyRow>{t("invites.none")}</EmptyRow>}
      {!!invites.data?.length && (
        <Rows>
          {invites.data.map((inv) => (
            <Row
              key={inv.id}
              lead={<span className="flex size-8 items-center justify-center rounded-full bg-sunken text-ink-2">{inv.email ? <Mail className="size-4" /> : <Link2 className="size-4" />}</span>}
              title={inv.email || t("invites.anyone")}
              sub={
                <>
                  {t("invites.by", { name: members[inv.created_by]?.name ?? t("common.someone") })} · <When ms={inv.created_at} />
                </>
              }
              meta={
                <>
                  {inv.max_uses > 1 && <span className="max-sm:hidden">{t("invites.used", { uses: inv.uses, max: inv.max_uses })}</span>}
                  <Fact label={t("invites.expiresIn")} className="max-sm:hidden">
                    {new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(inv.expires_at)}
                  </Fact>
                  <Badge>{t(`role.${inv.role}`)}</Badge>
                </>
              }
              actions={
                <Button variant="ghost" size="sm" onClick={() => setRevoke(inv)}>
                  {t("s.revoke")}
                </Button>
              }
            />
          ))}
        </Rows>
      )}

      {creating && (
        <InviteDialog
          onClose={() => setCreating(false)}
          onCreated={(out) => {
            setCreating(false);
            setCreated(out);
            void invites.reload();
          }}
        />
      )}
      <RevealDialog
        open={!!created}
        onClose={() => setCreated(null)}
        title={t("invites.created")}
        warning={created?.mailed ? t("invites.mailed", { email: created.invite.email ?? "" }) : t("invites.notMailed")}
        items={created ? [{ label: t("invites.link"), value: created.link }] : []}
      />
      <ConfirmDialog
        open={!!revoke}
        onOpenChange={(open) => !open && setRevoke(null)}
        title={t("invites.revoke.title")}
        body={t("invites.revoke.body")}
        confirm={t("s.revoke")}
        onConfirm={async () => {
          await api.del(ws(slug, `/invites/${revoke?.id}`));
          await invites.reload();
        }}
      />
    </Section>
  );
}

function InviteDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (out: Created) => void }) {
  const slug = useSlug();
  const me = useMe();
  const [mode, setMode] = useState<"email" | "link">("email");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [days, setDays] = useState(7);
  const [uses, setUses] = useState(5);
  const [busy, setBusy] = useState(false);
  const errors = useFieldErrors(["email", "role"]);
  // Nobody can invite above their own role.
  const roles = me.role === "owner" ? ROLES : ROLES.filter((r) => r !== "owner");

  async function submit(e: FormEvent) {
    e.preventDefault();
    errors.clear();
    if (mode === "email" && !/^\S+@\S+\.\S+$/.test(email.trim())) return errors.set("email", t("invites.emailBad"));
    setBusy(true);
    try {
      const body = mode === "email" ? { email: email.trim(), role, expires_days: days } : { role, expires_days: days, max_uses: uses };
      onCreated(await api.post<Created>(ws(slug, "/invites"), body));
    } catch (err) {
      errors.fail(err);
      setBusy(false);
    }
  }

  const tab = (value: "email" | "link", label: string, icon: React.ReactNode) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === value}
      onClick={() => setMode(value)}
      className={cx(
        "flex h-7 flex-1 items-center justify-center gap-1.5 rounded-sm text-sm font-medium transition-colors",
        mode === value ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:text-ink",
      )}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("invites.new")}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" type="submit" form="invite-form" disabled={busy}>
            {t("invites.create")}
          </Button>
        </>
      }
    >
      <form id="invite-form" onSubmit={submit} className="flex flex-col gap-3.5">
        <div role="tablist" className="flex gap-0.5 rounded-md bg-sunken p-0.5">
          {tab("email", t("invites.byEmail"), <Mail className="size-3.5" aria-hidden />)}
          {tab("link", t("invites.byLink"), <Link2 className="size-3.5" aria-hidden />)}
        </div>
        {mode === "email" ? (
          <FormField label={t("invites.email")} htmlFor="inv-email" hint={t("invites.emailHint")} error={errors.fields.email}>
            <Input id="inv-email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
          </FormField>
        ) : (
          <p className="text-sm text-ink-2">{t("invites.linkHint")}</p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <FormField label={t("invites.role")} error={errors.fields.role} className={mode === "link" ? "col-span-2" : ""}>
            <NativeSelect value={role} onChange={(v) => setRole(v as Role)} options={roleChoices(roles)} />
          </FormField>
          <FormField label={t("invites.expires")}>
            <NativeSelect value={String(days)} onChange={(v) => setDays(Number(v))} options={DAYS.map((n) => ({ value: String(n), label: t("invites.days", { n }) }))} />
          </FormField>
          {mode === "link" && (
            <FormField label={t("invites.uses")}>
              <NativeSelect value={String(uses)} onChange={(v) => setUses(Number(v))} options={USES.map((n) => ({ value: String(n), label: t("invites.usesN", { n }) }))} />
            </FormField>
          )}
        </div>
        <FormAlert>{errors.form}</FormAlert>
      </form>
    </Dialog>
  );
}
