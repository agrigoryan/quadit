// Light, dark, or whatever the system says. One rule decides it everywhere:
//
//   - The account's saved theme wins when there is one: it follows the
//     person to every browser they sign in on.
//   - Until the account has one, each device keeps its own choice: the one
//     last made on it (kept in localStorage, which is also what paints the
//     page before the profile has loaded; see public/theme.js), or else dark.
//
// Picking a theme by hand always applies it here and now and keeps it as
// this device's own choice.

import { create } from "zustand";

export type ThemeChoice = "system" | "light" | "dark";

const KEY = "quadit.theme";
const DEFAULT: ThemeChoice = "dark";
const dark = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;

const resolve = (c: ThemeChoice) => (c === "system" ? (dark?.matches ? "dark" : "light") : c);

function toThemeChoice(value: string | undefined | null): ThemeChoice | null {
  return value === "system" || value === "light" || value === "dark" ? value : null;
}

/** This device's own choice, as last made on it, or the default. */
function storedTheme(): ThemeChoice {
  try {
    return toThemeChoice(localStorage.getItem(KEY)) ?? DEFAULT;
  } catch {
    return DEFAULT;
  }
}

const useTheme = create<{ choice: ThemeChoice }>(() => ({ choice: storedTheme() }));

/** The choice in effect, for the controls that show it. */
export const useThemeChoice = () => useTheme((s) => s.choice);

/** Applies a choice made by hand and keeps it as this device's own. */
export function applyTheme(next: ThemeChoice) {
  useTheme.setState({ choice: next });
  document.documentElement.dataset.theme = resolve(next);
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Private mode: the theme still applies for this visit.
  }
}

/** Takes the account's theme on sign-in or reload; an account without one leaves this device as it is. */
export function adoptAccountTheme(value: string | undefined | null) {
  applyTheme(toThemeChoice(value) ?? storedTheme());
}

dark?.addEventListener("change", () => {
  if (useTheme.getState().choice === "system") document.documentElement.dataset.theme = resolve("system");
});
