import { describe, expect, it } from "vitest";
import { deepLinkInArgs, parseDeepLink } from "@/main/deep-link";

const server = encodeURIComponent("https://quadit.example.com");

describe("parseDeepLink", () => {
  it("reads a connect link as the server sends it", () => {
    expect(parseDeepLink(`quadit://connect?server=${server}&code=Z1&state=S1`)).toEqual({
      kind: "connect",
      server: "https://quadit.example.com",
      code: "Z1",
      state: "S1",
    });
  });

  it("reads an open link, and the root when it has no path", () => {
    expect(parseDeepLink(`quadit://open?server=${server}&path=${encodeURIComponent("/e2e/tasks/ABC-1")}`)).toEqual({
      kind: "open",
      server: "https://quadit.example.com",
      path: "/e2e/tasks/ABC-1",
    });
    expect(parseDeepLink(`quadit://open?server=${server}`)).toMatchObject({ path: "/" });
  });

  it("accepts the action as host or as path", () => {
    expect(parseDeepLink(`quadit:open?server=${server}&path=/e2e`)).toMatchObject({ kind: "open" });
    expect(parseDeepLink(`quadit:///open/?server=${server}&path=/e2e`)).toMatchObject({ kind: "open" });
  });

  it("keeps the server to an origin", () => {
    const link = parseDeepLink(
      `quadit://open?server=${encodeURIComponent("https://quadit.example.com/sub/path?q=1")}&path=/e2e`,
    );
    expect(link).toMatchObject({ server: "https://quadit.example.com" });
  });

  it("refuses links that are incomplete, foreign or point elsewhere", () => {
    for (const raw of [
      "https://quadit.example.com/desktop/connect",
      `quadit://connect?server=${server}&code=Z1`,
      `quadit://connect?server=${server}&state=S1`,
      "quadit://connect?code=Z1&state=S1",
      `quadit://connect?server=${encodeURIComponent("javascript:alert(1)")}&code=Z&state=S`,
      `quadit://open?server=${server}&path=${encodeURIComponent("//evil.com/x")}`,
      `quadit://open?server=${server}&path=${encodeURIComponent("https://evil.com/")}`,
      // Someone else's sign-in code: followed, the app would be signed in to their account.
      `quadit://open?server=${server}&path=${encodeURIComponent("/desktop/finish?code=Z&verifier=V")}`,
      `quadit://open?server=${server}&path=${encodeURIComponent("/api/v1/auth/logout")}`,
      `quadit://delete?server=${server}`,
      "quadit://",
      "not a link",
    ]) {
      expect(parseDeepLink(raw), raw).toBeNull();
    }
  });
});

describe("deepLinkInArgs", () => {
  it("finds the link Windows and Linux pass as an argument", () => {
    expect(deepLinkInArgs(["/opt/Quadit/quadit", "--no-sandbox", "quadit://open?server=x"])).toBe(
      "quadit://open?server=x",
    );
    expect(deepLinkInArgs(["/opt/Quadit/quadit", "--flag"])).toBeNull();
  });
});
