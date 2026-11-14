// Every word the interface shows goes through t(), so the app is ready to be
// translated: add a dictionary beside i18n/en and switch `current`.
//
//   t("task.count", { n: 3 })   // "3 tasks"
//
// A value may hold {name} placeholders. A value written as "one | other" is
// a plural: the first form is used when the `n` parameter is 1.

import { en } from "@/i18n/en";

export type Key = keyof typeof en;
type Params = Record<string, string | number>;

const current: Record<Key, string> = en;

export function t(key: Key, params?: Params): string {
  let text: string = current[key] ?? key;
  if (text.includes(" | ")) {
    const [one, other] = text.split(" | ");
    text = (params?.n === 1 ? one : other) ?? text;
  }
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/** For keys built at run time ("category." + c). Falls back to the fallback text, or the key. */
export function tMaybe(key: string, fallback?: string): string {
  return key in current ? current[key as Key] : (fallback ?? key);
}
