import type { ReactNode } from "react";
import { QuadMark } from "@/ui/icons";

/** The frame around the sign-in and set-up forms. */
export function AuthLayout({ title, lead, children }: { title: string; lead?: string; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-start justify-center bg-canvas px-4 pt-[14vh] pb-10">
      <div className="w-full max-w-[22rem]">
        <div className="mb-6 flex items-center gap-2.5">
          <QuadMark size={28} />
          <span className="text-lg font-semibold tracking-tight">Quadit</span>
        </div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {lead && <p className="mt-1 text-sm text-ink-2">{lead}</p>}
        <div className="mt-6">{children}</div>
      </div>
    </main>
  );
}

export function FormError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-md bg-danger-soft px-2.5 py-2 text-sm text-danger">
      {children}
    </p>
  );
}
