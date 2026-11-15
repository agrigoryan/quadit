import { type FormEvent, useMemo, useState } from "react";
import { saveTheme } from "@/auth/session";
import { errorMessage } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useMe } from "@/lib/selectors";
import { type ThemeChoice, useThemeChoice } from "@/lib/theme";
import { toast } from "@/lib/toast";
import { useSettingsBase } from "@/settings/base";
import { type Account, saveAccount, useAccount } from "@/settings/me/account";
import { Segmented } from "@/settings/me/segmented";
import { AvatarInput } from "@/settings/ui/avatar-input";
import { LoadGate } from "@/ui/load-gate";
import { FormAlert, FormField, FormFoot, NativeSelect, useFieldErrors, useSubmit } from "@/ui/form";
import { Card, Page, Section } from "@/ui/settings-layout";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";

const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

/** Every time zone the browser knows, with the saved one kept even if this browser does not list it. */
function useZones(current: string) {
  return useMemo(() => {
    let names: string[] = [];
    try {
      names = Intl.supportedValuesOf("timeZone");
    } catch {
      // An old browser: offer what we have.
    }
    const all = new Set(["UTC", ...names, current]);
    return [...all].sort().map((z) => ({ value: z, label: z.replace(/_/g, " ") }));
  }, [current]);
}

function AvatarField({ account, onSaved }: { account: Account; onSaved: (a: Account) => void }) {
  const me = useMe();
  return (
    <AvatarInput
      member={{ user_id: me.user_id, name: account.user.name, kind: "person" }}
      value={account.user.avatar ?? ""}
      onChange={async (next) => onSaved(await saveAccount({ avatar: next }))}
      hint={t("me.profile.avatarHint")}
    />
  );
}

function ProfileForm({ account, onSaved }: { account: Account; onSaved: (a: Account) => void }) {
  const [name, setName] = useState(account.user.name);
  const [zone, setZone] = useState(account.user.timezone || browserZone());
  const errors = useFieldErrors(["name", "timezone"]);
  const { busy, run } = useSubmit(errors);
  const zones = useZones(zone);
  const dirty = name.trim() !== account.user.name || zone !== (account.user.timezone ?? "");

  async function submit(e: FormEvent) {
    e.preventDefault();
    errors.clear();
    if (!name.trim()) {
      errors.set("name", t("me.profile.nameRequired"));
      return;
    }
    await run(async () => {
      onSaved(await saveAccount({ name: name.trim(), timezone: zone }));
      toast.info(t("s.saved"));
    });
  }

  return (
    <Card>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <AvatarField account={account} onSaved={onSaved} />
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t("me.profile.name")} htmlFor="me-name" error={errors.fields.name}>
            <Input id="me-name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
          </FormField>
          <FormField
            label={t("me.profile.zone")}
            htmlFor="me-zone"
            hint={t("me.profile.zoneHint")}
            error={errors.fields.timezone}
          >
            <NativeSelect id="me-zone" value={zone} onChange={setZone} options={zones} />
          </FormField>
        </div>
        <FormAlert>{errors.form}</FormAlert>
        <FormFoot>
          <Button type="submit" variant="primary" disabled={busy || !dirty}>
            {busy ? t("s.saving") : t("common.save")}
          </Button>
        </FormFoot>
      </form>
    </Card>
  );
}

/** The sign-in address, and the way to change it: the new address, confirmed with the current password. */
function EmailSection({ account, onSaved }: { account: Account; onSaved: (a: Account) => void }) {
  const current = account.user.email ?? "";
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const errors = useFieldErrors(["email", "password"]);
  const { busy, run } = useSubmit(errors);

  function close() {
    setOpen(false);
    setEmail("");
    setPassword("");
    errors.clear();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    errors.clear();
    const next = email.trim();
    if (!next) return errors.set("email", t("me.email.required"));
    if (next.toLowerCase() === current.toLowerCase()) return errors.set("email", t("me.email.same"));
    if (account.has_password && !password) return errors.set("password", t("me.email.passwordRequired"));
    await run(async () => {
      onSaved(await saveAccount(account.has_password ? { email: next, password } : { email: next }));
      toast.info(t("me.email.changed"));
      close();
    });
  }

  return (
    <Section title={t("me.email.title")} lead={t("me.email.lead")}>
      <Card>
        {open ? (
          <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label={t("me.email.new")}
                htmlFor="me-email"
                hint={t("me.email.now", { email: current })}
                error={errors.fields.email}
              >
                <Input
                  id="me-email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  autoFocus
                  aria-invalid={!!errors.fields.email}
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    errors.set("email", "");
                  }}
                />
              </FormField>
              {account.has_password && (
                <FormField
                  label={t("me.email.password")}
                  htmlFor="me-email-password"
                  hint={t("me.email.passwordHint")}
                  error={errors.fields.password}
                >
                  <Input
                    id="me-email-password"
                    type="password"
                    autoComplete="current-password"
                    aria-invalid={!!errors.fields.password}
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      errors.set("password", "");
                    }}
                  />
                </FormField>
              )}
            </div>
            <FormAlert>{errors.form}</FormAlert>
            <FormFoot>
              <Button onClick={close} disabled={busy}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? t("s.saving") : t("me.email.submit")}
              </Button>
            </FormFoot>
          </form>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 truncate text-sm font-medium">{current || t("me.email.none")}</p>
            <Button onClick={() => setOpen(true)}>{t("me.email.change")}</Button>
          </div>
        )}
      </Card>
    </Section>
  );
}

const themes: ThemeChoice[] = ["system", "light", "dark"];

function ThemeSection() {
  const theme = useThemeChoice();
  return (
    <Section title={t("top.theme")} lead={t("me.profile.themeLead")}>
      <Segmented
        label={t("top.theme")}
        value={theme}
        onChange={(next) => void saveTheme(next).catch((err: unknown) => toast.error(errorMessage(err)))}
        options={themes.map((value) => ({ value, label: t(`top.theme.${value}`) }))}
      />
    </Section>
  );
}

/** Me → Profile: how the person appears to everyone, and how the app looks to them. */
export function ProfilePage() {
  const base = useSettingsBase();
  const account = useAccount();
  return (
    <Page title={t("me.profile.title")} lead={t("me.profile.lead")} back={base}>
      <LoadGate of={account}>
        {(a) => (
          <>
            <ProfileForm account={a} onSaved={account.set} />
            <EmailSection account={a} onSaved={account.set} />
            <ThemeSection />
          </>
        )}
      </LoadGate>
    </Page>
  );
}
