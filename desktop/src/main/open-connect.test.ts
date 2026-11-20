import { describe, expect, it } from "vitest";
import { OpenConnect } from "@/main/open-connect";

function setUp() {
  let now = 0;
  const opened: string[] = [];
  const asks = new OpenConnect(
    (serverId) => opened.push(serverId),
    () => now,
  );
  return { asks, opened, at: (ms: number) => (now = ms) };
}

describe("OpenConnect", () => {
  it("opens Connect agents for the server whose own page asked", () => {
    const { asks, opened } = setUp();
    asks.asked("s1");
    expect(opened).toEqual(["s1"]);
  });

  it("ignores an ask from anything but a server's own page", () => {
    const { asks, opened } = setUp();
    asks.asked(null);
    expect(opened).toEqual([]);
  });

  it("ignores more than one ask a second, from whichever page", () => {
    const { asks, opened, at } = setUp();
    at(10_000);
    asks.asked("s1");
    at(10_400);
    asks.asked("s1");
    asks.asked("s2");
    at(10_999);
    asks.asked("s1");
    at(11_000);
    asks.asked("s2");
    expect(opened).toEqual(["s1", "s2"]);
  });
});
