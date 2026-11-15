// Install settings as the admin area reads and saves them. GET
// /api/v1/admin/settings is read once into the query cache and shared (the
// frame waits for it); a page asks for one setting by name and gets its
// value, whether the environment locks it, and a way to save it.

import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { adminKeys } from "@/admin/data";
import { api } from "@/data/api";
import { queryClient } from "@/data/query";
import { type FieldErrors, useFieldErrors } from "@/ui/form";

interface SettingEntry {
  value?: unknown;
  /** Set by an environment variable, which wins: shown locked. */
  from_env: boolean;
}

export type SettingsMap = Record<string, SettingEntry>;

/** What a stored secret comes back as. Sent back unchanged, the server keeps the stored value. */
export const MASK = "********";

const PATH = "/api/v1/admin/settings";

/** Every install setting. `enabled` false asks nothing (the server answers install admins only). */
export const useSettings = (enabled = true) =>
  useQuery({
    queryKey: adminKeys.settings,
    queryFn: ({ signal }) => api.get<{ settings: SettingsMap }>(PATH, signal).then((r) => r.settings),
    enabled,
  });

const NO_SETTINGS: SettingsMap = {};

/** The environment variable that sets a setting: "auth.google" is QUADIT_SETTING_AUTH_GOOGLE. */
const envName = (setting: string) => `QUADIT_SETTING_${setting.replace(/\./g, "_").toUpperCase()}`;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface Setting<T> {
  /** The stored value; `fallback` when nothing is stored. An object is laid over the fallback's fields. */
  value: T;
  locked: boolean;
  /** The variable to change when it is locked. */
  env: string;
  /** Saves, and every setting is shown as the server's answer has it. Throws the server's refusal. */
  save: (value: T | null) => Promise<void>;
}

/** One install setting: useSetting("auth.registration", false). Read inside the admin frame, which waits for the settings. */
export function useSetting<T>(name: string, fallback: T): Setting<T> {
  const settings = useSettings().data ?? NO_SETTINGS;
  const entry = settings[name];
  const stored = entry?.value;
  // The fallback the caller first gave: a literal written in its render is new each time.
  const [fb] = useState(fallback);
  const value = useMemo(() => {
    if (stored === undefined || stored === null) return fb;
    return (isObject(fb) && isObject(stored) ? { ...fb, ...stored } : stored) as T;
  }, [stored, fb]);
  const { mutateAsync } = useMutation({
    mutationFn: (next: T | null) => api.put<{ settings: SettingsMap }>(`${PATH}/${encodeURIComponent(name)}`, next),
    onSuccess: (out) => queryClient.setQueryData(adminKeys.settings, out.settings),
  });
  const save = useCallback(
    async (next: T | null) => {
      await mutateAsync(next);
    },
    [mutateAsync],
  );
  return { value, locked: entry?.from_env ?? false, env: envName(name), save };
}

export interface Draft<T> extends Setting<T> {
  draft: T;
  /** Changes the draft: a whole value, or some fields of an object. */
  set: (next: Partial<T> | T) => void;
  dirty: boolean;
  busy: boolean;
  /** True for a moment after a save went through. */
  saved: boolean;
  errors: FieldErrors;
  submit: () => Promise<boolean>;
}

interface DraftOptions<T> {
  /** Checks the draft in the browser: field name to message, for whatever is wrong. */
  validate?: (draft: T) => Record<string, string | undefined>;
  /** Shapes the draft into what is sent (drop fields of another kind, trim). */
  toValue?: (draft: T) => T | null;
}

/** A setting being edited in a form: nothing is saved until submit(). */
export function useDraft<T>(name: string, fallback: T, opts: DraftOptions<T> = {}): Draft<T> {
  const setting = useSetting(name, fallback);
  const [draft, setDraft] = useState<T>(setting.value);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  // Server refusals about settings name no field of ours: they go above the buttons.
  const errors = useFieldErrors(["-"]);
  // A save (here or of another setting) hands back fresh values: start again from them.
  const [base, setBase] = useState(setting.value);
  if (base !== setting.value) {
    setBase(setting.value);
    setDraft(setting.value);
  }

  const set = useCallback((next: Partial<T> | T) => {
    setSaved(false);
    setDraft((cur) => (isObject(cur) && isObject(next) ? { ...cur, ...next } : (next as T)));
  }, []);

  const dirty = JSON.stringify(draft) !== JSON.stringify(setting.value);

  const { save } = setting;
  const { clear, set: setError, fail } = errors;
  async function submit() {
    clear();
    const wrong = opts.validate?.(draft) ?? {};
    const found = Object.entries(wrong).filter((pair): pair is [string, string] => !!pair[1]);
    if (found.length > 0) {
      for (const [field, message] of found) setError(field, message);
      return false;
    }
    setBusy(true);
    try {
      await save(opts.toValue ? opts.toValue(draft) : draft);
      setSaved(true);
      return true;
    } catch (err) {
      fail(err);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { ...setting, draft, set, dirty, busy, saved, errors, submit };
}
