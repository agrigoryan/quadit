// @vitest-environment jsdom
// What this browser keeps between visits (lib/kept.ts): a value comes back
// as it was kept, and storage that is missing, refused or holds something
// else never throws but gives the fallback.

import { afterEach, describe, expect, it, vi } from "vitest";
import { keep, readKept } from "@/lib/kept";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("kept values", () => {
  it("come back as they were kept", () => {
    keep("test.open", { a: true });
    expect(readKept("test.open", {})).toEqual({ a: true });
  });

  it("give the fallback when nothing, or something that is not JSON, is kept", () => {
    expect(readKept("test.none", "weeks")).toBe("weeks");
    localStorage.setItem("test.raw", "collapsed");
    expect(readKept("test.raw", false)).toBe(false);
  });

  it("never throw where storage is refused", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => keep("test.open", true)).not.toThrow();
    expect(readKept("test.open", false)).toBe(false);
  });
});
