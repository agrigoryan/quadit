import { type FormEvent, useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router";
import { AuthLayout, FormError, FormNotice, OrLine, TextLink } from "@/auth/auth-layout";
import { safeNext, useAuthConfig } from "@/auth/config";
import { PasskeyButton, ProviderButtons } from "@/auth/providers";
import { SecondStep } from "@/auth/second-step";
import { signIn, useSession } from "@/auth/session";
import { errorMessage } from "@/data/api";
import { t } from "@/lib/i18n";
import { Button } from "@/ui/button";
import { FormField } from "@/ui/form";
import { Input } from "@/ui/input";

/**
 * The sign-in page. It offers what the install has turned on: a password,
 * a passkey, outside accounts. Someone whose account has a second step sees
 * that screen next, also when they come back from an outside account.
 */
export function LoginPage() {
  const status = useSession((s) => s.status);
  const half = useSession((s) => s.half);
  const config = useAuthConfig();
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // The server sends people back here with ?error= when an outside account did not work out.
  const [error, setError] = useState(params.get("error") ?? "");
  const [busy, setBusy] = useState(false);
  const next = safeNext(params.get("next"));
  const notice = (location.state as { notice?: string } | null)?.notice;

  // A fresh install has nobody to sign in as yet.
  useEffect(() => {
    if (config?.setup_needed) void navigate("/setup", { replace: true });
  }, [config, navigate]);

  if (status === "in") return <Navigate to={next} replace />;
  if (half) return <SecondStep />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await signIn(email, password);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const providers = config?.providers ?? [];
  const passkeys = config?.passkeys ?? false;
  const withPassword = config?.password ?? true;
  const others = passkeys || providers.length > 0;
  const nextQuery = next === "/" ? "" : `?next=${encodeURIComponent(next)}`;

  return (
    <AuthLayout
      title={t("auth.signIn.title")}
      footer={
        <>
          {withPassword && (
            <p>
              <TextLink to="/reset">{t("auth.signIn.forgot")}</TextLink>
            </p>
          )}
          {config?.registration && (
            <p>
              {t("auth.signIn.new")} <TextLink to={`/register${nextQuery}`}>{t("auth.signIn.register")}</TextLink>
            </p>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <FormNotice>{notice}</FormNotice>
        {withPassword && (
          <form onSubmit={submit} className="flex flex-col gap-3.5">
            <FormField label={t("auth.email")} htmlFor="email">
              <Input
                id="email"
                type="email"
                autoComplete="username"
                autoFocus
                required
                className="h-10 text-base"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </FormField>
            <FormField label={t("auth.password")} htmlFor="password">
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                className="h-10 text-base"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </FormField>
            <FormError>{error}</FormError>
            <Button type="submit" variant="primary" size="lg" disabled={busy} className="mt-1 w-full">
              {busy ? t("auth.signIn.busy") : t("auth.signIn.submit")}
            </Button>
          </form>
        )}
        {!withPassword && <FormError>{error}</FormError>}
        {others && (
          <div className="flex flex-col gap-2">
            {withPassword && <OrLine>{t("auth.or")}</OrLine>}
            {passkeys && <PasskeyButton onError={setError} />}
            <ProviderButtons providers={providers} query={`next=${encodeURIComponent(next)}`} />
          </div>
        )}
        {config && !withPassword && !others && <p className="text-sm text-ink-2">{t("auth.signIn.noWay")}</p>}
      </div>
    </AuthLayout>
  );
}
