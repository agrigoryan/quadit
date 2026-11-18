// Every word the interface shows goes through t(), so the app is ready to be
// translated: add a dictionary beside i18n/en and switch `current`.
//
//   t("task.count", { n: 3 })   // "3 tasks"
//
// A value may hold {name} placeholders. A value written as "one | other" is
// a plural: the first form is used when the `n` parameter is 1.
//
// A number is written the way people write it ("116,445 tasks"). Give a
// string for a number that is a name and not an amount, like a cycle's.
//
// The lib folder: small modules that know neither the server's data, the
// router nor any screen, and import only types and i18n: words (this file),
// days and times, ranks, ids, class names, file addresses, what this
// browser remembers (kept.ts), colour swatches, Cmd-Enter, downloads; and
// the three app-wide bits of screen state any part may set: toasts, the
// theme and what is open (ui-state.ts).

import { en } from "@/i18n/en";

export type Key = keyof typeof en;
type Params = Record<string, string | number>;

const current: Record<Key, string> = en;

// The browser's language decides how numbers are grouped.
const grouped = new Intl.NumberFormat();

/** A number as people write it: 116445 as "116,445". */
export const formatNumber = (n: number) => grouped.format(n);

const listed = new Intl.ListFormat(undefined, { style: "long", type: "conjunction" });

/** "a", "a and b", "a, b, and c", as the reader's language lists things. */
export const joinPhrases = (parts: string[]): string => listed.format(parts);

export function t(key: Key, params?: Params): string {
  let text: string = current[key] ?? key;
  if (text.includes(" | ")) {
    const [one, other] = text.split(" | ");
    text = (params?.n === 1 ? one : other) ?? text;
  }
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (!(name in params)) return whole;
    const value = params[name];
    return typeof value === "number" ? formatNumber(value) : String(value);
  });
}

/** Whether the dictionary has a key built at run time ("inbox.type." + type), to give t() with its parameters. */
export const isKey = (key: string): key is Key => key in current;

/** For keys built at run time ("category." + c). Falls back to the fallback text, or the key. */
export function tMaybe(key: string, fallback?: string): string {
  return key in current ? current[key as Key] : (fallback ?? key);
}
