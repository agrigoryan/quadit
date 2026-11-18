// The page that signs the Quadit desktop app in. The app opens it in the
// system browser, where passkeys and outside accounts work, with a state and
// a PKCE challenge of its own (the server's side is internal/server/desktop.go).
// Someone signed out is sent through the sign-in page first and comes back.
//
// Nothing happens without the person's Continue: a link alone can open this
// page. Continue is a plain form post, so the server's answer, a redirect to
// quadit://connect with a one-time code, is a navigation the browser hands
// to the app.

import { useState } from "react";
import { useSearchParams } from "react-router";
import { AuthLayout, FormNotice } from "@/auth/auth-layout";
import { useAuthConfig } from "@/auth/config";
import { signOut, useSession } from "@/auth/session";
import { t } from "@/lib/i18n";
import { Button } from "@/ui/button";

// What the server takes (desktop.go): a state of the app's own, and the base64url of a SHA-256 sum.
const STATE = /^[A-Za-z0-9_-]{16,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export function DesktopConnectPage() {
  const [params] = useSearchParams();
  const user = useSession((s) => s.user);
  const install = useAuthConfig()?.name || "Quadit";
  const [answer, setAnswer] = useState<"asking" | "sent" | "cancelled">("asking");
  const state = params.get("state") ?? "";
  const challenge = params.get("challenge") ?? "";

  if (!STATE.test(state) || !CHALLENGE.test(challenge)) {
    return (
      <AuthLayout title={t("auth.desktop.invalidTitle")}>
        <p className="text-sm text-ink-2">{t("auth.desktop.invalid")}</p>
      </AuthLayout>
    );
  }
  if (answer === "cancelled") {
    return (
      <AuthLayout title={t("auth.desktop.cancelledTitle")}>
        <p className="text-sm text-ink-2">{t("auth.desktop.cancelled")}</p>
      </AuthLayout>
    );
  }

  const name = user?.name ?? "";
  return (
    <AuthLayout
      title={t("auth.desktop.title", { name })}
      lead={t("auth.desktop.lead", { install })}
      footer={
        <p>
          {t("auth.desktop.notYou", { name })}{" "}
          <button
            type="button"
            className="font-medium text-accent-text underline-offset-2 hover:underline"
            onClick={() => void signOut()}
          >
            {t("auth.desktop.signOut")}
          </button>
        </p>
      }
    >
      {/* The form stays on the page once sent: taking it away while the browser sends it would stop the sending. */}
      <form
        method="post"
        action="/desktop/connect"
        onSubmit={() => setAnswer("sent")}
        className="flex flex-col gap-3.5"
      >
        <input type="hidden" name="state" value={state} />
        <input type="hidden" name="challenge" value={challenge} />
        {/* Who the page asked about: the server refuses if the browser is signed in as someone else by now. */}
        <input type="hidden" name="user" value={user?.id ?? ""} />
        <FormNotice>{answer === "sent" ? t("auth.desktop.sent") : ""}</FormNotice>
        <div className="flex gap-2">
          <Button type="button" size="lg" className="flex-1" onClick={() => setAnswer("cancelled")}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" size="lg" className="flex-1">
            {t("auth.desktop.continue")}
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}
