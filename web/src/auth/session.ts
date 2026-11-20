// Who is signed in, and which workspaces they belong to.

import { create } from "zustand";
import { registerServiceWorker } from "@/auth/pwa";
import { getPasskey } from "@/auth/webauthn";
import { api, ApiError, onUnauthorized } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { clearUndo } from "@/data/undo";
import { clearStore } from "@/data/store";
import { stopSync } from "@/data/sync";
import { adoptAccountTheme, applyTheme, type ThemeChoice } from "@/lib/theme";
import type { Role, User } from "@/types/core";

interface Membership {
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
  /** The first step of sign-in is done and the second (a code) is still owed. */
  half: boolean;
}

interface MeResponse {
  user: User;
  workspaces: Membership[];
}

export const useSession = create<SessionState>(() => ({ status: "unknown", user: null, workspaces: [], half: false }));

function signedOut() {
  stopSync();
  clearStore();
  useSession.setState({ status: "out", user: null, workspaces: [] });
}

// Any call that answers 401 ends the session; the router then shows /login.
// One that says the second step is owed (an install that requires two steps
// asks a session that signed in with one for it) shows that step there.
onUnauthorized((code) => {
  signedOut();
  useSession.setState({ half: code === "second_step" });
});

/** Asks the server who is signed in. Safe to call again after sign-in. */
export async function loadSession(): Promise<void> {
  void registerServiceWorker();
  try {
    const me = await api.get<MeResponse>("/api/v1/auth/me");
    useSession.setState({ status: "in", user: me.user, workspaces: me.workspaces, half: false });
    adoptAccountTheme(me.user.theme);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      // onUnauthorized has run. A session that still owes its second step says so.
      useSession.setState({ half: err.code === "second_step" });
      return;
    }
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
  /** False when only install admins may make workspaces. */
  anyone_can_create_workspaces?: boolean;
  /** Everyone must have a second step before their workspaces open. */
  require_2fa?: boolean;
  /** Whether the install can send mail (reset links, invitations, digests). */
  mail?: boolean;
  /** The desktop app runs this install and sets it up itself: the set-up page has no form. */
  setup_by_app?: boolean;
}

export const authConfig = () => api.get<AuthConfig>("/api/v1/auth/config");

/** The key the sign-in options are read under where a page waits for them (the set-up page). */
export const authConfigKey = ["auth", "config"] as const;

/** Signs in. Answers "second_step" when the account has a second step turned on. */
export async function signIn(email: string, password: string): Promise<"ok" | "second_step"> {
  const out = await api.post<{ second_step?: boolean }>("/api/v1/auth/login", { email, password }, { quiet401: true });
  if (out?.second_step) {
    useSession.setState({ half: true });
    return "second_step";
  }
  await loadSession();
  return "ok";
}

/** How a session that owes its second step may give it: a code from the app, a passkey, or both. */
export interface SecondStepWays {
  code: boolean;
  passkey: boolean;
}

export const secondStepWays = () => api.get<SecondStepWays>("/api/v1/auth/second-step");

/** Finishes a sign-in with a code from the authenticator app, or a recovery code. */
export async function secondStep(code: string): Promise<void> {
  await api.post("/api/v1/auth/second-step", { code: code.trim() }, { quiet401: true });
  await loadSession();
}

/** Signs in with a passkey: the browser asks which one, and it says who this is. */
export async function passkeySignIn(): Promise<"ok" | "second_step"> {
  const start = await api.post<{ options: { publicKey: Record<string, unknown> }; state: string }>(
    "/api/v1/auth/passkeys/login/start",
  );
  const credential = await getPasskey(start.options);
  const out = await api.post<{ second_step?: boolean }>(
    `/api/v1/auth/passkeys/login/finish?state=${encodeURIComponent(start.state)}`,
    credential,
    { quiet401: true },
  );
  if (out?.second_step) {
    useSession.setState({ half: true });
    return "second_step";
  }
  await loadSession();
  return "ok";
}

/** Makes an account on an install with open registration; the person is then signed in. */
export async function register(input: { name: string; email: string; password: string }): Promise<void> {
  await api.post("/api/v1/auth/register", input);
  await loadSession();
}

/** Makes another workspace, owned by the person signed in. Returns its slug. */
export async function createWorkspace(name: string, slug?: string): Promise<string> {
  const ws = await api.post<{ slug: string }>("/api/v1/workspaces", {
    name: name.trim(),
    slug: slug?.trim() || undefined,
  });
  await loadSession();
  return ws.slug;
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
    // Changes not yet sent are dropped with the session: the next person here must not send them.
    void clearOutbox();
    clearUndo();
    signedOut();
    useSession.setState({ half: false });
  }
}

/** Applies a theme picked by hand at once and saves it to the profile (see lib/theme.ts for how the two meet). */
export async function saveTheme(theme: ThemeChoice) {
  applyTheme(theme);
  const user = useSession.getState().user;
  if (user) useSession.setState({ user: { ...user, theme } });
  await api.patch("/api/v1/auth/me", { theme });
}
