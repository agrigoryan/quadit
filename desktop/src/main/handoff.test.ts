import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { challengeOf, SignInFlows } from "@/main/handoff";

const ORIGIN = "https://quadit.example.com";

function started(flows: SignInFlows, origin = ORIGIN) {
  const url = new URL(flows.begin("srv1", origin));
  return { url, state: url.searchParams.get("state") ?? "", challenge: url.searchParams.get("challenge") ?? "" };
}

describe("SignInFlows", () => {
  it("sends the browser to the server's connect page with a fresh state and an S256 challenge", () => {
    const flows = new SignInFlows();
    const one = started(flows);
    const two = started(flows);
    expect(one.url.origin + one.url.pathname).toBe(`${ORIGIN}/desktop/connect`);
    expect([...one.url.searchParams.keys()].sort()).toEqual(["challenge", "state"]);
    // 32 random bytes in base64url, no padding.
    expect(one.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(one.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(two.state).not.toBe(one.state);
    expect(two.challenge).not.toBe(one.challenge);
  });

  it("redeems a link for the flow it started with a verifier that matches the challenge", () => {
    const flows = new SignInFlows();
    const { state, challenge } = started(flows);
    const redeemed = flows.redeem({ server: ORIGIN, code: "Z9", state });
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) return;
    expect(redeemed.serverId).toBe("srv1");
    const finish = new URL(redeemed.finishUrl);
    expect(finish.origin + finish.pathname).toBe(`${ORIGIN}/desktop/finish`);
    expect(finish.searchParams.get("code")).toBe("Z9");
    const verifier = finish.searchParams.get("verifier") ?? "";
    // RFC 7636: 43 to 128 characters of the unreserved set.
    expect(verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(challenge);
    expect(challengeOf(verifier)).toBe(challenge);
  });

  it("uses a state once", () => {
    const flows = new SignInFlows();
    const { state } = started(flows);
    expect(flows.redeem({ server: ORIGIN, code: "Z", state }).ok).toBe(true);
    expect(flows.redeem({ server: ORIGIN, code: "Z", state }).ok).toBe(false);
  });

  it("refuses a state it never made", () => {
    const flows = new SignInFlows();
    started(flows);
    expect(flows.redeem({ server: ORIGIN, code: "Z", state: "made-up" })).toMatchObject({ ok: false });
  });

  it("refuses a link naming another server than the flow's, and drops that flow", () => {
    const flows = new SignInFlows();
    const { state } = started(flows);
    expect(flows.redeem({ server: "https://evil.example.com", code: "Z", state })).toMatchObject({ ok: false });
    expect(flows.redeem({ server: ORIGIN, code: "Z", state })).toMatchObject({ ok: false });
  });

  it("forgets flows after a while", () => {
    let now = 1_000_000;
    const flows = new SignInFlows(() => now);
    const { state } = started(flows);
    now += 16 * 60 * 1000;
    expect(flows.redeem({ server: ORIGIN, code: "Z", state })).toMatchObject({ ok: false });
  });
});
