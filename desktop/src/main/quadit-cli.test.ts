import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { QuaditCli } from "@/main/quadit-cli";

/** Connect runs only on macOS and Linux (no Windows build of quadit); these tests need a POSIX shell, links and file modes. */
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("QuaditCli", () => {
  it("gives a quadit's own refusal when it exits without reading the token", async () => {
    const quadit = join(mkdtempSync(join(tmpdir(), "quadit-desktop-cli-")), "quadit");
    writeFileSync(quadit, "#!/bin/sh\necho 'usage: quadit login URL TOKEN' >&2\nexit 2\n");
    chmodSync(quadit, 0o755);
    const cli = new QuaditCli(null, async () => "", { home: "/nowhere", shell: "/bin/sh" });
    // Large enough that writing it outlasts the command: the write fails (EPIPE), which must not escape.
    await expect(cli.login(quadit, "https://q.example", "qd_".padEnd(4_000_000, "x"), "/nowhere.json")).rejects.toThrow(
      "quadit login: usage: quadit login URL TOKEN",
    );
  });
});

/** A home folder of its own, a folder that may be on PATH, and an executable `quadit` file to link. */
function computer() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "quadit-desktop-cli-home-")));
  const home = join(root, "home");
  mkdirSync(home);
  return { root, home, own: join(home, ".local", "bin"), missing: join(root, "not-a-folder") };
}

posixOnly("QuaditCli, where the app's copy goes", () => {
  it("links into the first folder on the PATH the person may write to", async () => {
    const { root, home } = computer();
    const cli = new QuaditCli("/app/quadit", async () => `${join(root, "nope")}:${root}`, { home, shell: "/bin/zsh" });
    expect((await cli.look()).linkInto).toEqual({ folder: root, profile: null });
  });

  it("without one, uses ~/.local/bin, put on the PATH by a line in the profile the login shell reads", async () => {
    const { home, own, missing } = computer();
    const look = (shell: string) => new QuaditCli("/app/quadit", async () => missing, { home, shell }).look();
    const shLine =
      'export PATH="$HOME/.local/bin:$PATH" # Added by the Quadit app: Disconnect in the app takes it out.';
    expect((await look("/bin/zsh")).linkInto).toEqual({
      folder: own,
      profile: { path: join(home, ".zprofile"), line: shLine },
    });
    // bash reads ~/.bash_profile at login when there is one, else ~/.profile.
    expect((await look("/bin/bash")).linkInto?.profile?.path).toBe(join(home, ".profile"));
    writeFileSync(join(home, ".bash_profile"), "");
    expect((await look("/usr/local/bin/bash")).linkInto?.profile).toEqual({
      path: join(home, ".bash_profile"),
      line: shLine,
    });
    // fish: a file of its own, which fish reads at every start.
    expect((await look("/opt/homebrew/bin/fish")).linkInto?.profile).toEqual({
      path: join(home, ".config", "fish", "conf.d", "quadit.fish"),
      line: "fish_add_path --global --path $HOME/.local/bin # Added by the Quadit app: Disconnect in the app takes it out.",
    });
  });

  it("needs no profile line where ~/.local/bin is on the PATH already but not there yet, as Linux does", async () => {
    const { home, own, missing } = computer();
    const cli = new QuaditCli("/app/quadit", async () => `${missing}:${own}`, { home, shell: "/bin/bash" });
    expect((await cli.look()).linkInto).toEqual({ folder: own, profile: null });
  });

  it("has nowhere to link for a shell whose profile it does not know", async () => {
    const { home, missing } = computer();
    const cli = new QuaditCli("/app/quadit", async () => missing, { home, shell: "/bin/tcsh" });
    expect((await cli.look()).linkInto).toBeNull();
  });

  it("finds the copy it linked this session, which a login shell started before may not show yet", async () => {
    const { home, own, missing } = computer();
    const stand = join(home, "quadit-real");
    writeFileSync(stand, "#!/bin/sh\necho 'quadit 9.9.9 (agent surface 2.0)'\n");
    chmodSync(stand, 0o755);
    const cli = new QuaditCli(stand, async () => missing, { home, shell: "/bin/zsh" });
    expect((await cli.look()).found).toBeNull();
    mkdirSync(own, { recursive: true });
    symlinkSync(stand, join(own, "quadit"));
    cli.linked(join(own, "quadit"));
    expect(await cli.look()).toMatchObject({ found: { path: join(own, "quadit"), version: "9.9.9" }, linkInto: null });
  });
});
