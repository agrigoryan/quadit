import { type FormEvent, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { AuthLayout, FormError, OrLine, TextLink } from "@/auth/auth-layout";
import { useAuthConfig } from "@/auth/config";
import { ProviderButtons } from "@/auth/providers";
import { loadSession, signOut, useSession } from "@/auth/session";
import { api, errorMessage } from "@/lib/api";
import { t, tMaybe } from "@/lib/i18n";
import type { Role } from "@/lib/types";
import { FormField, useFieldErrors, useSubmit } from "@/settings/ui/form";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Loading } from "@/ui/spinner";

interface InviteInfo {
  workspace: { name: string; slug: string };
  role: Role;
  /** The one address the invitation is for; empty when it is a link anyone may use. */
  email?: string;
  invited_by: string;
  /** For an invitation by email: whether that address already has an account here. */
  has_account?: boolean;
}

interface Accepted {
  workspace: { slug: string };
}

/**
 * The page an invitation link opens. It says who invited you to what, then
 * lets you join as the person signed in, or make an account, or go through
 * an outside account the install accepts.
 */
export function InvitePage() {
  const { token = "" } = useParams();
  const status = useSession((s) => s.status);
  const user = useSession((s) => s.user);
  const config = useAuthConfig();
  const navigate = useNavigate();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  /** The invitation was used, revoked or has run out. */
  const [gone, setGone] = useState("");
  const path = `/api/v1/auth/invite/${encodeURIComponent(token)}`;

  useEffect(() => {
    api
      .get<InviteInfo>(path)
      .then(setInfo)
      .catch((err: unknown) => setGone(errorMessage(err)));
  }, [path]);

  async function joined(out: Accepted) {
    await loadSession();
    navigate(`/${out.workspace.slug}`, { replace: true });
  }

  if (gone) {
    return (
      <AuthLayout
        title={t("auth.invite.goneTitle")}
        footer={
          <p>
            <TextLink to={status === "in" ? "/" : "/login"}>
              {status === "in" ? t("auth.invite.toApp") : t("auth.backToSignIn")}
            </TextLink>
          </p>
        }
      >
        <FormError>{gone}</FormError>
      </AuthLayout>
    );
  }
  if (!info || status === "unknown" || !config) return <Loading />;

  const role = tMaybe(`role.${info.role}`, info.role).toLowerCase();
  const lead = info.invited_by
    ? t("auth.invite.lead", { who: info.invited_by, role })
    : t("auth.invite.leadNobody", { role });
  const title = t("auth.invite.title", { workspace: info.workspace.name });
  const here = `/invite/${token}`;

  if (status === "in" && user) {
    return (
      <AuthLayout title={title} lead={lead}>
        <JoinAsMe path={path} name={user.name} email={user.email} onJoined={joined} />
      </AuthLayout>
    );
  }

  const signInLink = (
    <p>
      {t("auth.register.have")}{" "}
      <TextLink to={`/login?next=${encodeURIComponent(here)}`}>{t("auth.invite.signIn")}</TextLink>
    </p>
  );
  const providers = config.providers.length > 0 && (
    <div className="flex flex-col gap-2">
      <ProviderButtons providers={config.providers} query={`invite=${encodeURIComponent(token)}`} />
    </div>
  );

  // The address already has an account: joining means signing in to it.
  if (info.has_account) {
    return (
      <AuthLayout title={title} lead={lead}>
        <div className="flex flex-col gap-3.5">
          <p className="text-sm text-ink-2">{t("auth.invite.hasAccount", { email: info.email ?? "" })}</p>
          <Button
            variant="primary"
            size="lg"
            className="w-full"
            onClick={() => navigate(`/login?next=${encodeURIComponent(here)}`)}
          >
            {t("auth.invite.signInToJoin")}
          </Button>
          {providers}
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={title} lead={lead} footer={signInLink}>
      {config.password ? (
        <NewAccount path={path} email={info.email} onJoined={joined} />
      ) : (
        <p className="text-sm text-ink-2">{t("auth.invite.providerOnly")}</p>
      )}
      {providers && (
        <>
          {config.password && <OrLine>{t("auth.or")}</OrLine>}
          <div className={config.password ? "" : "mt-3.5"}>{providers}</div>
        </>
      )}
    </AuthLayout>
  );
}

interface JoinProps {
  path: string;
  onJoined: (out: Accepted) => Promise<void>;
}

/** Signed in already: one button, and a way out for someone on the wrong account. */
function JoinAsMe({ path, name, email, onJoined }: JoinProps & { name: string; email?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function join() {
    setBusy(true);
    setError("");
    try {
      await onJoined(await api.post<Accepted>(path));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3.5">
      <p className="text-sm text-ink-2">{t("auth.invite.signedInAs", { name, email: email ?? "" })}</p>
      <FormError>{error}</FormError>
      <Button variant="primary" size="lg" className="w-full" disabled={busy} onClick={() => void join()}>
        {busy ? t("auth.invite.joining") : t("auth.invite.joinAs", { name })}
      </Button>
      <button
        type="button"
        onClick={() => void signOut()}
        className="self-start text-sm font-medium text-accent-text underline-offset-2 hover:underline"
      >
        {t("auth.invite.otherAccount")}
      </button>
    </div>
  );
}

/** Not signed in and no account yet: a name and a password make one, already in the workspace. */
function NewAccount({ path, email, onJoined }: JoinProps & { email?: string }) {
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const errors = useFieldErrors(["name", "email", "password"]);
  const { busy, run } = useSubmit(errors, { once: true });
  const set = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      await onJoined(
        await api.post<Accepted>(path, { name: form.name, email: email || form.email, password: form.password }),
      );
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3.5">
      <FormField label={t("auth.setup.name")} htmlFor="name" error={errors.fields.name}>
        <Input
          id="name"
          autoComplete="name"
          autoFocus
          required
          className="h-10 text-base"
          value={form.name}
          onChange={set("name")}
        />
      </FormField>
      <FormField
        label={t("auth.email")}
        htmlFor="email"
        error={errors.fields.email}
        hint={email ? t("auth.invite.emailFixed") : undefined}
      >
        {email ? (
          <Input
            id="email"
            type="email"
            autoComplete="username"
            readOnly
            className="h-10 !bg-sunken text-base !text-ink-2"
            value={email}
          />
        ) : (
          <Input
            id="email"
            type="email"
            autoComplete="username"
            required
            className="h-10 text-base"
            value={form.email}
            onChange={set("email")}
          />
        )}
      </FormField>
      <FormField
        label={t("auth.password")}
        htmlFor="password"
        hint={t("auth.setup.passwordHint")}
        error={errors.fields.password}
      >
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          required
          className="h-10 text-base"
          value={form.password}
          onChange={set("password")}
        />
      </FormField>
      <FormError>{errors.form}</FormError>
      <Button type="submit" variant="primary" size="lg" disabled={busy} className="mt-1 w-full">
        {busy ? t("auth.invite.joining") : t("auth.invite.createAndJoin")}
      </Button>
    </form>
  );
}
