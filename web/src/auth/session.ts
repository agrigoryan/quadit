// Who is signed in, and which workspaces they belong to.

import { create } from "zustand";
import { api, ApiError, onUnauthorized } from "@/lib/api";
import { clearStore } from "@/lib/store";
import { stopSync } from "@/lib/sync";
import { applyTheme, type ThemeChoice, toThemeChoice } from "@/lib/theme";
import type { Role, User } from "@/lib/types";

export interface Membership {
  id: string;
  slug: string;
  name: string;
  icon?: string;
  role: Role;
  handle: string;
}

interface SessionState {
  /** "unknown" until the first answer from the server. */
  status: "unknown" | "in" | "out";
  user: User | null;
  workspaces: Membership[];
}

interface MeResponse {
  user: User;
  workspaces: Membership[];
}

export const useSession = create<SessionState>(() => ({ status: "unknown", user: null, workspaces: [] }));

function signedOut() {
  stopSync();
  clearStore();
  useSession.setState({ status: "out", user: null, workspaces: [] });
}

// Any call that answers 401 ends the session; the router then shows /login.
onUnauthorized(signedOut);

/** Asks the server who is signed in. Safe to call again after sign-in. */
export async function loadSession(): Promise<void> {
  try {
    const me = await api.get<MeResponse>("/api/v1/auth/me");
    useSession.setState({ status: "in", user: me.user, workspaces: me.workspaces });
    applyTheme(toThemeChoice(me.user.theme));
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return; // onUnauthorized has run
    throw err;
  }
}

export interface AuthConfig {
  setup_needed: boolean;
  password: boolean;
  passkeys: boolean;
  registration: boolean;
  name: string;
  providers: { id: string; name: string }[];
}

export const authConfig = () => api.get<AuthConfig>("/api/v1/auth/config");

/** Signs in. Answers "second_step" when the account has a second step turned on. */
export async function signIn(email: string, password: string): Promise<"ok" | "second_step"> {
  const out = await api.post<{ second_step?: boolean }>("/api/v1/auth/login", { email, password }, { quiet401: true });
  if (out?.second_step) return "second_step";
  await loadSession();
  return "ok";
}

export interface SetupInput {
  name: string;
  email: string;
  password: string;
  workspace_name: string;
}

/** Makes the first person and workspace on a new install, signed in. Returns the workspace slug. */
export async function setUp(input: SetupInput): Promise<string> {
  const out = await api.post<{ workspace: { slug: string } }>("/api/v1/auth/setup", input);
  await loadSession();
  return out.workspace.slug;
}

export async function signOut() {
  try {
    await api.post("/api/v1/auth/logout");
  } finally {
    signedOut();
  }
}

/** Saves the theme to the profile, applying it at once. */
export async function saveTheme(theme: ThemeChoice) {
  applyTheme(theme);
  const user = useSession.getState().user;
  if (user) useSession.setState({ user: { ...user, theme } });
  await api.patch("/api/v1/auth/me", { theme });
}
