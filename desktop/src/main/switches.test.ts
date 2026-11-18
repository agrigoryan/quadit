import { describe, expect, it } from "vitest";
import { refusedSwitches } from "@/main/switches";

describe("refusedSwitches", () => {
  const none = () => false;

  it("finds the switches that open the app to other programs, however they are written", () => {
    expect(
      refusedSwitches(
        [
          "/Applications/Quadit.app/Contents/MacOS/Quadit",
          "--remote-debugging-port=9222",
          "--INSPECT=9229",
          "-inspect-brk",
          "--no-sandbox",
          "--proxy-server=http://evil:8080",
          "--host-resolver-rules=MAP * 10.0.0.1",
          "--ignore-certificate-errors",
        ],
        none,
      ),
    ).toEqual([
      "remote-debugging-port",
      "inspect",
      "inspect-brk",
      "no-sandbox",
      "ignore-certificate-errors",
      "proxy-server",
      "host-resolver-rules",
    ]);
  });

  it("asks Chromium too, which also reads switches given another way", () => {
    expect(refusedSwitches(["/opt/Quadit/quadit"], (name) => name === "remote-debugging-pipe")).toEqual([
      "remote-debugging-pipe",
    ]);
  });

  it("lets a link and the app's ordinary switches through", () => {
    expect(
      refusedSwitches(
        ["/opt/Quadit/quadit", "quadit://open?server=x&path=/e2e", "--enable-logging", "--lang=de"],
        none,
      ),
    ).toEqual([]);
  });
});
