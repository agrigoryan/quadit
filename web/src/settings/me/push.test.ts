// Push on this device (settings/me/push.ts), as the settings page shows it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { pushState } from "@/settings/me/push";

afterEach(() => void vi.unstubAllGlobals());

describe("pushState", () => {
  it("in the Quadit desktop app, says the app shows notifications itself", async () => {
    vi.stubGlobal("window", { quaditDesktop: { version: "0.1.0", notify() {}, setBadge() {} } });
    expect(await pushState()).toBe("app");
  });

  it("where the browser cannot receive push, says so", async () => {
    vi.stubGlobal("window", {});
    expect(await pushState()).toBe("unsupported");
  });
});
