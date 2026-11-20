// Writes the desktop app's download addresses into the website before it is
// published (pages.yml): in the pages of a folder, every link with
// data-asset="mac-arm64.dmg" gets the address of the newest desktop
// release's file of that ending, a link with data-release the release's own
// page, and an element with data-dl-version its version. As committed, the
// links go to the releases page, so the site works unfilled too.
//
// The desktop app's releases are tagged desktop-v* and are never the
// repository's Latest (that is the server's), so there is no fixed address
// for "the newest app": this looks it up. A stable release is chosen before
// any pre-release.
//
// Run: node scripts/website-downloads.mjs _site   (GITHUB_REPOSITORY, GITHUB_TOKEN)

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_TAG = "desktop-v";

/** The release the site offers, of GitHub's list (newest first); null without one. */
export function newestDesktopRelease(releases) {
  const finished = releases.filter((r) => r.tag_name.startsWith(DESKTOP_TAG) && !r.draft);
  return finished.find((r) => !r.prerelease) ?? finished[0] ?? null;
}

/** `html` with the release's addresses and version written into the marked links and elements. */
export function fill(html, release) {
  const version = release.tag_name.slice(DESKTOP_TAG.length);
  return html
    .replace(/(<a\b[^>]*\bdata-asset="([^"]+)"[^>]*\bhref=")([^"]*)(")/g, (whole, before, ending, _was, after) => {
      const file = release.assets.find((a) => a.name.endsWith(`-${ending}`));
      return file ? before + file.browser_download_url + after : whole;
    })
    .replace(/(<a\b[^>]*\bdata-release\b[^>]*\bhref=")[^"]*(")/g, `$1${release.html_url}$2`)
    .replace(/(<[a-z]+\b[^>]*\bdata-dl-version\b[^>]*>)[^<]*(<)/g, `$1Version ${version}$2`);
}

async function main(dir) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY is not set");
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "website-downloads" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const answer = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, { headers });
  if (!answer.ok) throw new Error(`the releases of ${repo}: ${answer.status} ${await answer.text()}`);
  const release = newestDesktopRelease(await answer.json());
  if (!release) {
    console.log("No desktop release yet: the links stay on the releases page.");
    return;
  }
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".html"))) {
    const path = join(dir, name);
    const html = readFileSync(path, "utf8");
    const filled = fill(html, release);
    if (filled !== html) writeFileSync(path, filled);
  }
  console.log(`Download links: ${release.tag_name}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node scripts/website-downloads.mjs SITE_DIR");
    process.exit(2);
  }
  await main(dir);
}
