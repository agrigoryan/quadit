// The English dictionary is one object spread together from many files, so a
// key written in two files is not an error to the compiler: the file spread
// last wins, and the other part of the app shows words meant for elsewhere.

import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>("/src/i18n/en/*.ts", { query: "?raw", import: "default", eager: true });

describe("the English dictionary", () => {
  it("defines every key in one file only", () => {
    const files = new Map<string, string[]>();
    for (const [path, source] of Object.entries(sources)) {
      for (const [, key] of source.matchAll(/^\s*"([^"]+)":/gm)) {
        if (key) files.set(key, [...(files.get(key) ?? []), path.replace("/src/i18n/en/", "")]);
      }
    }
    const twice = [...files]
      .filter(([, where]) => where.length > 1)
      .map(([key, where]) => `${key}: ${where.join(", ")}`);
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    expect(twice).toEqual([]);
  });
});
