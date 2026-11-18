// What a browser's user agent is called in the list of devices signed in
// (settings/me/user-agent.ts).

import { describe, expect, it } from "vitest";
import { summariseAgent } from "@/settings/me/user-agent";

const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

describe("summariseAgent", () => {
  it("names a browser and its system", () => {
    expect(summariseAgent(MAC_CHROME)).toBe("Chrome on macOS");
  });

  it("names the Quadit desktop app, whose windows say so at the end", () => {
    expect(summariseAgent(`${MAC_CHROME} Electron/39.0.0 QuaditDesktop/0.1.0`)).toBe("Quadit desktop on macOS");
  });
});
