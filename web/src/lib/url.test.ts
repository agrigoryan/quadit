// What lib/url.ts makes of addresses a person typed.

import { describe, expect, it } from "vitest";
import { githubRepo, isWebAddress } from "@/lib/url";

describe("githubRepo", () => {
  it("takes owner/name as it is, or out of a github.com address", () => {
    expect(githubRepo(" acme/game ")).toBe("acme/game");
    expect(githubRepo("https://github.com/acme/game.git")).toBe("acme/game");
    expect(githubRepo("HTTPS://GitHub.com/acme/game/")).toBe("acme/game");
  });

  it("refuses anything else", () => {
    expect(githubRepo("acme")).toBeNull();
    expect(githubRepo("https://gitlab.com/acme/game")).toBeNull();
    expect(githubRepo("acme/game/tree/main")).toBeNull();
  });
});

describe("isWebAddress", () => {
  it("takes an http or https address, around spaces", () => {
    expect(isWebAddress(" https://example.com/hook ")).toBe(true);
    expect(isWebAddress("HTTP://example.com")).toBe(true);
  });

  it("refuses another scheme, no scheme, or a space inside", () => {
    expect(isWebAddress("ftp://example.com")).toBe(false);
    expect(isWebAddress("example.com")).toBe(false);
    expect(isWebAddress("https://exa mple.com")).toBe(false);
  });
});
