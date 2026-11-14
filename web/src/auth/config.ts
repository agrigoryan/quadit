// What the sign-in pages may offer on this install: its name, which ways of
// signing in are on, and whether anyone may register. Asked once and kept,
// then refreshed each time a sign-in page opens.

import { useEffect } from "react";
import { create } from "zustand";
import { type AuthConfig, authConfig, useSession } from "@/auth/session";

const useConfig = create<{ config: AuthConfig | null }>(() => ({ config: null }));

let asking: Promise<void> | null = null;

function refresh(): Promise<void> {
  asking ??= authConfig()
    .then((config) => useConfig.setState({ config }))
    .catch(() => {})
    .finally(() => {
      asking = null;
    });
  return asking;
}

/** The install's sign-in options; null until the server has answered once. */
export function useAuthConfig(): AuthConfig | null {
  const config = useConfig((s) => s.config);
  useEffect(() => {
    void refresh();
  }, []);
  return config;
}

/**
 * Whether the person signed in may make a workspace: an install admin
 * always, anyone else unless the install keeps that to its admins. Until the
 * server has said which, only admins are offered it.
 */
export function useCanCreateWorkspace(): boolean {
  const config = useAuthConfig();
  const isAdmin = useSession((s) => !!s.user?.is_admin);
  return isAdmin || config?.anyone_can_create_workspaces === true;
}

/**
 * Where to go after signing in: only a path inside this app, so a crafted
 * link cannot send someone to another site.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  if (next.startsWith("/login") || next.startsWith("/api/")) return "/";
  return next;
}

/** The address a workspace would get from its name; the same rule as the server's. */
export function slugFrom(name: string): string {
  let out = "";
  for (const ch of name.trim().toLowerCase()) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) out += ch;
    else if (out.length > 0 && !out.endsWith("-")) out += "-";
  }
  out = out.replace(/^-+|-+$/g, "");
  if (out.length > 40) out = out.slice(0, 40).replace(/^-+|-+$/g, "");
  return out.length < 2 ? "team" : out;
}
