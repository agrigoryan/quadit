import type { WebContents, WebContentsView } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageHandlers } from "@/main/app-pages";
import { ConnectPage } from "@/main/connect-page";
import type { ConnectTarget } from "@/shared/pages-api";

/**
 * Connect agents over stand-ins: each view is `{ webContents: { id } }`; the
 * windows record what they are asked, and the window of the server
 * `covered`, when given, has another of the app's pages over it already;
 * the windows of the servers in `front` are in front of the person.
 */
function harness({ covered = "", front = new Set<string>() }: { covered?: string; front?: Set<string> } = {}) {
  let handlers: Partial<PageHandlers> = {};
  const said: string[] = [];
  const closers = new Map<number, () => void>();
  let views = 0;
  const viewId = (view: WebContentsView) => (view.webContents as unknown as { id: number }).id;
  const connect = new ConnectPage({
    pages: {
      answer: (given) => (handlers = { ...handlers, ...given }),
      view: () => ({ webContents: { id: ++views } }) as unknown as WebContentsView,
    },
    connections: {
      dropPlans: () => void said.push("drop plans"),
    } as unknown as ConstructorParameters<typeof ConnectPage>[0]["connections"],
    windows: {
      cover: (view, serverId, closed) => {
        if (serverId === covered) {
          said.push(`front ${serverId}`);
          return undefined;
        }
        said.push(`cover ${serverId} with ${viewId(view)}`);
        closers.set(viewId(view), closed);
        return { donor: null };
      },
      uncover: (view) => void said.push(`uncover ${viewId(view)}`),
      isCovered: (serverId) => serverId === covered,
      inFront: (serverId) => front.has(serverId),
    },
    target: (serverId): Omit<ConnectTarget, "openedByPage"> => ({
      serverId,
      serverName: `Server ${serverId}`,
      summary: null,
    }),
    copy: async () => {},
    showBackups: async () => {},
  });
  /** Calls the page's method `name` as the page in the view `view` (its number) would. */
  const call = <K extends keyof PageHandlers>(view: number, name: K, ...args: unknown[]) =>
    (handlers[name] as (sender: WebContents, ...rest: unknown[]) => unknown)(
      { id: view } as unknown as WebContents,
      ...args,
    );
  return { connect, said, closers, call };
}

describe("ConnectPage", () => {
  it("lays Connect agents over the window of the server asked for, and Done takes it away and the plan under review", async () => {
    const { connect, said, call } = harness();
    connect.show("s1");
    expect(await call(1, "connectTarget")).toEqual({
      serverId: "s1",
      serverName: "Server s1",
      summary: null,
      openedByPage: false,
    });
    await call(1, "closeConnect");
    expect(said).toEqual(["cover s1 with 1", "uncover 1", "drop plans"]);
    // Gone, it is over no window.
    expect(await call(1, "connectTarget")).toBeNull();
  });

  it("brings itself to the front when asked again for the same window, and moves when asked for another's", () => {
    const { connect, said } = harness();
    connect.show("s1");
    connect.show("s1");
    connect.show("s2");
    expect(said).toEqual(["cover s1 with 1", "cover s1 with 1", "uncover 1", "drop plans", "cover s2 with 2"]);
  });

  it("goes when the window under it is closed", async () => {
    const { connect, said, closers, call } = harness();
    connect.show("s1");
    closers.get(1)?.();
    expect(said.slice(1)).toEqual(["uncover 1", "drop plans"]);
    expect(await call(1, "connectTarget")).toBeNull();
  });

  it("lays nothing over a window another of the app's pages covers (the first run)", async () => {
    const { connect, said, call } = harness({ covered: "s1" });
    connect.show("s1");
    expect(said).toEqual(["front s1", "uncover 1"]);
    expect(await call(1, "connectTarget")).toBeNull();
  });

  it("tells and obeys only its own page", async () => {
    const { connect, said, call } = harness();
    connect.show("s1");
    expect(await call(7, "connectTarget")).toBeNull();
    await call(7, "closeConnect");
    expect(said).toEqual(["cover s1 with 1"]);
  });
});

describe("ConnectPage, asked by a server's page", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opens only over that page's window while it is in front, and tells its page that a server's page asked", async () => {
    const front = new Set<string>();
    const { connect, said, call } = harness({ front });
    connect.asked("s1");
    expect(said).toEqual([]);
    front.add("s1");
    connect.asked("s1");
    expect(said).toEqual(["cover s1 with 1"]);
    expect(await call(1, "connectTarget")).toMatchObject({ serverName: "Server s1", openedByPage: true });
    // Asked again while it is there: nothing more.
    connect.asked("s1");
    expect(said).toEqual(["cover s1 with 1"]);
  });

  it("cannot open it again for ten seconds after the person left it, whichever way it was opened; the menu always can", async () => {
    const { connect, said, call } = harness({ front: new Set(["s1"]) });
    connect.show("s1");
    await call(1, "closeConnect");
    vi.advanceTimersByTime(9_999);
    connect.asked("s1");
    expect(said).toEqual(["cover s1 with 1", "uncover 1", "drop plans"]);
    connect.show("s1");
    expect(said.at(-1)).toBe("cover s1 with 2");
    expect(await call(2, "connectTarget")).toMatchObject({ openedByPage: false });
    await call(2, "closeConnect");
    vi.advanceTimersByTime(10_000);
    connect.asked("s1");
    expect(said.at(-1)).toBe("cover s1 with 3");
  });

  it("counts moving to another window as not leaving, and closing the window as leaving", () => {
    const { connect, said, closers } = harness({ front: new Set(["s1", "s2"]) });
    connect.show("s1");
    connect.show("s2");
    connect.asked("s1");
    expect(said.at(-1)).toBe("cover s1 with 3");
    closers.get(3)?.();
    connect.asked("s1");
    expect(said.slice(-2)).toEqual(["uncover 3", "drop plans"]);
  });

  it("never opens while the first run covers the window, nor brings that window forward", () => {
    const { connect, said } = harness({ covered: "s1", front: new Set(["s1"]) });
    connect.asked("s1");
    expect(said).toEqual([]);
  });
});
