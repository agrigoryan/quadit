import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
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
    const cli = new QuaditCli(null, async () => "");
    // Large enough that writing it outlasts the command: the write fails (EPIPE), which must not escape.
    await expect(cli.login(quadit, "https://q.example", "qd_".padEnd(4_000_000, "x"), "/nowhere.json")).rejects.toThrow(
      "quadit login: usage: quadit login URL TOKEN",
    );
  });
});
