import { describe, expect, it } from "vitest";
import { AppSignIn } from "@/main/app-sign-in";

/** Lets promises run. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((done) => setImmediate(done));
}

/**
 * An AppSignIn whose sign-in gives the answers in `answers`, one per ask
 * (then true), and whose check of a session says `signedIn`; both note
 * each ask. `held` keeps each sign-in pending until `release`.
 */
function made(answers: boolean[] = [], { held = false } = {}) {
  const asked: string[] = [];
  const checked: string[] = [];
  let signedIn = true;
  const waiting: (() => void)[] = [];
  const signIn = new AppSignIn({
    signIn: async (serverId) => {
      asked.push(serverId);
      if (held) await new Promise<void>((done) => waiting.push(done));
      return answers.shift() ?? true;
    },
    isSignedIn: async (serverId) => {
      checked.push(serverId);
      return signedIn;
    },
  });
  return {
    signIn,
    asked,
    checked,
    release: () => waiting.splice(0).forEach((done) => done()),
    sessionSays: (now: boolean) => (signedIn = now),
  };
}

describe("AppSignIn", () => {
  it("signs a window in, and says whether it did just now", async () => {
    expect(await made([true]).signIn.attempt("a")).toBe(true);
    expect(await made([false]).signIn.attempt("a")).toBe(false);
  });

  it("has one sign-in in flight per server: a second caller waits for the first's outcome", async () => {
    const { signIn, asked, release } = made([true], { held: true });
    const first = signIn.attempt("a");
    const second = signIn.attempt("a");
    await settle();
    expect(asked).toEqual(["a"]);
    release();
    expect(await Promise.all([first, second])).toEqual([true, true]);
  });

  it("from the sign-in page, lets the window go on when it signed it in and nothing has moved it since", async () => {
    const { signIn, asked } = made([true, false]);
    expect(await signIn.fromSignInPage("a")).toBe(true);
    // Not signed in by the app (here: held back after the one that worked): nowhere to go.
    expect(await signIn.fromSignInPage("a")).toBe(false);
    expect(asked).toEqual(["a"]);
  });

  it("lets only the newest sign-in page go on: one that landed while a sign-in was under way joins it and takes over", async () => {
    const { signIn, asked, release } = made([true], { held: true });
    // The web app sent its signed-out page to the sign-in page; then another sign-in page came (a link).
    const older = signIn.fromSignInPage("a");
    signIn.navigationStarted("a");
    const newer = signIn.fromSignInPage("a");
    await settle();
    release();
    expect(await Promise.all([older, newer])).toEqual([false, true]);
    expect(asked).toEqual(["a"]);
  });

  it("does not let a sign-in page go on once a navigation of the window has started since it landed", async () => {
    const { signIn, release } = made([true], { held: true });
    const landed = signIn.fromSignInPage("a");
    // Started, and not shown yet: going on would cancel it.
    signIn.navigationStarted("a");
    await settle();
    release();
    expect(await landed).toBe(false);
  });

  it("after a sign-in that worked, signs in again only once a navigation outside the sign-in page has ended signed in", async () => {
    const { signIn, asked, checked, sessionSays } = made();
    expect(await signIn.attempt("a")).toBe(true);
    // Sent back to the sign-in page again and again: no loop.
    signIn.navigated("a", true);
    expect(await signIn.attempt("a")).toBe(false);
    expect(asked).toEqual(["a"]);
    expect(checked).toEqual([]);

    // A page outside the sign-in page, but not signed in there (on its way back to the sign-in page): still held.
    sessionSays(false);
    signIn.navigated("a", false);
    await settle();
    expect(await signIn.attempt("a")).toBe(false);

    // Signed in on a page (a workspace, the admin pages): a later sign-in page is a new case.
    sessionSays(true);
    signIn.navigated("a", false);
    await settle();
    expect(await signIn.attempt("a")).toBe(true);
    expect(asked).toEqual(["a", "a"]);
  });

  it("asks nothing about a navigation while it holds nothing back", async () => {
    const { signIn, checked } = made([false]);
    signIn.navigated("a", false);
    await signIn.attempt("a");
    signIn.navigated("a", false);
    await settle();
    expect(checked).toEqual([]);
  });

  it("lets go of what it held back when the server starts anew", async () => {
    const { signIn, asked } = made();
    await signIn.attempt("a");
    signIn.serverStarted("a");
    expect(await signIn.attempt("a")).toBe(true);
    expect(asked).toEqual(["a", "a"]);
  });

  it("asks again after one that did not sign in, which sends the window nowhere", async () => {
    const { signIn, asked } = made([false, false]);
    expect(await signIn.attempt("a")).toBe(false);
    expect(await signIn.attempt("a")).toBe(false);
    expect(asked).toEqual(["a", "a"]);
  });

  it("keeps each server's sign-ins apart", async () => {
    const { signIn, asked } = made();
    await signIn.attempt("a");
    await signIn.attempt("b");
    signIn.serverStarted("b");
    await signIn.attempt("a");
    await signIn.attempt("b");
    expect(asked).toEqual(["a", "b", "b"]);
  });
});
