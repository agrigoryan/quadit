import { t } from "@/lib/i18n";
import { useSettingsBase } from "@/settings/base";
import { accountChanged, useAccount } from "@/settings/me/account";
import { IdentitiesSection } from "@/settings/me/identities";
import { PasskeysSection } from "@/settings/me/passkeys";
import { PasswordSection } from "@/settings/me/password";
import { SessionsSection } from "@/settings/me/sessions";
import { TwoStepSection } from "@/settings/me/two-step";
import { LoadGate } from "@/ui/load-gate";
import { Page } from "@/ui/page-layout";

/** Me → Sign-in and security: every way into the account, and every browser that is in. */
export function SecurityPage() {
  const base = useSettingsBase();
  const account = useAccount();
  return (
    <Page title={t("settings.nav.security")} lead={t("me.security.lead")} back={base}>
      <LoadGate of={account}>
        {(a) => (
          <>
            <PasswordSection hasPassword={a.has_password} hasEmail={!!a.user.email} onChanged={accountChanged} />
            <TwoStepSection account={a} onChanged={accountChanged} />
            <PasskeysSection />
            <IdentitiesSection />
            <SessionsSection />
          </>
        )}
      </LoadGate>
    </Page>
  );
}
