// Builds the app into out/: the main process, the two preloads (sandboxed,
// so each is one file that requires nothing but electron) and the bundled
// pages with their HTML, CSS and icon. esbuild reads the @/ alias from tsconfig.json;
// types are checked separately (pnpm typecheck).

import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { build } from "esbuild";

rmSync("out", { recursive: true, force: true });
mkdirSync("out/pages", { recursive: true });

const common = { bundle: true, sourcemap: "linked", logLevel: "warning", target: "es2023" };

await Promise.all([
  build({
    ...common,
    entryPoints: {
      main: "src/main/main.ts",
      "preload-bridge": "src/preload/bridge.ts",
      "preload-pages": "src/preload/pages.ts",
    },
    outdir: "out",
    platform: "node",
    format: "cjs",
    external: ["electron"],
    // A package's ES module entry first: a UMD entry (jsonc-parser's) loads
    // its parts with a require esbuild cannot follow, which the bundle would
    // keep and which finds nothing in out/.
    mainFields: ["module", "main"],
  }),
  build({
    ...common,
    entryPoints: [
      "src/pages/servers.ts",
      "src/pages/sign-in-bar.ts",
      "src/pages/connection-error.ts",
      "src/pages/setup.ts",
      "src/pages/connect.ts",
      "src/pages/panel.ts",
      "src/pages/capture.ts",
    ],
    outdir: "out/pages",
    platform: "browser",
    format: "iife",
  }),
]);

const pages = ["servers", "sign-in-bar", "connection-error", "setup", "connect", "panel", "capture"];
for (const file of [...pages.map((page) => `${page}.html`), "pages.css"])
  cpSync(`src/pages/${file}`, `out/pages/${file}`);
cpSync("assets/icon.png", "out/pages/icon.png");

// Every bundle must be whole: a relative require left in one (esbuild renames
// require to require2 and so on inside a module it wraps) finds nothing in
// out/, and the app would fail only once started.
for (const file of [
  ...readdirSync("out").map((f) => `out/${f}`),
  ...readdirSync("out/pages").map((f) => `out/pages/${f}`),
]) {
  if (!file.endsWith(".js")) continue;
  const left = readFileSync(file, "utf8").match(/\brequire\d*\(\s*["'`]\.\.?\/[^"'`]*/);
  if (left) throw new Error(`${file} still requires a file of its own (${left[0]}): the bundle is not whole`);
}
