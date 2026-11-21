import { describe, expect, it } from "vitest";
import { CODE_LIFE_MS, handshakeOf } from "@/main/handshake";
import type { Answer } from "@/main/requests";

const NOW = 1_000_000_000_000;
const code = { id: "c1", code: "ABC234", at: NOW - 60_000 };
const state = (connected: boolean, codeUsed: boolean, listening = false): Answer => ({
  ok: true,
  connected,
  listening,
  codeUsed,
});

describe("handshakeOf", () => {
  it("waits on the open code until it is given back, though the agent proved itself elsewhere before", () => {
    const set = { methods: ["cli" as const], code };
    expect(handshakeOf(set, state(false, false), NOW)).toEqual({ state: "waiting", code: "ABC234" });
    expect(handshakeOf(set, state(true, false), NOW)).toEqual({ state: "waiting", code: "ABC234" });
    expect(handshakeOf(set, state(true, true), NOW)).toEqual({ state: "connected", listening: false });
    expect(handshakeOf(set, state(true, true, true), NOW)).toEqual({ state: "connected", listening: true });
  });

  it("offers no code that has run out, and goes by the agent then, as for a tool an older version connected", () => {
    const old = { methods: ["cli" as const], code: { ...code, at: NOW - CODE_LIFE_MS } };
    expect(handshakeOf(old, state(false, false), NOW)).toEqual({ state: "waiting", code: null });
    expect(handshakeOf(old, state(true, false, true), NOW)).toEqual({ state: "connected", listening: true });
    const none = { methods: ["cli" as const], code: null };
    expect(handshakeOf(none, state(false, false), NOW)).toEqual({ state: "waiting", code: null });
    expect(handshakeOf(none, state(true, false), NOW)).toEqual({ state: "connected", listening: false });
  });

  it("knows nothing more when the server could not say, or said something else", () => {
    const set = { methods: ["cli" as const], code };
    expect(handshakeOf(set, { ok: false, message: "No window", unanswered: true }, NOW)).toEqual({ state: "unknown" });
    expect(handshakeOf(set, { ok: false, message: "That agent is gone." }, NOW)).toEqual({ state: "unknown" });
    // An older server's page answers a request it does not know with nothing of the state.
    expect(handshakeOf(set, { ok: true }, NOW)).toEqual({ state: "unknown" });
  });

  it("waits on no code for a tool connected by MCP alone, which has no command to give one back with", () => {
    const mcp = { methods: ["mcp" as const], code: null };
    expect(handshakeOf(mcp, state(false, false), NOW)).toEqual({ state: "unknown" });
    expect(handshakeOf(mcp, state(true, false, true), NOW)).toEqual({ state: "connected", listening: true });
  });
});
