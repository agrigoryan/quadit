// The ways in other than a password: a passkey, and the outside accounts the
// install has set up (Google, GitHub, a company's single sign-on).

import { useState } from "react";
import { KeyRound, LogIn } from "lucide-react";
import { passkeySignIn } from "@/auth/session";
import { passkeyCanceled, passkeysSupported } from "@/auth/webauthn";
import { errorMessage } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Button } from "@/ui/button";

function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" className="size-4" aria-hidden>
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path fill="#FBBC05" d="M3.96 10.71a5.4 5.4 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l3-2.33Z" />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden>
      <path d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.93-.89-1.17-.89-1.17-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.72 1.22 1.88.87 2.33.66.07-.52.28-.87.5-1.07-1.77-.2-3.64-.89-3.64-3.95 0-.88.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.19c0 .21.15.46.55.38A8 8 0 0 0 8 0Z" />
    </svg>
  );
}

const marks: Record<string, () => React.ReactNode> = {
  google: GoogleMark,
  github: GitHubMark,
};

interface Props {
  providers: { id: string; name: string }[];
  /** Carried through the provider and back: "next=/games/inbox" or "invite=<token>". */
  query: string;
}

/** One button per outside account the install accepts. A press leaves the app for the provider. */
export function ProviderButtons({ providers, query }: Props) {
  return (
    <>
      {providers.map((p) => {
        const Mark = marks[p.id];
        return (
          <Button
            key={p.id}
            size="lg"
            className="w-full"
            onClick={() => {
              window.location.href = `/api/v1/auth/oauth/${encodeURIComponent(p.id)}/start?${query}`;
            }}
          >
            {Mark ? <Mark /> : <LogIn className="size-4" aria-hidden />}
            {t("auth.continueWith", { name: p.name })}
          </Button>
        );
      })}
    </>
  );
}

/** "Sign in with a passkey". Shows nothing in a browser that has no passkeys. */
export function PasskeyButton({ onError }: { onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  if (!passkeysSupported()) return null;

  async function run() {
    setBusy(true);
    onError("");
    try {
      await passkeySignIn();
    } catch (err) {
      // Closing the browser's sheet is a change of mind, not a failure.
      if (!passkeyCanceled(err)) onError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button size="lg" className="w-full" disabled={busy} onClick={() => void run()}>
      <KeyRound className="size-4" aria-hidden />
      {busy ? t("auth.passkey.busy") : t("auth.passkey.signIn")}
    </Button>
  );
}
