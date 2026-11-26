import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ServerStore } from "@/main/servers";
import type { DesktopSummary } from "@/shared/bridge";

const seen = { badge: 0, title: "", menu: [] as string[] };
vi.mock("electron", () => ({
  app: { name: "Quadit", setBadgeCount: (count: number) => void (seen.badge = count) },
  Menu: {
    buildFromTemplate: (items: { label?: string }[]) => {
      seen.menu = items.flatMap((item) => (item.label ? [item.label] : []));
      return {};
    },
  },
  nativeImage: { createFromPath: () => ({ setTemplateImage() {}, getSize: () => ({ width: 16, height: 16 }) }) },
  Tray: class {
    on() {}
    setToolTip() {}
    setTitle(title: string) {
      seen.title = title;
    }
    setContextMenu() {}
  },
}));

const { MenuBar } = await import("@/main/menu-bar");
const { PANEL_LABEL } = await import("@/main/menu");

const QUESTION = { title: "Which level?", detail: "SVA-5 Levels", path: "/acme/t/SVA-5", actions: [] };
const TASK = { key: "SVA-53", title: "Check the new level graphics", who: "@codex", path: "/acme/t/SVA-53" };
const RUN = { key: "SVA-9", title: "Boss", line: "Not started: …", path: "/acme/t/SVA-9" };

/** A workspace's summary: `waiting` questions, and the new lists when given (an older page has none). */
function summary(id: string, parts: Partial<DesktopSummary> = {}): DesktopSummary {
  return {
    workspace: { id, slug: id, name: id },
    me: { name: "Ann", canCreateAgents: true },
    waiting: [],
    agents: [],
    projects: [],
    ...parts,
  };
}

function setUp() {
  const store = new ServerStore(join(mkdtempSync(join(tmpdir(), "quadit-desktop-bar-")), "servers.json"));
  const one = store.add("https://one.example.com", "One", { handoff: 1, inset: 0 });
  const two = store.add("https://two.example.com", "Two", { handoff: 1, inset: 0 });
  let shown: { serverId: string; summary: DesktopSummary }[] = [];
  const bar = new MenuBar(store, {
    trayIcon: "",
    openServer() {},
    showServerList() {},
    togglePanel() {},
    summaries: () => shown,
  });
  bar.start();
  return {
    store,
    one: one.id,
    two: two.id,
    bar,
    show: (next: typeof shown) => {
      shown = next;
      bar.changed();
    },
  };
}

describe("MenuBar", () => {
  beforeEach(() => Object.assign(seen, { badge: 0, title: "", menu: [] }));

  it("counts what waits on the person: questions, tasks that wait on them, runs that need them, and the rest of each", () => {
    const { one, bar, show } = setUp();
    show([
      {
        serverId: one,
        summary: summary("acme", {
          waiting: [QUESTION],
          waitingMore: 2,
          tasks: { items: [TASK], more: 0 },
          runs: { items: [RUN], more: 1 },
          working: { items: [], more: 0 },
        }),
      },
    ]);
    expect(bar.total).toBe(6);
    expect(seen.badge).toBe(6);
    expect(seen.title).toBe("6");
  });

  it("shows no number when nothing waits, whatever runs or is unread", () => {
    const { one, show } = setUp();
    const working = {
      items: [{ agent: "@claude", key: "SVA-1", title: "x", state: "Working", since: 0, path: "/" }],
      more: 0,
    };
    show([
      {
        serverId: one,
        summary: summary("acme", { tasks: { items: [], more: 0 }, runs: { items: [], more: 0 }, working }),
      },
    ]);
    expect(seen.title).toBe("");
    expect(seen.badge).toBe(0);
  });

  it("counts only the questions of a page from before the other lists", () => {
    const { one, bar, show } = setUp();
    show([{ serverId: one, summary: summary("acme", { waiting: [QUESTION, QUESTION, QUESTION] }) }]);
    expect(bar.total).toBe(3);
  });

  // On Linux the menu is the tray's only way in: the panel is its first item, before the servers.
  it.each([
    ["darwin", []],
    ["win32", []],
    ["linux", [PANEL_LABEL]],
  ])(
    "on %s, adds the servers' workspaces up, says each server's own in its menu, and leaves a removed server out",
    (platform, first) => {
      const real = Object.getOwnPropertyDescriptor(process, "platform") ?? { value: process.platform };
      Object.defineProperty(process, "platform", { value: platform });
      try {
        const { store, one, two, bar, show } = setUp();
        show([
          { serverId: one, summary: summary("acme", { waiting: [QUESTION] }) },
          { serverId: one, summary: summary("games", { waiting: [QUESTION, QUESTION] }) },
          { serverId: two, summary: summary("acme", { tasks: { items: [TASK], more: 3 } }) },
        ]);
        expect(bar.of(one)).toBe(3);
        expect(bar.of(two)).toBe(4);
        expect(seen.menu.slice(0, first.length + 2)).toEqual([...first, "One (3)", "Two (4)"]);
        store.remove(two);
        expect(bar.total).toBe(3);
        expect(seen.badge).toBe(3);
      } finally {
        Object.defineProperty(process, "platform", real);
      }
    },
  );
});
