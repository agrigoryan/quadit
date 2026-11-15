// One outside sign-in provider (Google, GitHub, or any OpenID Connect
// provider): its switch, the client id and secret, and the redirect address
// to paste into the provider's console.

import { t } from "@/lib/i18n";
import { SecretField, SettingForm, TextField } from "@/admin/setting-form";
import { useDraft, useSetting } from "@/admin/settings";
import { CopyField } from "@/ui/settings-dialogs";
import { SwitchRow } from "@/ui/form";

interface ProviderSetting {
  enabled: boolean;
  client_id: string;
  client_secret: string;
  /** OpenID Connect only. */
  issuer?: string;
  name?: string;
  /** OpenID Connect only: an address the provider does not say it verified is taken as verified. */
  trust_email?: boolean;
}

const empty: ProviderSetting = { enabled: false, client_id: "", client_secret: "" };

interface Props {
  provider: "google" | "github" | "oidc";
  /** The provider's name as the heading. */
  name: string;
}

export function ProviderForm({ provider, name }: Props) {
  const oidc = provider === "oidc";
  const setting = `auth.${provider}`;
  const stored = useSetting<ProviderSetting>(setting, empty).value;
  const form = useDraft<ProviderSetting>(setting, empty, {
    validate: (v) => {
      const wrong: Record<string, string> = {};
      if (v.enabled && !v.client_id.trim()) wrong.client_id = t("admin.provider.needId");
      if (v.enabled && !v.client_secret) wrong.client_secret = t("admin.provider.needSecret");
      if (v.enabled && oidc && !/^https?:\/\/\S+$/.test((v.issuer ?? "").trim()))
        wrong.issuer = t("admin.provider.needIssuer");
      return wrong;
    },
    toValue: (v) => ({ ...v, client_id: v.client_id.trim(), issuer: v.issuer?.trim(), name: v.name?.trim() }),
  });
  const d = form.draft;
  const e = form.errors.fields;
  const redirect = `${window.location.origin}/api/v1/auth/oauth/${provider}/callback`;

  return (
    <SettingForm of={form} below={<CopyField label={t("admin.provider.redirect")} value={redirect} />}>
      <SwitchRow
        title={name}
        hint={d.enabled ? t("admin.provider.onHint", { name }) : t("admin.provider.offHint")}
        checked={d.enabled}
        disabled={form.locked}
        onChange={(enabled) => form.set({ enabled })}
      />
      {oidc && (
        <div className="grid gap-3.5 sm:grid-cols-2">
          <TextField
            label={t("admin.provider.issuer")}
            value={d.issuer ?? ""}
            onChange={(issuer) => form.set({ issuer })}
            error={e.issuer}
            placeholder="https://id.example.com"
            hint={t("admin.provider.issuerHint")}
          />
          <TextField
            label={t("admin.provider.button")}
            value={d.name ?? ""}
            onChange={(v) => form.set({ name: v })}
            placeholder={t("admin.provider.buttonDefault")}
            hint={t("admin.provider.buttonHint")}
          />
        </div>
      )}
      {oidc && (
        <SwitchRow
          title={t("admin.provider.trustEmail")}
          hint={t("admin.provider.trustEmailHint")}
          checked={d.trust_email ?? false}
          disabled={form.locked}
          onChange={(trust_email) => form.set({ trust_email })}
        />
      )}
      <div className="grid gap-3.5 sm:grid-cols-2">
        <TextField
          label={t("admin.provider.clientId")}
          value={d.client_id}
          onChange={(client_id) => form.set({ client_id })}
          error={e.client_id}
          mono
        />
        <SecretField
          label={t("admin.provider.clientSecret")}
          value={d.client_secret}
          stored={stored.client_secret}
          onChange={(client_secret) => form.set({ client_secret })}
          error={e.client_secret}
        />
      </div>
    </SettingForm>
  );
}
