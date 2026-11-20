// Builds the quadit command (cmd/quadit) with the web app inside, as
// `make build` does, for each architecture the app is packaged for on this
// system, into cli/<os>-<arch>/quadit, where electron-builder.config.cjs
// takes it into the app's resources. The app uses it twice: Connect
// (src/main/connections.ts) links it onto the PATH as the command-line
// client when the person has no quadit of their own, and "Run Quadit on
// this computer" (src/main/local-server.ts) runs it as a server, which
// needs the web app. Needs Go and pnpm. There is no Windows build of the
// command, so on Windows this builds nothing.
//
// Run: node scripts/cli.mjs (pnpm dist runs it).

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

const GOOS = { darwin: "darwin", linux: "linux" }[process.platform];
/** electron-builder's names for the architectures, and Go's. */
const ARCHES = { x64: "amd64", arm64: "arm64" };

rmSync("cli", { recursive: true, force: true });
if (GOOS) {
  const root = join(import.meta.dirname, "..", "..");
  let version = "dev";
  try {
    version = execFileSync("git", ["describe", "--tags", "--always", "--dirty"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    // Not a git checkout: "dev", as the Makefile says.
  }
  // The web app first: the build embeds web/dist.
  const web = join(root, "web");
  execFileSync("pnpm", ["install", "--frozen-lockfile"], { cwd: web, stdio: "inherit" });
  execFileSync("pnpm", ["build"], { cwd: web, stdio: "inherit" });
  for (const [arch, goarch] of Object.entries(ARCHES)) {
    const out = join(import.meta.dirname, "..", "cli", `${GOOS}-${arch}`, "quadit");
    execFileSync(
      "go",
      ["build", "-tags", "web", "-trimpath", "-ldflags", `-s -w -X main.version=${version}`, "-o", out, "./cmd/quadit"],
      { cwd: root, stdio: "inherit", env: { ...process.env, CGO_ENABLED: "0", GOOS, GOARCH: goarch } },
    );
  }
}
