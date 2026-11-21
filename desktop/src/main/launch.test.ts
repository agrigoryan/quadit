import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivateAfterStart, coldStart, secondStart } from "@/main/launch";

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
