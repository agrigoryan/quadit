// "A new version is out": the app never installs anything itself. At most
// once a day it reads the project's GitHub releases, and when a desktop
// release (tag desktop-v*) newer than itself is there, it says so once and
// keeps a menu item pointing at the download. Installing it is the person's.

import { readFileSync, writeFileSync } from "node:fs";
import type { Fetch } from "@/main/probe";

export const RELEASES_API = "https://api.github.com/repos/agrigoryan/quadit/releases?per_page=30";
const TAG_PREFIX = "desktop-v";
/** Where the project's releases are: the only pages the update notice opens. */
const RELEASES_PAGE = "https://github.com/agrigoryan/quadit/releases/";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Release {
  version: string;
  /** The release's page, where its downloads are: always one of the project's own (isReleasePage). */
  url: string;
}

/**
 * Whether `url` is a page of the project's releases on GitHub. The notice
 * opens what GitHub's answer, or the file of the last check, says: neither
 * may send the system browser, or the system, anywhere else.
 */
export function isReleasePage(url: string): boolean {
  const parsed = URL.parse(url);
  return !!parsed && parsed.href.startsWith(RELEASES_PAGE) && parsed.href === url;
}

interface GitHubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

/**
 * The newest published desktop release newer than `current`, or null. Drafts
 * and the server's own tags are skipped; pre-releases are skipped only by an
 * app that is not one itself, so a beta hears of the next beta.
 */
export function newerRelease(releases: readonly GitHubRelease[], current: string): Release | null {
  const takesPreReleases = isPreRelease(current);
  let best: Release | null = null;
  for (const release of releases) {
    if (release.draft === true || (release.prerelease === true && !takesPreReleases)) continue;
    if (typeof release.tag_name !== "string" || !release.tag_name.startsWith(TAG_PREFIX)) continue;
    const version = release.tag_name.slice(TAG_PREFIX.length);
    if (!parseVersion(version) || typeof release.html_url !== "string" || !isReleasePage(release.html_url)) continue;
    if (compareVersions(version, best?.version ?? current) > 0) best = { version, url: release.html_url };
  }
  return best;
}

/**
 * Orders versions as Semantic Versioning does: "1.2.3" by number, then a
 * pre-release ("1.0.0-beta.2") before its release, pre-releases by their
 * dot-separated parts (numbers by value, below words). A local build's
 * extra part ("0.1.0-beta.14.1") sits after the beta it builds on. An
 * unreadable version is the oldest.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return left ? 1 : right ? -1 : 0;
  for (let i = 0; i < 3; i++) {
    const diff = left.core[i] - right.core[i];
    if (diff !== 0) return Math.sign(diff);
  }
  if (!left.pre.length || !right.pre.length) return Math.sign(right.pre.length - left.pre.length);
  for (let i = 0; i < Math.min(left.pre.length, right.pre.length); i++) {
    const diff = comparePart(left.pre[i], right.pre[i]);
    if (diff !== 0) return diff;
  }
  return Math.sign(left.pre.length - right.pre.length);
}

function comparePart(a: string, b: string): number {
  const aNumber = /^\d+$/.test(a);
  const bNumber = /^\d+$/.test(b);
  if (aNumber && bNumber) return Math.sign(Number(a) - Number(b));
  if (aNumber !== bNumber) return aNumber ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

const isPreRelease = (version: string) => (parseVersion(version)?.pre.length ?? 0) > 0;

function parseVersion(version: string): { core: number[]; pre: string[] } | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version);
  return match ? { core: match.slice(1, 4).map(Number), pre: match[4]?.split(".") ?? [] } : null;
}

interface Remembered {
  checkedAt: number;
  latest: Release | null;
  /** The version the person was already told about: told once, then only the menu item stays. */
  told: string;
}

/**
 * Watches for a newer release. `onNews` runs whenever what is known changes
 * (for the menu item); `tell` once per new version (for a notice). The last
 * check is kept in `file`, so restarting the app does not check again.
 */
export class UpdateWatch {
  private remembered: Remembered;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private file: string,
    private current: string,
    private fetcher: Fetch,
    private onNews: (release: Release | null) => void,
    private tell: (release: Release) => void,
  ) {
    this.remembered = readRemembered(file);
  }

  /** What is known to be newer than this app now. */
  get available(): Release | null {
    const latest = this.remembered.latest;
    return latest && compareVersions(latest.version, this.current) > 0 ? latest : null;
  }

  /** Checks now if the last check is a day old, then looks again every hour. */
  start() {
    void this.checkIfDue(); // Failures are dropped inside: the next hour tries again.
    this.timer = setInterval(() => void this.checkIfDue(), 60 * 60 * 1000);
    this.timer.unref?.();
    this.onNews(this.available);
  }

  stop() {
    clearInterval(this.timer);
  }

  private async checkIfDue() {
    if (Date.now() - this.remembered.checkedAt < DAY_MS) return;
    let releases: GitHubRelease[];
    try {
      const response = await this.fetcher(RELEASES_API, {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return;
      releases = (await response.json()) as GitHubRelease[];
    } catch {
      return; // Offline or GitHub is down: nothing to say.
    }
    const latest = newerRelease(Array.isArray(releases) ? releases : [], this.current);
    this.remembered = { ...this.remembered, checkedAt: Date.now(), latest };
    this.onNews(this.available);
    if (latest && latest.version !== this.remembered.told) {
      this.remembered.told = latest.version;
      this.tell(latest);
    }
    try {
      writeFileSync(this.file, JSON.stringify(this.remembered));
    } catch {
      // Not remembered: the next start checks again, which is harmless.
    }
  }
}

function readRemembered(file: string): Remembered {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Remembered>;
    const latest = parsed.latest;
    const valid =
      !!latest && typeof latest.version === "string" && typeof latest.url === "string" && isReleasePage(latest.url);
    return { checkedAt: Number(parsed.checkedAt) || 0, latest: valid ? latest : null, told: String(parsed.told ?? "") };
  } catch {
    return { checkedAt: 0, latest: null, told: "" };
  }
}
