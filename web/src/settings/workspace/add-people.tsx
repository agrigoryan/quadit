// "Add people": invite someone by mail or by a link, or add someone who
// already has an account on this install by their email address.

import type { Changes } from "@/lib/changes.gen";
import { type FormEvent, type ReactNode, useState } from "react";
import { Link2, Mail, UserCheck } from "lucide-react";
import { api, ApiError, workspacePath } from "@/lib/api";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { mutate } from "@/lib/mutate";
import { useMe, useSlug } from "@/lib/selectors";
import type { Role } from "@/lib/types";
import { FormAlert, FormField, NativeSelect, useFieldErrors } from "@/ui/form";
import type { Created } from "@/settings/workspace/invites";
import { roleChoices, ROLES } from "@/settings/workspace/roles";
import { MemberScopeFields, scopeArg, type ScopeDraft } from "@/settings/workspace/scope-fields";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Input } from "@/ui/input";

const DAYS = [1, 3, 7, 14, 30];
const USES = [1, 5, 10, 25, 100];

type Mode = "email" | "link" | "account";

interface Props {
  onClose: () => void;
  /** An invitation was made: its link is shown once. */
  onCreated: (out: Created) => void;
  /** Someone with an account was added and is a member now. */
  onAdded: (name: string) => void;
}

export function AddPeopleDialog({ onClose, onCreated, onAdded }: Props) {
  const slug = useSlug();
  const me = useMe();
  const [mode, setMode] = useState<Mode>("email");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [days, setDays] = useState(7);
  const [uses, setUses] = useState(5);
  const [scope, setScope] = useState<ScopeDraft>({ projects: [], readOnly: false });
  const [busy, setBusy] = useState(false);
  /** The address nobody has an account with: offer to invite it instead. */
  const [unknown, setUnknown] = useState("");
  const errors = useFieldErrors(["email", "role", "user", "scope"]);
  // Nobody can invite above their own role.
  const roles = me.role === "owner" ? ROLES : ROLES.filter((r) => r !== "owner");

  function go(next: Mode) {
    setMode(next);
    setUnknown("");
    errors.clear();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    errors.clear();
    setUnknown("");
    const address = email.trim();
    if (mode !== "link" && !/^\S+@\S+\.\S+$/.test(address))
      return errors.set(mode === "account" ? "user" : "email", t("invites.emailBad"));
    setBusy(true);
    try {
      if (mode === "account") {
        const args: Changes["member.add"] = { user: address, role };
        const limit = role === "owner" ? null : scopeArg(scope);
        if (limit) args.scope = limit;
        await mutate({ type: "member.add", args }, undefined, { quiet: true });
        onAdded(address);
        return;
      }
      const body =
        mode === "email" ? { email: address, role, expires_days: days } : { role, expires_days: days, max_uses: uses };
      onCreated(await api.post<Created>(workspacePath(slug, "/invites"), body));
    } catch (err) {
      if (mode === "account" && err instanceof ApiError && err.status === 404) setUnknown(address);
      errors.fail(err);
      setBusy(false);
    }
  }

  const tab = (value: Mode, label: string, icon: ReactNode) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === value}
      onClick={() => go(value)}
      className={cx(
        "flex h-7 flex-1 items-center justify-center gap-1.5 rounded-sm px-1 text-sm font-medium whitespace-nowrap transition-colors",
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
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" type="submit" form="invite-form" disabled={busy}>
            {mode === "account" ? t("members.add") : t("invites.create")}
          </Button>
        </>
      }
    >
      <form id="invite-form" onSubmit={submit} className="flex flex-col gap-3.5" noValidate>
        <div role="tablist" className="flex gap-0.5 rounded-md bg-sunken p-0.5">
          {tab("email", t("invites.byEmail"), <Mail className="size-3.5" aria-hidden />)}
          {tab("link", t("invites.byLink"), <Link2 className="size-3.5" aria-hidden />)}
          {tab("account", t("members.byAccount"), <UserCheck className="size-3.5" aria-hidden />)}
        </div>
        {mode === "link" ? (
          <p className="text-sm text-ink-2">{t("invites.linkHint")}</p>
        ) : (
          <FormField
            label={t("invites.email")}
            htmlFor="inv-email"
            hint={mode === "account" ? t("members.accountHint") : t("invites.emailHint")}
            error={mode === "account" ? errors.fields.user : errors.fields.email}
          >
            <Input
              id="inv-email"
              type="email"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
            />
          </FormField>
        )}
        {unknown && (
          <p className="-mt-1.5 text-sm">
            <button
              type="button"
              className="font-medium text-accent-text underline-offset-2 hover:underline"
              onClick={() => go("email")}
            >
              {t("members.inviteInstead", { email: unknown })}
            </button>
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <FormField
            label={t("invites.role")}
            error={errors.fields.role}
            className={mode === "email" ? "" : "col-span-2"}
          >
            <NativeSelect value={role} onChange={(v) => setRole(v as Role)} options={roleChoices(roles)} />
          </FormField>
          {mode !== "account" && (
            <FormField label={t("invites.expires")}>
              <NativeSelect
                value={String(days)}
                onChange={(v) => setDays(Number(v))}
                options={DAYS.map((n) => ({ value: String(n), label: t("invites.days", { n }) }))}
              />
            </FormField>
          )}
          {mode === "link" && (
            <FormField label={t("invites.uses")}>
              <NativeSelect
                value={String(uses)}
                onChange={(v) => setUses(Number(v))}
                options={USES.map((n) => ({ value: String(n), label: t("invites.usesN", { n }) }))}
              />
            </FormField>
          )}
        </div>
        {mode === "account" && role !== "owner" && (
          <MemberScopeFields value={scope} onChange={setScope} error={errors.fields.scope} />
        )}
        <FormAlert>{errors.form}</FormAlert>
      </form>
    </Dialog>
  );
}
