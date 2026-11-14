// The signed-in person's own account, as GET /api/v1/auth/me returns it.
// The session store keeps only what the shell needs; these pages need the
// rest (second step, time zone, notification choices), so they ask again.

import { loadSession } from "@/auth/session";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import type { User } from "@/lib/types";
import { type Loaded, useLoad } from "@/settings/ui/use-load";

export type EmailChoice = "all" | "important" | "none";

export interface NotifyPrefs {
  /** Missing means "important". */
  email?: EmailChoice;
  /** Missing means on. */
  push?: boolean;
}

export interface AccountUser extends User {
  timezone?: string;
  /** When two-step verification was turned on; missing when it is off. */
  totp_at?: number;
  notify?: NotifyPrefs;
}

export interface Account {
  user: AccountUser;
  has_password: boolean;
  /** How many passkeys the account has. */
  passkeys: number;
}

const ME = "/api/v1/auth/me";

export const useAccount = (): Loaded<Account> => useLoad(() => api.get<Account>(ME), []);

/** Changes the profile and brings the session (name, avatar, theme in the shell) up to date. */
export async function saveAccount(fields: Partial<Pick<AccountUser, "name" | "avatar" | "timezone" | "notify">>): Promise<Account> {
  const out = await api.patch<Account>(ME, fields);
  await loadSession();
  // The feed updates the member row; the store's own copy of "me" (the top bar's avatar) is not fed, so set it here.
  useStore.setState((s) => (s.me ? { me: { ...s.me, name: out.user.name, avatar: out.user.avatar || undefined } } : s));
  return out;
}
