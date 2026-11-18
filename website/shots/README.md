# The website's pictures

Everything in `website/img/` is a screenshot of the real app, taken from a demo workspace, or one of the option pictures in that workspace. This folder holds the tools that make them; the Pages workflow leaves it out of the published site.

| File | What it does |
| --- | --- |
| `seed.sh` | Fills a fresh server with the demo workspace "Harbor Studio": three people, four agents (Atlas, Iris, Forge, Scout), the Tidewell project with a cycle, epics, milestones, tasks across statuses, results with evidence, an open decision with a picture per option, answered decisions, a launch plan page with a comment thread on selected words, and a Tide stations database. All made up |
| `art/` | The decision's option pictures (three app icons), made for this workspace with the image generation of the Codex CLI. Original; nothing copied |
| `capture.ts` | Starts `bin/quadit` on a free port with a new, empty data directory, runs `seed.sh`, signs in as the owner and takes the screenshots into `raw/` (ignored by git): the app's dark theme, device pixel ratio 2, desktop 1440×900 and phone 390×844 |
| `optimize.sh` | Turns `raw/*.png` into `website/img/`: AVIF and WebP at full and half size for `srcset`, and a PNG at half size as the fallback. Screens only the repository's README shows (the inbox) get the PNG alone |
| `og.html` | The 1200×630 sharing picture, rendered to `website/og.png` by `preview.ts` |
| `preview.ts` | Serves `website/`, takes whole-page screenshots at 1440, 768, 390 and 360 pixels wide in both themes into `preview/` (ignored by git), fails if the page scrolls sideways, and with `AXE=` runs axe-core on each |

## Regenerate

From the repository's root, with Go, pnpm, Node 24 or later and ImageMagick 7:

```bash
make build                                   # the binary capture.ts runs
cd web && pnpm exec playwright install chromium && cd ..   # once
node website/shots/capture.ts                # raw/*.png, about half a minute
website/shots/optimize.sh                    # website/img/
node website/shots/preview.ts                # website/og.png and preview/
```

`capture.ts` never touches another server: it makes its own data directory in the system's temp folder and removes it when done. To photograph a server you already seeded, give its address: `QUADIT_SHOTS_URL=http://127.0.0.1:4791 node website/shots/capture.ts`.

To check accessibility as well, fetch axe-core (`npm pack axe-core`, then unpack it) and run `AXE=path/to/axe.min.js node website/shots/preview.ts`.

When the app's screens change, run the three steps again and look at `preview/` before committing the new `website/img/`. If a screenshot fails to find something, the app's labels changed: `capture.ts` finds things by role and name, as the end-to-end tests do.

## Preview the site

```bash
python3 -m http.server -d website 8000       # http://localhost:8000
```
