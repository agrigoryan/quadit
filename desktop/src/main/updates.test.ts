import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Fetch } from "@/main/probe";
import { compareVersions, newerRelease, RELEASES_API, UpdateWatch } from "@/main/updates";

const release = (tag: string, extra: object = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/agrigoryan/quadit/releases/tag/${tag}`,
  ...extra,
});

describe("newerRelease", () => {
  it("finds the newest desktop release above the running version", () => {
    const releases = [
      release("v2.0.0"),
      release("desktop-v0.2.0"),
      release("desktop-v0.10.1"),
      release("desktop-v0.3.0"),
    ];
    expect(newerRelease(releases, "0.1.0")).toEqual({ version: "0.10.1", url: "https://github.com/agrigoryan/quadit/releases/tag/desktop-v0.10.1" });
  });

  it("skips drafts, pre-releases, the server's tags and what is not newer", () => {
    const releases = [
      release("desktop-v9.0.0", { draft: true }),
      release("desktop-v8.0.0", { prerelease: true }),
      release("v7.0.0"),
      release("desktop-vnext"),
      release("desktop-v0.1.0"),
    ];
    expect(newerRelease(releases, "0.1.0")).toBeNull();
  });
});

describe("release pages", () => {
  it("are only the project's own release pages on GitHub", () => {
    for (const url of [
      "https://github.com/agrigoryan/quadit-evil/releases/tag/desktop-v9.0.0",
      "https://github.com/agrigoryan/quadit/../evil/releases/tag/desktop-v9.0.0",
      "http://github.com/agrigoryan/quadit/releases/tag/desktop-v9.0.0",
      "https://github.com.evil.com/agrigoryan/quadit/releases/tag/desktop-v9.0.0",
      "https://evil.com/agrigoryan/quadit/releases/tag/desktop-v9.0.0",
      "file:///Applications/Calculator.app",
      "smb://evil/share",
    ]) {
      expect(newerRelease([release("desktop-v9.0.0", { html_url: url })], "0.1.0"), url).toBeNull();
    }
  });

  it("are checked again when read back from the last check", () => {
    const file = join(mkdtempSync(join(tmpdir(), "quadit-desktop-updates-")), "update-check.json");
    writeFileSync(
      file,
      JSON.stringify({ checkedAt: Date.now(), told: "9.0.0", latest: { version: "9.0.0", url: "file:///etc/passwd" } }),
    );
    const fetcher: Fetch = async () => Response.json([]);
    expect(new UpdateWatch(file, "0.1.0", fetcher, vi.fn(), vi.fn()).available).toBeNull();
  });
});

describe("compareVersions", () => {
  it("orders by number, not by text", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBe(0);
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
    expect(compareVersions("junk", "0.0.1")).toBe(-1);
  });
});

describe("UpdateWatch", () => {
  function setUp(releases: object[]) {
    const file = join(mkdtempSync(join(tmpdir(), "quadit-desktop-updates-")), "update-check.json");
    const asked: string[] = [];
    const fetcher: Fetch = async (url) => {
      asked.push(url);
      return Response.json(releases);
    };
    const news = vi.fn();
    const tell = vi.fn();
    return { file, asked, fetcher, news, tell };
  }

  it("tells once about a newer release and checks at most once a day", async () => {
    const { file, asked, fetcher, news, tell } = setUp([release("desktop-v0.2.0")]);
    const first = new UpdateWatch(file, "0.1.0", fetcher, news, tell);
    first.start();
    await vi.waitFor(() => expect(tell).toHaveBeenCalledTimes(1));
    first.stop();
    expect(asked).toEqual([RELEASES_API]);
    expect(first.available).toEqual({ version: "0.2.0", url: "https://github.com/agrigoryan/quadit/releases/tag/desktop-v0.2.0" });
    expect(news).toHaveBeenLastCalledWith({ version: "0.2.0", url: "https://github.com/agrigoryan/quadit/releases/tag/desktop-v0.2.0" });

    // A restart within the day: no new request, no second notice, the menu item stays.
    const second = new UpdateWatch(file, "0.1.0", fetcher, news, tell);
    second.start();
    second.stop();
    await new Promise((settle) => setTimeout(settle, 20));
    expect(asked).toHaveLength(1);
    expect(tell).toHaveBeenCalledTimes(1);
    expect(second.available?.version).toBe("0.2.0");

    // Once the app is that version, there is nothing to say.
    expect(new UpdateWatch(file, "0.2.0", fetcher, news, tell).available).toBeNull();
  });
});
