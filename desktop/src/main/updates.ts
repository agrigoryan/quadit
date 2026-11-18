// "A new version is out": the app never installs anything itself. At most
// once a day it reads the project's GitHub releases, and when a desktop
// release (tag desktop-v*) newer than itself is there, it says so once and
// keeps a menu item pointing at the download. Updating is the package
// manager's job (brew upgrade --cask quadit-desktop) or the person's.

import { readFileSync, writeFileSync } from "node:fs";
import type { Fetch } from "@/main/probe";

export const RELEASES_API = "https://api.github.com/repos/agrigoryan/quadit/releases?per_page=30";
const TAG_PREFIX = "desktop-v";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Release {
  version: string;
  /** The release's page, where its downloads are. */
  url: string;
}

interface GitHubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

/** The newest published desktop release newer than `current`, or null. Drafts, pre-releases and the server's own tags are skipped. */
export function newerRelease(releases: readonly GitHubRelease[], current: string): Release | null {
  let best: Release | null = null;
  for (const release of releases) {
    if (release.draft === true || release.prerelease === true) continue;
    if (typeof release.tag_name !== "string" || !release.tag_name.startsWith(TAG_PREFIX)) continue;
    const version = release.tag_name.slice(TAG_PREFIX.length);
    if (!parseVersion(version) || typeof release.html_url !== "string") continue;
    if (compareVersions(version, best?.version ?? current) > 0) best = { version, url: release.html_url };
  }
  return best;
}

/** Orders "1.2.3" style versions; anything after a "-" (a pre-release) is ignored. An unreadable version is the oldest. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a) ?? [-1, -1, -1];
  const right = parseVersion(b) ?? [-1, -1, -1];
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

function parseVersion(version: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.*)?$/.exec(version);
  return match ? match.slice(1, 4).map(Number) : null;
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
    return { checkedAt: Number(parsed.checkedAt) || 0, latest: parsed.latest ?? null, told: String(parsed.told ?? "") };
  } catch {
    return { checkedAt: 0, latest: null, told: "" };
  }
}
