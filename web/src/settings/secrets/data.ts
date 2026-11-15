// The vault's list. It is not in the workspace's starting copy: the page
// fetches it into the store, and from then on the feed keeps it current
// (secret.created, secret.updated, secret.deleted). A value is sent to the
// server and never comes back.

import { useMemo } from "react";
import { api, ws } from "@/lib/api";
import { mutate } from "@/lib/mutate";
import { useCollection } from "@/lib/selectors";
import { getState, mergeRows } from "@/lib/store";
import type { Secret } from "@/lib/types";

/** Fetches every secret into the store. "Last used" is only as fresh as this call: using a secret is not an event. */
export async function loadSecrets(slug: string): Promise<true> {
  const out = await api.get<{ secrets?: Secret[] }>(ws(slug, "/list/secrets"));
  if (getState().slug === slug) mergeRows("secrets", out.secrets ?? []);
  return true;
}

/** The secrets that exist, by name. */
export function useSecrets(): Secret[] {
  const secrets = useCollection("secrets");
  return useMemo(
    () =>
      Object.values(secrets)
        .filter((s) => !s.deleted_at)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [secrets],
  );
}

// The same shapes the server checks (internal/engine/ch_secret.go).
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const HOST = /^(http:\/\/)?(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$/;

export const validName = (name: string) => NAME.test(name);

/**
 * A host as the server keeps it: lower case, no "https://" in front, no
 * slash at the end. Null when it is not a host ("api.example.com",
 * "*.example.com", or "http://host:port" for one without TLS).
 */
function cleanHost(text: string): string | null {
  const host = text
    .trim()
    .replace(/^https:\/\//i, "")
    .replace(/\/$/, "")
    .toLowerCase();
  return HOST.test(host) ? host : null;
}

/**
 * Turns typed text into hosts. Answers the list with the new ones added, or
 * the first piece that is not a host.
 */
export function addHosts(have: string[], text: string): { hosts: string[] } | { bad: string } {
  const hosts = [...have];
  for (const piece of text.split(/[\s,]+/).filter(Boolean)) {
    const host = cleanHost(piece);
    if (!host) return { bad: piece };
    if (!hosts.includes(host)) hosts.push(host);
  }
  return { hosts };
}

export interface SecretInput {
  name: string;
  /** Left out, the secret keeps the value it has. */
  value?: string;
  description: string;
  hosts: string[];
  /** User ids; none means every member. */
  agents: string[];
  env: boolean;
}

/** Makes a secret, or changes the one with that name. A refusal is thrown for the form to show. */
export function setSecret(input: SecretInput) {
  const args: Record<string, unknown> = {
    name: input.name,
    description: input.description,
    hosts: input.hosts,
    agents: input.agents,
    env: input.env,
  };
  if (input.value) args.value = input.value;
  return mutate({ type: "secret.set", args }, undefined, { quiet: true });
}

export const deleteSecret = (id: string) =>
  mutate({ type: "secret.delete", args: { id } }, (tx) => tx.patch("secrets", id, { deleted_at: Date.now() }), {
    quiet: true,
  });
