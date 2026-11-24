import { describe, expect, it } from "vitest";
import { OpenConnect } from "@/main/open-connect";
import type { ConnectFocus } from "@/shared/bridge";

function setUp() {
  let now = 0;
  const opened: string[] = [];
  const focuses: (ConnectFocus | null)[] = [];
  const asks = new OpenConnect(
    (serverId, focus) => {
      opened.push(serverId);
      focuses.push(focus);
    },
    () => now,
  );
  return { asks, opened, focuses, at: (ms: number) => (now = ms) };
}

describe("OpenConnect", () => {
  it("opens Connect agents for the server whose own page asked", () => {
    const { asks, opened } = setUp();
    asks.asked("s1");
    expect(opened).toEqual(["s1"]);
  });

  it("opens it at the agent and for what the page meant, and as without a focus for anything else sent", () => {
    const { asks, focuses, at } = setUp();
    const agent = "0190f3a2-7b1c-7d4e-9a0b-1c2d3e4f5a6b";
    const sent: unknown[] = [
      { agent, intent: "run" },
      { agent, intent: "explode" },
      { agent: "../../etc", intent: "connect" },
      "connect",
      { agent, intent: "disconnect", path: "/tmp/x" },
    ];
    sent.forEach((raw, i) => {
      at(i * 1_000);
      asks.asked("s1", raw);
    });
    expect(focuses).toEqual([{ agent, intent: "run" }, null, null, null, { agent, intent: "disconnect" }]);
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
