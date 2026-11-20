import { describe, expect, it } from "vitest";
import { AppSignIn } from "@/main/app-sign-in";

/** An AppSignIn whose sign-in gives the answers in `answers`, one per ask (then true), and notes each ask. */
function made(answers: boolean[] = []) {
  const asked: string[] = [];
  const signIn = new AppSignIn(async (serverId) => {
    asked.push(serverId);
    return answers.shift() ?? true;
  });
  return { signIn, asked };
}

describe("AppSignIn", () => {
  it("signs a window in, and says whether it did just now", async () => {
    expect(await made([true]).signIn.attempt("a")).toBe(true);
    expect(await made([false]).signIn.attempt("a")).toBe(false);
  });

  it("after a sign-in that worked, does not sign in again until the window has shown a workspace", async () => {
    const { signIn, asked } = made();
    expect(await signIn.attempt("a")).toBe(true);
    // Sent back to the sign-in page again and again: no loop.
    expect(await signIn.attempt("a")).toBe(false);
    expect(await signIn.attempt("a")).toBe(false);
    expect(asked).toEqual(["a"]);

    // Signed in and shown: a sign-in page after that (the session ran out, or the person signed out) is a new case.
    signIn.showedWorkspace("a");
    expect(await signIn.attempt("a")).toBe(true);
    expect(asked).toEqual(["a", "a"]);
  });

  it("asks again at the next load after one that did not sign in, which sends the window nowhere", async () => {
    const { signIn, asked } = made([false, false]);
    expect(await signIn.attempt("a")).toBe(false);
    expect(await signIn.attempt("a")).toBe(false);
    expect(asked).toEqual(["a", "a"]);
  });

  it("keeps each server's sign-ins apart", async () => {
    const { signIn, asked } = made();
    await signIn.attempt("a");
    await signIn.attempt("b");
    signIn.showedWorkspace("b");
    await signIn.attempt("a");
    await signIn.attempt("b");
    expect(asked).toEqual(["a", "b", "b"]);
  });
});
