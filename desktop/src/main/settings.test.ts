import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Settings } from "@/main/settings";

function file() {
  return join(mkdtempSync(join(tmpdir(), "quadit-desktop-settings-")), "settings.json");
}

describe("Settings", () => {
  it("starts from the defaults without a file, and with a damaged one", () => {
    const defaults = {
      setupDone: false,
      captureShortcut: true,
      lastCapture: null,
      localPort: null,
      pendingFirstRun: null,
    };
    expect(new Settings(file()).get()).toEqual(defaults);
    const damaged = file();
    writeFileSync(damaged, "{not json");
    expect(new Settings(damaged).get()).toEqual(defaults);
  });

  it("keeps the local server's port across restarts, in a file only the person may read", () => {
    const path = file();
    new Settings(path).change({ localPort: 4780 });
    expect(new Settings(path).get().localPort).toBe(4780);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ localPort: 4780 });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("reads a port that is not one as none", () => {
    for (const localPort of [0, 70_000, 4780.5, "4780", -1]) {
      const path = file();
      writeFileSync(path, JSON.stringify({ localPort }));
      expect(new Settings(path).get().localPort, String(localPort)).toBeNull();
    }
  });

  it("keeps a first run owed across restarts, and reads one that is not whole as none", () => {
    const path = file();
    const pending = { serverId: "abc", workspace: "personal", person: "Lou" };
    new Settings(path).change({ pendingFirstRun: pending });
    expect(new Settings(path).get().pendingFirstRun).toEqual(pending);
    writeFileSync(path, JSON.stringify({ pendingFirstRun: { serverId: "abc" } }));
    expect(new Settings(path).get().pendingFirstRun).toBeNull();
  });
});
