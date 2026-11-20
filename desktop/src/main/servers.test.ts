import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ServerStore } from "@/main/servers";

function file() {
  return join(mkdtempSync(join(tmpdir(), "quadit-desktop-servers-")), "servers.json");
}

describe("ServerStore", () => {
  it("starts empty without a file, and with a damaged one", () => {
    expect(new ServerStore(file()).list()).toEqual([]);
    const damaged = file();
    writeFileSync(damaged, "{not json");
    expect(new ServerStore(damaged).list()).toEqual([]);
  });

  it("adds a server named after its host, and keeps it across restarts", () => {
    const path = file();
    const store = new ServerStore(path);
    const server = store.add("https://quadit.example.com", "", { handoff: 1, inset: 1 });
    expect(server).toMatchObject({
      name: "quadit.example.com",
      origin: "https://quadit.example.com",
      open: false,
      handoff: 1,
      inset: 1,
    });
    expect(server.id).toMatch(/^[0-9a-f]{12}$/);
    expect(new ServerStore(path).list()).toEqual([server]);
  });

  it("keeps one entry per origin, with its id, renamed only when a name is given", () => {
    const store = new ServerStore(file());
    const first = store.add("https://quadit.example.com", "Work", { handoff: 0, inset: 0 });
    const again = store.add("https://quadit.example.com", "", { handoff: 1, inset: 1 });
    expect(again.id).toBe(first.id);
    expect(again).toMatchObject({ name: "Work", handoff: 1, inset: 1 });
    expect(store.add("https://quadit.example.com", "Office", { handoff: 1, inset: 1 }).name).toBe("Office");
    expect(store.list()).toHaveLength(1);
  });

  it("changes and removes, telling listeners only when something changed", () => {
    const store = new ServerStore(file());
    const listener = vi.fn();
    const server = store.add("https://a.example.com", "A", { handoff: 1, inset: 0 });
    store.onChange(listener);
    store.change(server.id, { open: true });
    store.change(server.id, { open: true });
    store.change("unknown", { open: true });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get(server.id)?.open).toBe(true);
    store.remove(server.id);
    expect(store.list()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("reads a file from before servers said what they speak as servers that speak nothing", () => {
    const path = file();
    writeFileSync(
      path,
      JSON.stringify({ servers: [{ id: "0a1b2c3d4e5f", name: "Old", origin: "https://old.example.com" }] }),
    );
    expect(new ServerStore(path).list()).toEqual([
      expect.objectContaining({ id: "0a1b2c3d4e5f", handoff: 0, inset: 0, version: "" }),
    ]);
  });

  it("writes plain JSON a person could read", () => {
    const path = file();
    new ServerStore(path).add("https://a.example.com", "A", { handoff: 1, inset: 0 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      servers: [{ origin: "https://a.example.com", name: "A" }],
    });
  });
});
