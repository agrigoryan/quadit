// Looks at the site itself: serves website/ on a free port, photographs the
// whole page at 1440, 768, 390 and 360 pixels wide in the light and the dark
// theme into website/shots/preview/ (kept out of the deployed site), and
// renders the 1200×630 sharing picture og.html describes into website/og.png.
//
//   node website/shots/preview.ts
//   AXE=/path/to/axe.min.js node website/shots/preview.ts    # also runs axe-core on each width and theme
//
// Playwright comes from the web app's own dependencies (web/node_modules).

import { readFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const site = resolve(here, "..");
const root = resolve(site, "..");
const require = createRequire(join(root, "web/package.json"));
const { chromium } = require("@playwright/test") as typeof import("@playwright/test");
const OUT = join(here, "preview");

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml",
  ".png": "image/png", ".webp": "image/webp", ".avif": "image/avif", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  const file = join(site, path.endsWith("/") ? `${path}index.html` : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end(await readFile(join(site, "404.html")).catch(() => "not found"));
  }
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const axe = process.env.AXE ? await readFile(process.env.AXE, "utf8") : "";
let problems = 0;
try {
  for (const theme of ["light", "dark"] as const) {
    for (const width of [1440, 768, 390, 360]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: width < 800 ? 2 : 1, colorScheme: theme });
      await page.goto(`${url}/`);
      await page.evaluate(() => document.fonts.ready);
      // Bring every lazy picture in before the whole-page picture.
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 600) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 40));
        }
        window.scrollTo(0, 0);
      });
      await page.waitForFunction(() => [...document.images].every((i) => i.complete));
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (wide > 0) {
        console.log(`! ${theme} ${width}: the page scrolls sideways by ${wide}px`);
        problems++;
      }
      await page.screenshot({ path: join(OUT, `site-${width}-${theme}.png`), fullPage: true });
      await page.screenshot({ path: join(OUT, `site-${width}-${theme}-top.png`) });
      if (axe) {
        await page.addScriptTag({ content: axe });
        const found = (await page.evaluate(async () => {
          // @ts-expect-error axe is the injected script's global
          const r = await window.axe.run(document, { resultTypes: ["violations"] });
          return r.violations.map((v: { id: string; impact: string; nodes: { target: string[] }[] }) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 4).join(", ")}`);
        })) as string[];
        for (const f of found) console.log(`! axe ${theme} ${width}: ${f}`);
        problems += found.length;
      }
      console.log(`  site-${width}-${theme}.png`);
      await page.close();
    }
  }
  const og = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await og.goto(`${url}/shots/og.html`);
  await og.evaluate(() => document.fonts.ready);
  await og.waitForFunction(() => [...document.images].every((i) => i.complete));
  await og.screenshot({ path: join(site, "og.png") });
  console.log("  og.png");
} finally {
  await browser.close();
  server.close();
}
if (problems) {
  console.log(`${problems} problem(s)`);
  process.exitCode = 1;
}
