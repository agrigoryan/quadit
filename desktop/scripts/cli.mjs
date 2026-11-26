// Builds the quadit command (cmd/quadit) with the web app inside, as
// `make build` does, for each architecture the app is packaged for on this
// system, into cli/<os>-<arch>/quadit (quadit.exe on Windows, <os> being
// Go's name for it: windows), where electron-builder.config.cjs takes it
// into the app's resources. The app uses it three ways: Connect
// (src/main/connections.ts) puts it on the PATH as the command-line client
// when the person has no quadit of their own, "Set up on this computer"
// (src/main/local-server.ts) runs it as a server, which needs the web app,
// and Run by Quadit runs `quadit run` with it (on Windows every program the
// app holds starts under its `quadit guard`: src/main/child-guard.ts).
// Needs Go and pnpm.
//
// Run: node scripts/cli.mjs (pnpm dist runs it).

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

const GOOS = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform];
const EXE = process.platform === "win32" ? ".exe" : "";

/** Runs pnpm with `args` in `cwd`: on Windows it is pnpm.cmd, which only a shell starts (the arguments are the script's own). */
function pnpm(args, cwd) {
  execFileSync("pnpm", args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
}
/** electron-builder's names for the architectures, and Go's. */
const ARCHES = { x64: "amd64", arm64: "arm64" };

rmSync("cli", { recursive: true, force: true });
if (GOOS) {
  const root = join(import.meta.dirname, "..", "..");
  let version = "dev";
  try {
    // The server's own tags only (v*), as the Makefile: the desktop app's (desktop-v*) are another product's.
    version = execFileSync("git", ["describe", "--tags", "--match", "v*", "--always", "--dirty"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    // Not a git checkout: "dev", as the Makefile says.
  }
  // The web app first: the build embeds web/dist.
  const web = join(root, "web");
  pnpm(["install", "--frozen-lockfile"], web);
  pnpm(["build"], web);
  for (const [arch, goarch] of Object.entries(ARCHES)) {
    const out = join(import.meta.dirname, "..", "cli", `${GOOS}-${arch}`, `quadit${EXE}`);
    execFileSync(
      "go",
      ["build", "-tags", "web", "-trimpath", "-ldflags", `-s -w -X main.version=${version}`, "-o", out, "./cmd/quadit"],
      { cwd: root, stdio: "inherit", env: { ...process.env, CGO_ENABLED: "0", GOOS, GOARCH: goarch } },
    );
  }
}
