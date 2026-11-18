// A browser's user-agent string, cut down to what a person recognises.

import { t } from "@/lib/i18n";

const browsers: [RegExp, string][] = [
  // The desktop app's windows are Chrome inside; they say what they are at the end.
  [/ QuaditDesktop\//, "Quadit desktop"],
  [/Edg(e|A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/HeadlessChrome\//, "Chrome (headless)"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Safari\//, "Safari"],
  [/^curl\//, "curl"],
  [/^quadit/i, "Quadit CLI"],
  [/python|Go-http-client|node/i, "A script"],
];

const systems: [RegExp, string][] = [
  [/iPhone|iPod/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/Windows/, "Windows"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/CrOS/, "ChromeOS"],
  [/Linux/, "Linux"],
];

/** "Chrome on macOS" from a user-agent string; the string itself, shortened, when nothing is recognised. */
export function summariseAgent(ua: string | undefined): string {
  if (!ua) return "";
  const browser = browsers.find(([re]) => re.test(ua))?.[1];
  const system = systems.find(([re]) => re.test(ua))?.[1];
  if (browser && system) return t("me.agent.on", { browser, system });
  return browser ?? system ?? (ua.length > 40 ? `${ua.slice(0, 40)}…` : ua);
}
