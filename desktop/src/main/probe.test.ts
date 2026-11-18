import { describe, expect, it } from "vitest";
import { type Fetch, probe } from "@/main/probe";

/** A server that answers each path with the given status and JSON body. */
function server(answers: Record<string, [number, unknown, Record<string, string>?]>): Fetch {
  return async (url) => {
    const path = new URL(url).pathname;
    const [status, body, headers] = answers[path] ?? [404, { error: "not found" }];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  };
}

const ORIGIN = "https://quadit.example.com";

describe("probe", () => {
  it("knows a server that speaks this app's hand-off", async () => {
    const answer = await probe(
      ORIGIN,
      server({
        "/api/v1/version": [200, { name: "quadit", version: "1.4.0", surface: "abc", desktop: { handoff: 1 } }],
      }),
    );
    expect(answer).toEqual({ reachable: true, version: "1.4.0", handoff: 1, fit: "ok" });
  });

  it("says when the server speaks a newer hand-off than the app", async () => {
    const answer = await probe(
      ORIGIN,
      server({ "/api/v1/version": [200, { name: "quadit", version: "3.0.0", desktop: { handoff: 2 } }] }),
    );
    expect(answer).toMatchObject({ reachable: true, fit: "new-server" });
  });

  it("knows a Quadit from before the desktop app by its sign-in settings", async () => {
    const answer = await probe(
      ORIGIN,
      server({ "/api/v1/auth/config": [200, { setup_needed: false, version: "0.9.0", password: true }] }),
    );
    expect(answer).toEqual({ reachable: true, version: "0.9.0", handoff: 0, fit: "old-server" });
  });

  it("refuses a server that is not Quadit", async () => {
    expect(await probe(ORIGIN, server({}))).toMatchObject({
      reachable: false,
      reason: expect.stringContaining("does not answer as a Quadit server"),
    });
    expect(await probe(ORIGIN, server({ "/api/v1/version": [200, "<html>hello</html>"] }))).toMatchObject({
      reachable: false,
    });
    expect(await probe(ORIGIN, server({ "/api/v1/version": [200, { name: "other" }] }))).toMatchObject({
      reachable: false,
    });
  });

  it("names the address a server redirects to", async () => {
    const answer = await probe(
      "http://quadit.example.com",
      server({ "/api/v1/version": [301, "", { location: "https://quadit.example.com/api/v1/version" }] }),
    );
    expect(answer).toMatchObject({ reachable: false, reason: expect.stringContaining("https://quadit.example.com") });
  });

  it("says when the server cannot be reached", async () => {
    const down: Fetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await probe(ORIGIN, down)).toMatchObject({
      reachable: false,
      reason: expect.stringContaining("Could not reach"),
    });
  });
});
