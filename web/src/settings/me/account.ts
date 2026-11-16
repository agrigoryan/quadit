// The signed-in person's own account, as GET /api/v1/auth/me returns it.
// The session store keeps only what the shell needs; these pages need the
// rest (second step, time zone, notification choices), so they ask again.
// Also the keys of every other read of the account under Me: they belong to
// no workspace.

import { useMutation, useQuery } from "@tanstack/react-query";
import { loadSession } from "@/auth/session";
import { api } from "@/data/api";
import { queryClient } from "@/data/query";
import { useStore } from "@/data/store";
import type { User } from "@/types/core";

export interface Account {
  user: User;
  has_password: boolean;
  /** How many passkeys the account has. */
  passkeys: number;
}

const ME = "/api/v1/auth/me";

export const accountKeys = {
  account: ["me", "account"],
  sessions: ["me", "sessions"],
  passkeys: ["me", "passkeys"],
  identities: ["me", "identities"],
} as const;

/** Something about the account changed (a password, a passkey, a second step): everything shown about it is asked again. */
export const accountChanged = () => void queryClient.invalidateQueries({ queryKey: ["me"] });

export const useAccount = () =>
  useQuery({ queryKey: accountKeys.account, queryFn: ({ signal }) => api.get<Account>(ME, signal) });

type AccountFields = Partial<Pick<User, "name" | "avatar" | "timezone" | "notify" | "email">> & {
  /** The current password, which a change of the sign-in address asks for. */
  password?: string;
};

/**
 * Changes the profile; the page shows the server's answer, and the session
 * (name, avatar, theme in the shell) is brought up to date. `mutateAsync`
 * throws a refusal for the form to show.
 */
export function useSaveAccount() {
  return useMutation({
    mutationFn: (fields: AccountFields) => api.patch<Account>(ME, fields),
    async onSuccess(out) {
      queryClient.setQueryData(accountKeys.account, out);
      await loadSession();
      // The feed updates the member row; the store's own copy of "me" (the top bar's avatar) is not fed, so set it here.
      useStore.setState((s) =>
        s.me ? { me: { ...s.me, name: out.user.name, avatar: out.user.avatar || undefined } } : s,
      );
    },
  });
}
