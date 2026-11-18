// @vitest-environment jsdom
// Which theme a page shows (lib/theme.ts): dark until someone chooses, the
// device's own choice until the account has one, and the account's after.

import { afterEach, describe, expect, it, vi } from "vitest";

/** lib/theme.ts as a page loads it, with `stored` as this device's kept choice. */
async function load(stored?: string) {
  if (stored) localStorage.setItem("quadit.theme", stored);
  vi.resetModules();
  return import("@/lib/theme");
}

const shown = () => document.documentElement.dataset.theme;

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("the theme", () => {
  it("is dark on a device where nobody has chosen, for an account without a choice", async () => {
    const theme = await load();
    theme.adoptAccountTheme("");
    expect(shown()).toBe("dark");
  });

  it("is the device's own choice while the account has none", async () => {
    const theme = await load("light");
    theme.adoptAccountTheme("");
    expect(shown()).toBe("light");
  });

  it("is the account's choice, system too, over the device's", async () => {
    const theme = await load("dark");
    theme.adoptAccountTheme("light");
    expect(shown()).toBe("light");
    theme.adoptAccountTheme("system");
    // jsdom has no matchMedia: the system prefers light.
    expect(shown()).toBe("light");
    expect(localStorage.getItem("quadit.theme")).toBe("system");
  });

  it("keeps a choice made by hand, system included, as the device's own", async () => {
    const theme = await load();
    theme.applyTheme("system");
    expect(localStorage.getItem("quadit.theme")).toBe("system");
    const again = await load();
    again.adoptAccountTheme(undefined);
    expect(shown()).toBe("light");
  });
});
