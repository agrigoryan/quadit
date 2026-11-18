import { describe, expect, it } from "vitest";
import { desktopRelease } from "./release-tag.mjs";

describe("desktopRelease", () => {
  it("reads a stable tag as no pre-release, though every desktop tag has a hyphen", () => {
    expect(desktopRelease("desktop-v0.1.0", "0.1.0")).toEqual({ version: "0.1.0", prerelease: false });
    expect(desktopRelease("desktop-v1.2.3+build.5", "1.2.3+build.5")).toEqual({
      version: "1.2.3+build.5",
      prerelease: false,
    });
  });

  it("reads a SemVer pre-release part as a pre-release", () => {
    expect(desktopRelease("desktop-v1.2.3-beta.1", "1.2.3-beta.1")).toEqual({
      version: "1.2.3-beta.1",
      prerelease: true,
    });
    expect(desktopRelease("desktop-v1.2.3-rc-2+exp", "1.2.3-rc-2+exp").prerelease).toBe(true);
  });

  it("refuses a tag that is not the app's version", () => {
    expect(() => desktopRelease("desktop-v0.2.0", "0.1.0")).toThrow(/not the app's version/);
    expect(() => desktopRelease("desktop-v0.1.0-beta.1", "0.1.0")).toThrow(/not the app's version/);
  });

  it("refuses what is not a desktop tag or not SemVer", () => {
    expect(() => desktopRelease("v0.1.0", "0.1.0")).toThrow(/not a desktop release tag/);
    for (const version of ["0.1", "01.2.3", "1.2.3-", "1.2.3-beta..1", "1.2.3-01", "-beta"]) {
      expect(() => desktopRelease(`desktop-v${version}`, version), version).toThrow(/not a SemVer version/);
    }
  });
});
