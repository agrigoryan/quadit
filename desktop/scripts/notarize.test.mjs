import { describe, expect, it } from "vitest";
import { credentials, notarize } from "./notarize.mjs";

const KEY = { APPLE_API_KEY: "/k.p8", APPLE_API_KEY_ID: "KID", APPLE_API_ISSUER: "ISS" };
const AS = ["--key", "/k.p8", "--key-id", "KID", "--issuer", "ISS"];

/**
 * Apple's side, as the commands see it: `status` is what it says of the
 * submission, and `waiting` what happens to the wait for it. Every command
 * run is kept in `ran`, as "tool verb".
 */
function apple({ status, waiting = () => "" }) {
  const ran = [];
  const run = async (tool, args) => {
    const verb = tool === "xcrun" ? `${args[0]} ${args[1]}` : tool;
    ran.push(verb);
    if (verb === "notarytool submit") return JSON.stringify({ id: "sub-1", message: "Successfully uploaded file" });
    if (verb === "notarytool wait") return waiting();
    if (verb === "notarytool info") return JSON.stringify({ id: "sub-1", status });
    if (verb === "notarytool log") return '{"issues":[{"message":"The binary is not signed."}]}';
    return "";
  };
  return { run, ran };
}

const quiet = () => {};

describe("notarize", () => {
  it("staples the app Apple accepted", async () => {
    const { run, ran } = apple({ status: "Accepted" });
    const result = await notarize("/out/Quadit.app", { run, as: AS, waitMinutes: 15, say: quiet });
    expect(result).toBe("stapled");
    expect(ran).toEqual(["ditto", "notarytool submit", "notarytool wait", "notarytool info", "stapler staple"]);
  });

  it("asks for the verdict even when the wait for it broke off", async () => {
    const { run, ran } = apple({
      status: "Accepted",
      waiting: () => {
        throw new Error("The Internet connection appears to be offline");
      },
    });
    expect(await notarize("/out/Quadit.app", { run, as: AS, waitMinutes: 15, say: quiet })).toBe("stapled");
    expect(ran).toContain("stapler staple");
  });

  it("refuses an app Apple has not answered for", async () => {
    const { run, ran } = apple({ status: "In Progress" });
    await expect(notarize("/out/Quadit.app", { run, as: AS, waitMinutes: 15, say: quiet })).rejects.toThrow(
      /sub-1.*no verdict/,
    );
    expect(ran).not.toContain("stapler staple");
  });

  it("lets an unanswered app through when that is allowed, unstapled and said aloud", async () => {
    const { run, ran } = apple({ status: "In Progress" });
    const said = [];
    const result = await notarize("/out/Quadit.app", {
      run,
      as: AS,
      waitMinutes: 15,
      unansweredOk: true,
      say: (line) => said.push(line),
    });
    expect(result).toBe("unanswered");
    expect(ran).not.toContain("stapler staple");
    expect(said.join("\n")).toMatch(/::warning::.*sub-1/);
  });

  it("refuses an app Apple refused, with Apple's reasons", async () => {
    const { run, ran } = apple({ status: "Invalid" });
    const said = [];
    await expect(
      notarize("/out/Quadit.app", { run, as: AS, waitMinutes: 15, unansweredOk: true, say: (line) => said.push(line) }),
    ).rejects.toThrow(/sub-1.*Invalid/);
    expect(ran).toContain("notarytool log");
    expect(said.join("\n")).toContain("The binary is not signed.");
  });
});

describe("credentials", () => {
  it("is the App Store Connect key when there is one", () => {
    expect(credentials(KEY)).toEqual(AS);
  });

  it("is the Apple ID otherwise", () => {
    expect(credentials({ APPLE_ID: "a@b.c", APPLE_APP_SPECIFIC_PASSWORD: "pw", APPLE_TEAM_ID: "TEAM" })).toEqual([
      "--apple-id",
      "a@b.c",
      "--password",
      "pw",
      "--team-id",
      "TEAM",
    ]);
  });

  it("is nothing without either", () => {
    expect(credentials({ APPLE_ID: "a@b.c" })).toBeNull();
  });
});
