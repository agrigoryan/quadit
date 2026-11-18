// What a desktop release tag (desktop-v1.2.3, desktop-v1.2.3-beta.1) says,
// for .github/workflows/desktop-release.yml: the tag must name the app's own
// version (package.json), that version must be SemVer, and a version with a
// pre-release part is a pre-release. Only a pre-release may go out unsigned,
// and it is published as a GitHub pre-release.
//
//   node scripts/release-tag.mjs desktop-v1.2.3-beta.1
//
// prints version=1.2.3-beta.1 and prerelease=true, one per line (appended to
// $GITHUB_OUTPUT too when it is set), or exits 1 with the reason.

import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PREFIX = "desktop-v";
// semver.org's own pattern: MAJOR.MINOR.PATCH, then an optional -pre-release and +build.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * The release `tag` makes of the app at `appVersion`: its version and
 * whether it is a pre-release. Throws when the tag is not desktop-v followed
 * by the app's version, or that version is not SemVer.
 *
 * @param {string} tag
 * @param {string} appVersion
 * @returns {{ version: string, prerelease: boolean }}
 */
export function desktopRelease(tag, appVersion) {
  if (!tag.startsWith(PREFIX)) throw new Error(`${tag} is not a desktop release tag (${PREFIX}1.2.3)`);
  const version = tag.slice(PREFIX.length);
  const parts = SEMVER.exec(version);
  if (!parts) throw new Error(`${tag}: ${version} is not a SemVer version (1.2.3 or 1.2.3-beta.1)`);
  if (version !== appVersion) throw new Error(`${tag} is not the app's version, ${appVersion} (desktop/package.json)`);
  return { version, prerelease: parts[4] !== undefined };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const appVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  try {
    const { version, prerelease } = desktopRelease(process.argv[2] ?? "", appVersion);
    const lines = `version=${version}\nprerelease=${prerelease}\n`;
    process.stdout.write(lines);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
  } catch (err) {
    process.stderr.write(`::error::${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
