import { describe, expect, it } from "vitest";
import { FIRST_RUN_SPEAKS, frameFor, STRIP_HEIGHT } from "@/main/window-frame";

describe("frameFor", () => {
  it("gives a server window on macOS no title bar when the server's pages are laid out for it, with the overlay that tells them where the buttons are", () => {
    const frame = frameFor("darwin", { inset: 1 });
    expect(frame.options).toMatchObject({
      titleBarStyle: "hiddenInset",
      titleBarOverlay: true,
      trafficLightPosition: { x: expect.any(Number), y: expect.any(Number) },
    });
    expect(frame.strip).toBe(STRIP_HEIGHT);
  });

  it("does so for a server that speaks a later version of the layout too", () => {
    expect(frameFor("darwin", { inset: 2 }).strip).toBe(STRIP_HEIGHT);
  });

  it("keeps the title bar for a server whose pages know nothing of it", () => {
    expect(frameFor("darwin", { inset: 0 })).toEqual({ options: {}, strip: 0 });
  });

  it("keeps the title bar on Windows and Linux", () => {
    expect(frameFor("win32", { inset: 1 })).toEqual({ options: {}, strip: 0 });
    expect(frameFor("linux", { inset: 1 })).toEqual({ options: {}, strip: 0 });
  });

  it("frames the first run's window, made before its server is known, as the window of the server the app carries", () => {
    expect(frameFor("darwin", FIRST_RUN_SPEAKS).strip).toBe(STRIP_HEIGHT);
    expect(frameFor("linux", FIRST_RUN_SPEAKS).strip).toBe(0);
  });
});
