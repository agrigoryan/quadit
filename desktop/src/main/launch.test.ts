import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivateAfterStart, coldStart, Quiet, secondStart, windowsToReopen } from "@/main/launch";

const APP = ["/Applications/Quadit.app/Contents/MacOS/Quadit"];

describe("coldStart", () => {
  it("shows the app's windows and starts its server when the person starts it", () => {
    expect(coldStart(APP, { atLogin: false })).toEqual({ windows: true, server: "start" });
  });

  it("opens no window at login, and starts its server as at any start", () => {
    expect(coldStart(APP, { atLogin: true })).toEqual({ windows: false, server: "start" });
  });

  it("started with --background by the quadit command, opens no window, and starts its server only if not stopped on purpose", () => {
    expect(coldStart([...APP, "--background"], { atLogin: false })).toEqual({ windows: false, server: "background" });
  });
});

describe("secondStart", () => {
  it("hands a link on", () => {
    expect(secondStart([...APP, "quadit://open?server=x&path=/"], { windowShown: true })).toEqual({
      kind: "link",
      link: "quadit://open?server=x&path=/",
    });
  });

  it("told --background, opens no window, whatever is on screen, and sees to its server", () => {
    expect(secondStart([...APP, "--background"], { windowShown: false })).toEqual({ kind: "background" });
    expect(secondStart([...APP, "--background"], { windowShown: true })).toEqual({ kind: "background" });
  });

  it("started again by the person, shows the server list when no window is on screen, and else nothing", () => {
    expect(secondStart(APP, { windowShown: false })).toEqual({ kind: "list" });
    expect(secondStart(APP, { windowShown: true })).toEqual({ kind: "nothing" });
  });
});

describe("ActivateAfterStart", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("takes no activate in the first 3 seconds after a --background start for the person's: that start's own opens no window", () => {
    const activate = new ActivateAfterStart(true);
    expect(activate.isThePersons()).toBe(false);
    vi.advanceTimersByTime(2_999);
    expect(activate.isThePersons()).toBe(false);
    // Later, the Dock icon clicked is the person asking for a window.
    vi.advanceTimersByTime(1);
    expect(activate.isThePersons()).toBe(true);
  });

  it("takes every activate for the person's after any other start", () => {
    expect(new ActivateAfterStart(false).isThePersons()).toBe(true);
  });
});

describe("Quiet", () => {
  it("holds what the app would say on its own after a background start until the person opens it, then says it once, in order", () => {
    const said: string[] = [];
    const quiet = new Quiet(true);
    quiet.say(() => said.push("the first run"));
    quiet.say(() => said.push("a server no longer fits"));
    expect(said).toEqual([]);
    expect(quiet.holding).toBe(true);
    quiet.seen();
    expect(quiet.holding).toBe(false);
    expect(said).toEqual(["the first run", "a server no longer fits"]);
    quiet.seen();
    expect(said).toHaveLength(2);
    // Opened by the person, it says things at once.
    quiet.say(() => said.push("an update"));
    expect(said.at(-1)).toBe("an update");
  });

  it("is quiet again when told to start in the background while running, until the person next opens it", () => {
    const said: string[] = [];
    const quiet = new Quiet(false);
    quiet.background();
    quiet.say(() => said.push("the first run"));
    expect(said).toEqual([]);
    quiet.seen();
    expect(said).toEqual(["the first run"]);
  });
});

describe("windowsToReopen", () => {
  it("gives the servers that were open when the app last had windows", () => {
    expect(
      windowsToReopen([
        { id: "a", open: true },
        { id: "b", open: false },
        { id: "c", open: true },
      ]),
    ).toEqual(["a", "c"]);
  });

  it("gives the only server when none was open: opening the app shows the workspace, not the list", () => {
    expect(windowsToReopen([{ id: "a", open: false }])).toEqual(["a"]);
  });

  it("gives none with several servers and none open, or with no server: the list is shown", () => {
    expect(
      windowsToReopen([
        { id: "a", open: false },
        { id: "b", open: false },
      ]),
    ).toEqual([]);
    expect(windowsToReopen([])).toEqual([]);
  });
});
