// Light, dark, or whatever the system says. The choice is kept in the
// person's profile (so it follows them) and in localStorage (so the page
// paints right before the profile has loaded; see index.html).

export type ThemeChoice = "system" | "light" | "dark";

const KEY = "quadit.theme";
const dark = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
let choice: ThemeChoice = "system";

const resolve = (c: ThemeChoice) => (c === "system" ? (dark?.matches ? "dark" : "light") : c);

export function toThemeChoice(value: string | undefined | null): ThemeChoice {
  return value === "light" || value === "dark" ? value : "system";
}

export function storedTheme(): ThemeChoice {
  try {
    return toThemeChoice(localStorage.getItem(KEY));
  } catch {
    return "system";
  }
}

export function applyTheme(next: ThemeChoice) {
  choice = next;
  document.documentElement.dataset.theme = resolve(next);
  try {
    if (next === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    // Private mode: the theme still applies for this visit.
  }
}

dark?.addEventListener("change", () => {
  if (choice === "system") document.documentElement.dataset.theme = resolve("system");
});
