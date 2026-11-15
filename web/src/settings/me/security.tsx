import { useState } from "react";
import { t } from "@/lib/i18n";
import { useSettingsBase } from "@/settings/base";
import { useAccount } from "@/settings/me/account";
import { IdentitiesSection } from "@/settings/me/identities";
import { PasskeysSection } from "@/settings/me/passkeys";
import { PasswordSection } from "@/settings/me/password";
import { SessionsSection } from "@/settings/me/sessions";
import { TwoStepSection } from "@/settings/me/two-step";
import { LoadGate } from "@/ui/load-gate";
import { Page } from "@/ui/settings-layout";

/** Me → Sign-in and security: every way into the account, and every browser that is in. */
export function SecurityPage() {
  const base = useSettingsBase();
  const account = useAccount();
  const [stamp, setStamp] = useState(0);
  const refresh = () => void account.reload();
  return (
    <Page title={t("settings.nav.security")} lead={t("me.security.lead")} back={base}>
      <LoadGate of={account}>
        {(a) => (
          <>
            <PasswordSection
              hasPassword={a.has_password}
              onChanged={() => {
                refresh();
                setStamp((n) => n + 1);
              }}
            />
            <TwoStepSection account={a} onChanged={refresh} />
            <PasskeysSection onChanged={refresh} />
            <IdentitiesSection onChanged={refresh} />
            <SessionsSection stamp={stamp} />
          </>
        )}
      </LoadGate>
    </Page>
  );
}
