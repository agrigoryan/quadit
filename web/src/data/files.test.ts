// Uploading a file (data/files.ts): what happens while the server cannot be reached.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, NetworkError, noteReachable } from "@/data/api";
import { uploadFile, useTransfers } from "@/data/files";

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
