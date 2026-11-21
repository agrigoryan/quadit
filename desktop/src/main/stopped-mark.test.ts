import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StoppedMark } from "@/main/stopped-mark";

describe("StoppedMark", () => {
  it("is an empty server-stopped file beside the quadit logins, there from a stop on purpose until a start", async () => {
    const logins = join(mkdtempSync(join(tmpdir(), "quadit-desktop-mark-")), "quadit");
    const mark = new StoppedMark(async () => logins);
    expect(await mark.isSet()).toBe(false);
    await mark.set();
    expect(existsSync(join(logins, "server-stopped"))).toBe(true);
    expect(await mark.isSet()).toBe(true);
    await mark.clear();
    expect(existsSync(join(logins, "server-stopped"))).toBe(false);
    // Cleared when it is not there: nothing to do.
    await mark.clear();
    expect(await mark.isSet()).toBe(false);
  });

  it("does nothing where the folder cannot be known (no quadit to ask), and asks again later", async () => {
    let folder: string | null = null;
    const logins = join(mkdtempSync(join(tmpdir(), "quadit-desktop-mark-")), "quadit");
    let asked = 0;
    const mark = new StoppedMark(async () => {
      asked++;
      return folder;
    });
    await mark.set();
    expect(await mark.isSet()).toBe(false);
    folder = logins;
    await mark.set();
    expect(await mark.isSet()).toBe(true);
    // Once known, it is not asked again.
    const before = asked;
    await mark.clear();
    expect(asked).toBe(before);
  });
});
