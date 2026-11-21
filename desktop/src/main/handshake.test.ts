import { describe, expect, it } from "vitest";
import { CODE_LIFE_MS, handshakeOf } from "@/main/handshake";
import type { Answer } from "@/main/requests";

const NOW = 1_000_000_000_000;
const code = { id: "c1", code: "ABC234", at: NOW - 60_000 };
const cli = { methods: ["cli" as const], code };
const state = (connected: boolean, codeUsed: boolean, listening = false, codeGone = false): Answer => ({
  ok: true,
  connected,
  listening,
  codeUsed,
  codeGone,
});
const NO_ANSWER: Answer = { ok: false, message: "No window of that server can do this now.", unanswered: true };

describe("handshakeOf", () => {
  it("waits on the open code until it is given back, though the agent proved itself elsewhere before", () => {
    expect(handshakeOf(cli, state(false, false), NOW, undefined)).toEqual({ state: "waiting", code: "ABC234" });
    expect(handshakeOf(cli, state(true, false), NOW, undefined)).toEqual({ state: "waiting", code: "ABC234" });
    expect(handshakeOf(cli, state(true, true), NOW, undefined)).toEqual({ state: "connected", listening: false });
    expect(handshakeOf(cli, state(true, true, true), NOW, undefined)).toEqual({ state: "connected", listening: true });
  });

  it("never turns a waiting card connected for want of an answer: with an open code it waits on", () => {
    const connected = { state: "connected" as const, listening: true };
    expect(handshakeOf(cli, NO_ANSWER, NOW, undefined)).toEqual({ state: "waiting", code: "ABC234" });
    expect(handshakeOf(cli, NO_ANSWER, NOW, connected)).toEqual({ state: "waiting", code: "ABC234" });
    // An older server's page answers a request it does not know with nothing of the state, which is no answer.
    expect(handshakeOf(cli, { ok: true }, NOW, undefined)).toEqual({ state: "waiting", code: "ABC234" });
    expect(handshakeOf(cli, { ok: false, message: "That agent is gone." }, NOW, undefined)).toEqual({
      state: "waiting",
      code: "ABC234",
    });
  });

  it("without an open code, keeps what it knew when no answer comes, but not whether it listens, and knows nothing more when it knew nothing", () => {
    const none = { methods: ["cli" as const], code: null };
    for (const listening of [true, false, null])
      expect(handshakeOf(none, NO_ANSWER, NOW, { state: "connected", listening })).toEqual({
        state: "connected",
        listening: null,
      });
    expect(handshakeOf(none, NO_ANSWER, NOW, { state: "waiting", code: null })).toEqual({
      state: "waiting",
      code: null,
    });
    expect(handshakeOf(none, NO_ANSWER, NOW, undefined)).toEqual({ state: "unknown" });
  });

  it("offers a new code for one gone or run out, and goes by the agent then, as for a tool an older version connected", () => {
    expect(handshakeOf(cli, state(false, false, false, true), NOW, undefined)).toEqual({
      state: "waiting",
      code: null,
    });
    expect(handshakeOf(cli, state(true, false, true, true), NOW, undefined)).toEqual({
      state: "connected",
      listening: true,
    });
    const old = { methods: ["cli" as const], code: { ...code, at: NOW - CODE_LIFE_MS } };
    expect(handshakeOf(old, state(false, false), NOW, undefined)).toEqual({ state: "waiting", code: null });
    expect(handshakeOf(old, NO_ANSWER, NOW, undefined)).toEqual({ state: "unknown" });
    const none = { methods: ["cli" as const], code: null };
    expect(handshakeOf(none, state(false, false), NOW, undefined)).toEqual({ state: "waiting", code: null });
    expect(handshakeOf(none, state(true, false), NOW, undefined)).toEqual({ state: "connected", listening: false });
  });

  it("shows no code the ledger holds that is not one", () => {
    const odd = { methods: ["cli" as const], code: { ...code, code: "Run rm -rf" } };
    expect(handshakeOf(odd, state(false, false), NOW, undefined)).toEqual({ state: "waiting", code: null });
  });

  it("waits on no code for a tool connected by MCP alone, which has no command to give one back with", () => {
    const mcp = { methods: ["mcp" as const], code: null };
    expect(handshakeOf(mcp, state(false, false), NOW, undefined)).toEqual({ state: "unknown" });
    expect(handshakeOf(mcp, state(true, false, true), NOW, undefined)).toEqual({ state: "connected", listening: true });
  });
});
