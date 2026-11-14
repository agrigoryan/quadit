import { type FormEvent, useMemo, useRef, useState } from "react";
import { saveTheme, useSession } from "@/auth/session";
import { errorMessage } from "@/lib/api";
import { isImage, uploadFile } from "@/lib/files";
import { t } from "@/lib/i18n";
import { useMe } from "@/lib/selectors";
import { type ThemeChoice, toThemeChoice } from "@/lib/theme";
import { toast } from "@/lib/toast";
import { useSettingsBase } from "@/settings/base";
import { type Account, saveAccount, useAccount } from "@/settings/me/account";
import { Segmented } from "@/settings/me/segmented";
import { LoadGate } from "@/settings/ui/bits";
import { FormAlert, FormField, FormFoot, NativeSelect, useFieldErrors } from "@/settings/ui/form";
import { Card, Page, Section } from "@/settings/ui/layout";
import { Avatar } from "@/ui/avatar";
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
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const avatar = account.user.avatar;

  async function save(next: string) {
    setBusy(true);
    setError("");
    try {
      onSaved(await saveAccount({ avatar: next }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function pick(file: File | undefined) {
    if (!file) return;
    if (!isImage({ content_type: file.type })) {
      setError(t("me.profile.avatarNotImage"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const row = await uploadFile(file);
      await save(row.url);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-4">
        <span className="flex size-14 shrink-0 items-center justify-center">
          <Avatar member={{ user_id: me.user_id, name: account.user.name, kind: "person", avatar }} size="lg" className="scale-[1.75]" />
        </span>
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={busy} onClick={() => input.current?.click()}>
              {busy ? t("me.profile.uploading") : avatar ? t("me.profile.avatarChange") : t("me.profile.avatarUpload")}
            </Button>
            {avatar && (
              <Button variant="ghost" disabled={busy} onClick={() => void save("")}>
                {t("me.profile.avatarRemove")}
              </Button>
            )}
          </div>
          <p className="text-xs text-ink-3">{t("me.profile.avatarHint")}</p>
        </div>
        <input
          ref={input}
          type="file"
          accept="image/*"
          className="hidden"
          aria-label={t("me.profile.avatarUpload")}
          onChange={(e) => {
            void pick(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function ProfileForm({ account, onSaved }: { account: Account; onSaved: (a: Account) => void }) {
  const [name, setName] = useState(account.user.name);
  const [zone, setZone] = useState(account.user.timezone || browserZone());
  const [busy, setBusy] = useState(false);
  const errors = useFieldErrors(["name", "timezone"]);
  const zones = useZones(zone);
  const dirty = name.trim() !== account.user.name || zone !== (account.user.timezone ?? "");

  async function submit(e: FormEvent) {
    e.preventDefault();
    errors.clear();
    if (!name.trim()) {
      errors.set("name", t("me.profile.nameRequired"));
      return;
    }
    setBusy(true);
    try {
      onSaved(await saveAccount({ name: name.trim(), timezone: zone }));
      toast.info(t("s.saved"));
    } catch (err) {
      errors.fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <AvatarField account={account} onSaved={onSaved} />
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t("me.profile.name")} htmlFor="me-name" error={errors.fields.name}>
            <Input id="me-name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
          </FormField>
          <FormField label={t("auth.email")} htmlFor="me-email" hint={t("me.profile.emailHint")}>
            <Input id="me-email" value={account.user.email ?? ""} readOnly disabled />
          </FormField>
        </div>
        <FormField label={t("me.profile.zone")} htmlFor="me-zone" hint={t("me.profile.zoneHint")} error={errors.fields.timezone}>
          <NativeSelect id="me-zone" value={zone} onChange={setZone} options={zones} className="sm:max-w-xs" />
        </FormField>
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

const themes: ThemeChoice[] = ["system", "light", "dark"];

function ThemeSection() {
  const theme = useSession((s) => toThemeChoice(s.user?.theme));
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
            <ThemeSection />
          </>
        )}
      </LoadGate>
    </Page>
  );
}
