// Files (data/files.ts): what happens to an upload while the server cannot be
// reached, and how the viewer shows a file, if it can.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, NetworkError, noteReachable } from "@/data/api";
import { shownAs, uploadFile, useTransfers } from "@/data/files";

const file = new File(["hello"], "note.txt", { type: "text/plain" });
const stored = {
  id: "f1",
  name: "note.txt",
  size: 5,
  content_type: "text/plain",
  state: "ready",
  url: "/f/f1/note.txt",
};

const settle = () => vi.advanceTimersByTimeAsync(0);
const later = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(1);
});
afterEach(() => vi.useRealTimers());

describe("uploadFile", () => {
  it("waits when the server cannot be reached, says so, and carries on by itself after about a second", async () => {
    const send = vi.spyOn(api, "send").mockRejectedValueOnce(new NetworkError()).mockResolvedValue(stored);
    const states: string[] = [];
    const done = uploadFile(file, { onProgress: (progress) => states.push(progress.state) });
    await settle();
    expect(states.at(-1)).toBe("waiting");
    expect(useTransfers.getState().items).toMatchObject([{ name: "note.txt", state: "waiting" }]);
    await later(999);
    expect(send).toHaveBeenCalledTimes(1);
    await later(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(await done).toMatchObject({ id: "f1" });
    expect(useTransfers.getState().items).toEqual([]);
  });

  it("carries on at once when the server is heard from", async () => {
    const send = vi.spyOn(api, "send").mockRejectedValueOnce(new NetworkError()).mockResolvedValue(stored);
    const done = uploadFile(file);
    await settle();
    noteReachable();
    await settle();
    expect(send).toHaveBeenCalledTimes(2);
    await done;
  });

  it("stops waiting when the upload is given up, and rejects with an AbortError", async () => {
    const send = vi.spyOn(api, "send").mockRejectedValue(new NetworkError());
    const giveUp = new AbortController();
    const done = uploadFile(file, { signal: giveUp.signal }).catch((err: unknown) => err);
    await settle();
    giveUp.abort();
    expect(await done).toMatchObject({ name: "AbortError" });
    await later(60_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(useTransfers.getState().items).toEqual([]);
  });
});

describe("shownAs", () => {
  const as = (name: string, content_type = "application/octet-stream") => shownAs({ name, content_type });

  it("shows pictures and videos by their type, as before", () => {
    expect(as("cat.png", "image/png")).toBe("image");
    expect(as("clip", "video/mp4")).toBe("video");
  });

  it("renders Markdown, known by its name or its type", () => {
    expect(as("PLAN.md", "text/plain; charset=utf-8")).toBe("markdown");
    expect(as("notes.Markdown")).toBe("markdown");
    expect(as("notes", "text/markdown; charset=utf-8")).toBe("markdown");
  });

  it("shows text a person reads as text, by its name whatever type it was given", () => {
    for (const name of ["run.log", "a.txt", "data.json", "t.csv", "t.tsv", "c.yaml", "c.yml", "c.toml", "f.xml"])
      expect(as(name), name).toBe("text");
    for (const name of [
      "main.go",
      "app.ts",
      "view.tsx",
      "x.js",
      "x.py",
      "x.sh",
      "q.sql",
      "s.css",
      "fix.diff",
      "fix.patch",
    ])
      expect(as(name), name).toBe("text");
    // A system's table may call a TypeScript file an MPEG stream.
    expect(as("app.ts", "video/mp2t")).toBe("text");
  });

  it("shows anything served as text, JSON, XML or YAML as text", () => {
    expect(as("README", "text/plain; charset=utf-8")).toBe("text");
    expect(as("out", "application/json")).toBe("text");
    expect(as("feed", "application/atom+xml")).toBe("text");
    expect(as("compose", "application/yaml")).toBe("text");
  });

  it("shows a page or a drawing as its source, never as itself", () => {
    expect(as("page.html", "text/html; charset=utf-8")).toBe("text");
    expect(as("page.htm")).toBe("text");
    expect(as("logo.svg", "image/svg+xml")).toBe("text");
    expect(as("logo", "image/svg+xml")).toBe("text");
    // The name says what it is, whatever type it arrived with.
    expect(as("page.html", "text/markdown")).toBe("text");
    expect(as("logo.svg", "text/markdown")).toBe("text");
    expect(as("feed.xml", "text/markdown")).toBe("text");
  });

  it("leaves anything else to download", () => {
    expect(as("handbook.zip", "application/zip")).toBeNull();
    expect(as("report.pdf", "application/pdf")).toBeNull();
    expect(as("sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBeNull();
    expect(as("Makefile")).toBeNull();
  });
});
