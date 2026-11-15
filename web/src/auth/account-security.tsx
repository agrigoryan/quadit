import { ShieldCheck } from "lucide-react";
import { useAuthConfig } from "@/auth/config";
import { t } from "@/lib/i18n";
import { useAccount } from "@/settings/me/account";
import { PasskeysSection } from "@/settings/me/passkeys";
import { TwoStepSection } from "@/settings/me/two-step";
import { LoadGate } from "@/ui/load-gate";
import { Note } from "@/ui/form";
import { Page } from "@/ui/settings-layout";

/**
 * Two-step verification and passkeys on a page of their own, outside any
 * workspace. An install that requires a second step lets nobody into a
 * workspace without one, so the place to set it up cannot be inside one.
 */
export function AccountSecurityPage() {
  const account = useAccount();
  // Said only where it is true: an install that does not ask for a second step has nothing to warn about.
  const required = useAuthConfig()?.require_2fa !== false;
  const refresh = () => void account.reload();
  return (
    <main className="h-dvh overflow-y-auto bg-surface">
      <Page title={t("auth.account.title")} lead={t("auth.account.lead")} back="/" backLabel={t("auth.account.back")}>
        <LoadGate of={account}>
          {(a) => (
            <>
              {a.user.totp_at || a.passkeys > 0 ? (
                <Note tone="ok">
                  <ShieldCheck className="mr-1.5 inline size-4 align-[-3px]" aria-hidden />
                  {t("auth.account.ready")}
                </Note>
              ) : (
                required && <Note tone="wait">{t("auth.account.required")}</Note>
              )}
              <TwoStepSection account={a} onChanged={refresh} />
              <PasskeysSection onChanged={refresh} />
            </>
          )}
        </LoadGate>
      </Page>
    </main>
  );
}
