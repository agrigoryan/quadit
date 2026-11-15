import { type FormEvent, useState } from "react";
import { X } from "lucide-react";
import { t } from "@/lib/i18n";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { ProviderForm } from "@/admin/provider-form";
import { SettingForm } from "@/admin/setting-form";
import { SettingSwitch } from "@/admin/setting-switch";
import { useDraft } from "@/admin/settings";
import { FormField } from "@/ui/form";
import { Page, Rows, Section } from "@/ui/settings-layout";

const cleanDomain = (raw: string) => raw.trim().toLowerCase().replace(/^@/, "");

/** The list of email domains new accounts are limited to. */
function AllowedDomains() {
  const domains = useDraft<string[]>("auth.allowed_domains", []);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");

  function add(e?: FormEvent) {
    e?.preventDefault();
    const domain = cleanDomain(typed);
    if (!domain) return;
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
      setError(t("admin.signIn.domainBad"));
      return;
    }
    setError("");
    setTyped("");
    if (!domains.draft.includes(domain)) domains.set([...domains.draft, domain]);
  }

  return (
    <SettingForm of={domains}>
      {domains.draft.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {domains.draft.map((domain) => (
            <li
              key={domain}
              className="inline-flex h-6 items-center gap-1 rounded-full border border-line bg-sunken pr-1 pl-2.5 text-sm"
            >
              {domain}
              <button
                type="button"
                aria-label={t("admin.signIn.domainRemove", { domain })}
                onClick={() => domains.set(domains.draft.filter((d) => d !== domain))}
                className="flex size-4 items-center justify-center rounded-full text-ink-3 hover:bg-press hover:text-ink"
              >
                <X className="size-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-2">{t("admin.signIn.domainsNone")}</p>
      )}
      <FormField
        label={t("admin.signIn.domainAdd")}
        htmlFor="allowed-domain"
        error={error}
        hint={t("admin.signIn.domainHint")}
      >
        <span className="flex max-w-sm gap-2">
          <Input
            id="allowed-domain"
            value={typed}
            placeholder="example.com"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setTyped(e.target.value);
              setError("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") add(e);
            }}
          />
          <Button onClick={() => add()} disabled={!typed.trim()} className="h-8">
            {t("common.add")}
          </Button>
        </span>
      </FormField>
    </SettingForm>
  );
}

export function SignInPage() {
  return (
    <Page title={t("admin.signIn.title")} lead={t("admin.signIn.lead")} back="/admin">
      <Section title={t("admin.signIn.ways")}>
        <Rows>
          <SettingSwitch
            name="auth.password"
            fallback={true}
            title={t("admin.signIn.password")}
            hint={t("admin.signIn.passwordHint")}
            confirm={{
              when: false,
              title: t("admin.signIn.passwordOff"),
              body: t("admin.signIn.passwordOffBody"),
              action: t("admin.signIn.turnOff"),
            }}
          />
          <SettingSwitch
            name="auth.passkeys"
            fallback={true}
            title={t("admin.signIn.passkeys")}
            hint={t("admin.signIn.passkeysHint")}
          />
          <SettingSwitch
            name="auth.require_2fa"
            fallback={false}
            title={t("admin.signIn.require2fa")}
            hint={t("admin.signIn.require2faHint")}
            confirm={{
              when: true,
              title: t("admin.signIn.require2faOn"),
              body: t("admin.signIn.require2faOnBody"),
              action: t("admin.signIn.require"),
            }}
          />
        </Rows>
      </Section>

      <Section title={t("admin.signIn.accounts")}>
        <Rows>
          <SettingSwitch
            name="auth.registration"
            fallback={false}
            title={t("admin.signIn.registration")}
            hint={t("admin.signIn.registrationHint")}
          />
        </Rows>
      </Section>

      <Section title={t("admin.signIn.domains")} lead={t("admin.signIn.domainsLead")}>
        <AllowedDomains />
      </Section>

      <Section title={t("admin.signIn.providers")} lead={t("admin.signIn.providersLead")}>
        <div className="flex flex-col gap-4">
          <ProviderForm provider="google" name="Google" />
          <ProviderForm provider="github" name="GitHub" />
          <ProviderForm provider="oidc" name={t("admin.signIn.oidc")} />
        </div>
      </Section>
    </Page>
  );
}
