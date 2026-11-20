// What website-downloads.mjs writes into the page: node --test scripts/website-downloads.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { fill, newestDesktopRelease } from "./website-downloads.mjs";

const asset = (name) => ({ name, browser_download_url: `https://example.test/dl/${name}` });
const release = (tag, { prerelease = false, draft = false, names = [] } = {}) => ({
  tag_name: tag,
  prerelease,
  draft,
  html_url: `https://example.test/releases/${tag}`,
  assets: names.map(asset),
});

test("the newest finished desktop release is chosen, a stable one before any pre-release", () => {
  const releases = [
    release("desktop-v0.3.0-beta.1", { prerelease: true }),
    release("v0.2.0"),
    release("desktop-v0.2.0"),
    release("desktop-v0.1.0"),
  ];
  assert.equal(newestDesktopRelease(releases).tag_name, "desktop-v0.2.0");
});

test("with no stable desktop release, the newest pre-release is chosen; a draft or a server release never is", () => {
  const releases = [
    release("desktop-v0.1.0-beta.5", { prerelease: true, draft: true }),
    release("v0.1.0"),
    release("desktop-v0.1.0-beta.4", { prerelease: true }),
    release("desktop-v0.1.0-beta.2", { prerelease: true }),
  ];
  assert.equal(newestDesktopRelease(releases).tag_name, "desktop-v0.1.0-beta.4");
  assert.equal(newestDesktopRelease([release("v0.1.0")]), null);
});

test("each download link gets its file's address, the release link the release's, and the version is written", () => {
  const html = [
    '<a class="btn" data-asset="mac-arm64.dmg" href="https://github.com/o/r/releases">Download for Mac</a>',
    '<a data-asset="win-x64.exe" href="https://github.com/o/r/releases">Windows</a>',
    '<a data-release href="https://github.com/o/r/releases">All files</a>',
    "<span data-dl-version>Pre-release</span>",
    '<a href="https://github.com/o/r/releases">Releases</a>',
  ].join("\n");
  const chosen = release("desktop-v0.1.0-beta.4", {
    prerelease: true,
    names: ["Quadit-0.1.0-beta.4-mac-arm64.dmg", "Quadit-0.1.0-beta.4-win-x64.exe", "Quadit-0.1.0-beta.4-win.exe"],
  });
  assert.equal(
    fill(html, chosen),
    [
      '<a class="btn" data-asset="mac-arm64.dmg" href="https://example.test/dl/Quadit-0.1.0-beta.4-mac-arm64.dmg">Download for Mac</a>',
      '<a data-asset="win-x64.exe" href="https://example.test/dl/Quadit-0.1.0-beta.4-win-x64.exe">Windows</a>',
      '<a data-release href="https://example.test/releases/desktop-v0.1.0-beta.4">All files</a>',
      "<span data-dl-version>Version 0.1.0-beta.4</span>",
      '<a href="https://github.com/o/r/releases">Releases</a>',
    ].join("\n"),
  );
});

test("a link whose file the release does not have keeps the address it had", () => {
  const html = '<a data-asset="linux-x86_64.AppImage" href="https://github.com/o/r/releases">Linux</a>';
  assert.equal(fill(html, release("desktop-v0.1.0", { names: ["Quadit-0.1.0-mac-arm64.dmg"] })), html);
});
