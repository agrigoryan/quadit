import { type ReactNode, useEffect } from "react";
import { Link } from "react-router";
import { useAuthConfig } from "@/auth/config";
import { QuadMark } from "@/ui/icons";

interface Props {
  title: string;
  lead?: ReactNode;
  children: ReactNode;
  /** Links under the form: "Forgot password?", "Back to sign in". */
  footer?: ReactNode;
}

/** The frame around the sign-in, set-up, invitation and reset forms. It carries the install's own name. */
export function AuthLayout({ title, lead, children, footer }: Props) {
  const config = useAuthConfig();
  const name = config?.name || "Quadit";

  useEffect(() => {
    document.title = config ? `${title} – ${name}` : title;
  }, [title, name, config]);

  return (
    <main className="flex min-h-dvh items-start justify-center overflow-y-auto bg-canvas px-4 pt-[12vh] pb-10 max-sm:pt-10">
      <div className="w-full max-w-[22rem]">
        <div className="mb-6 flex h-7 items-center gap-2.5">
          <QuadMark size={28} />
          {/* Blank until the name is known, so a renamed install never flashes "Quadit". */}
          <span className="min-w-0 truncate text-lg font-semibold tracking-tight">{config ? name : ""}</span>
        </div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {lead && <p className="mt-1 text-sm text-ink-2">{lead}</p>}
        <div className="mt-6">{children}</div>
        {footer && <div className="mt-6 flex flex-col gap-1.5 text-sm text-ink-2">{footer}</div>}
      </div>
    </main>
  );
}

export function FormError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-md bg-danger-soft px-2.5 py-2 text-sm text-danger first-letter:uppercase">
      {children}
    </p>
  );
}

/** Good news above a form: "Password changed". */
export function FormNotice({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <output className="block rounded-md bg-ok-soft px-2.5 py-2 text-sm text-ok">{children}</output>;
}

/** A link in the words around a form. */
export function TextLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="font-medium text-accent-text underline-offset-2 hover:underline">
      {children}
    </Link>
  );
}

/** "or", between two ways of doing the same thing. */
export function OrLine({ children }: { children: ReactNode }) {
  return (
    <div className="my-2 flex items-center gap-3 text-xs text-ink-3" role="separator">
      <span className="h-px flex-1 bg-line-strong" />
      {children}
      <span className="h-px flex-1 bg-line-strong" />
    </div>
  );
}
