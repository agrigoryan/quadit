import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ServerStore } from "@/main/servers";

const badge = { count: 0 };
vi.mock("electron", () => ({
  app: { name: "Quadit", setBadgeCount: (count: number) => void (badge.count = count) },
  Menu: { buildFromTemplate: () => ({}) },
  nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) },
  Tray: class {
    setToolTip() {}
    setTitle() {}
    setContextMenu() {}
  },
}));

const { Unread } = await import("@/main/unread");

function setUp() {
  const store = new ServerStore(join(mkdtempSync(join(tmpdir(), "quadit-desktop-unread-")), "servers.json"));
  const one = store.add("https://one.example.com", "One", 1);
  const two = store.add("https://two.example.com", "Two", 1);
  const unread = new Unread(store, { trayIcon: "", openServer() {}, showServerList() {} });
  return { store, one: one.id, two: two.id, unread };
}

describe("Unread", () => {
  beforeEach(() => void (badge.count = 0));

  it("adds up a server's workspaces, each once however many windows report it", () => {
    const { one, unread } = setUp();
    unread.report(one, 1, "acme", 7);
    unread.report(one, 2, "games", 2);
    // A second window on acme says the same count: still counted once.
    unread.report(one, 3, "acme", 7);
    expect(badge.count).toBe(9);
    // The newest report of a workspace is its count.
    unread.report(one, 1, "acme", 5);
    expect(badge.count).toBe(7);
  });

  it("takes a report of 0 as the workspace's count, not as a window's word taken back", () => {
    const { one, unread } = setUp();
    unread.report(one, 1, "acme", 7);
    unread.report(one, 2, "acme", 7);
    // Everything read: the newest report says so, and the older 7 is out of date.
    unread.report(one, 1, "acme", 0);
    expect(badge.count).toBe(0);
  });

  it("takes off a window's count when it leaves its workspace, shows none, or closes", () => {
    const { one, unread } = setUp();
    unread.report(one, 1, "acme", 7);
    unread.report(one, 2, "games", 2);
    unread.report(one, 3, "acme", 7);
    // Window 2 goes over to acme: its games goes with it.
    unread.report(one, 2, "acme", 7);
    expect(badge.count).toBe(7);
    // Window 1 shows no workspace (signed out, say), window 2 closes: window 3 still reports acme.
    unread.report(one, 1, "", 0);
    unread.forget(2);
    expect(badge.count).toBe(7);
    unread.forget(3);
    expect(badge.count).toBe(0);
  });

  it("adds up the servers, and forgets a removed one", () => {
    const { store, one, two, unread } = setUp();
    unread.report(one, 1, "acme", 3);
    unread.report(two, 2, "acme", 4);
    expect(badge.count).toBe(7);
    store.remove(two);
    expect(badge.count).toBe(3);
  });
});
