import { useEffect, useState } from "react";

type Theme = "light" | "dark";

const read = (): Theme => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

/** The theme in force (lib/theme.ts keeps it on <html data-theme>), followed live. */
export function useThemeName(): Theme {
  const [theme, setTheme] = useState<Theme>(read);
  useEffect(() => {
    const watch = new MutationObserver(() => setTheme(read()));
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => watch.disconnect();
  }, []);
  return theme;
}
