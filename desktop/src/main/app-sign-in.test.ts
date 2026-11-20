import { describe, expect, it } from "vitest";
import { AppSignIn } from "@/main/app-sign-in";

/** An AppSignIn whose sign-in answers `signs` and counts how often it was asked. */
function made(signs = true) {
  const asked: string[] = [];
  const signIn = new AppSignIn(async (serverId) => {
    asked.push(serverId);
    return signs;
  });
  return { signIn, asked };
}

describe("AppSignIn", () => {
  it("signs a window in, and says whether it did just now", async () => {
    expect(await made(true).signIn.attempt("a")).toBe(true);
    expect(await made(false).signIn.attempt("a")).toBe(false);
  });

  it("tries once, however often the window lands on the sign-in page, until it has shown a workspace", async () => {
    const { signIn, asked } = made();
    await signIn.attempt("a");
    expect(await signIn.attempt("a")).toBe(false);
    expect(await signIn.attempt("a")).toBe(false);
    expect(asked).toEqual(["a"]);

    // Signed in and shown: a sign-in page after that (the session ran out, or the person signed out) is a new case.
    signIn.showedWorkspace("a");
    expect(await signIn.attempt("a")).toBe(true);
    expect(asked).toEqual(["a", "a"]);
  });

  it("keeps each server's tries apart", async () => {
    const { signIn, asked } = made();
    await signIn.attempt("a");
    await signIn.attempt("b");
    signIn.showedWorkspace("b");
    await signIn.attempt("a");
    await signIn.attempt("b");
    expect(asked).toEqual(["a", "b", "b"]);
  });
});
