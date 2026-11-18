// Builds the app into out/: the main process, the two preloads (sandboxed,
// so each is one file that requires nothing but electron) and the bundled
// pages with their HTML, CSS and icon. esbuild reads the @/ alias from tsconfig.json;
// types are checked separately (pnpm typecheck).

import { cpSync, mkdirSync, rmSync } from "node:fs";
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
  }),
  build({
    ...common,
    entryPoints: ["src/pages/servers.ts", "src/pages/sign-in-bar.ts"],
    outdir: "out/pages",
    platform: "browser",
    format: "iife",
  }),
]);

for (const file of ["servers.html", "sign-in-bar.html", "pages.css"]) cpSync(`src/pages/${file}`, `out/pages/${file}`);
cpSync("assets/icon.png", "out/pages/icon.png");
