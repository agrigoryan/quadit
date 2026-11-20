// How the app is packaged (electron-builder): a .dmg and a .zip for macOS
// (Apple silicon and Intel), an NSIS installer for Windows, an AppImage and a
// .deb for Linux. Run: pnpm dist (all targets of this OS) or
// pnpm dist --mac dmg --arm64 (one).
//
// Signing and notarizing on macOS come from the environment and are skipped
// cleanly without it, which makes an unsigned build for trying out (a
// release refuses that: .github/workflows/desktop-release.yml):
//   CSC_LINK + CSC_KEY_PASSWORD   the Developer ID Application certificate (.p12, base64 or path),
//                                 or CSC_NAME for one already in the keychain
//   APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, or
//   APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER   notarization through notarytool
// The signed app is notarized by scripts/notarize.mjs, not by
// electron-builder: its wait for Apple has a limit, and it says what happens
// to an app Apple has not answered for.
// With APPLE_TEAM_ID and a certificate, the build also gets the keychain group
// that Touch ID passkeys need (src/main/main.ts, enablePasskeys).
//
// The quadit command goes into the app's resources as bin/quadit, built for
// each architecture by scripts/cli.mjs into cli/ (pnpm dist runs it first);
// macOS signs it with the app. Windows has no build of the command.
//
// Windows is signed only with a certificate of its own, WIN_CSC_LINK +
// WIN_CSC_KEY_PASSWORD, and not at all without one: electron-builder would
// otherwise fall back to CSC_LINK, the Apple certificate.

const fs = require("node:fs");
const path = require("node:path");

const APP_ID = "io.github.agrigoryan.quadit";
const env = process.env;
const signing = Boolean(env.CSC_LINK || env.CSC_NAME);
const notarizing =
  signing &&
  Boolean(
    (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) ||
    (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER),
  );
const keychainGroup = signing && env.APPLE_TEAM_ID ? `${env.APPLE_TEAM_ID}.${APP_ID}.webauthn` : "";

/** The main process's entitlements: the JIT always, the keychain group when the build is signed for a team. */
function entitlements() {
  const base = path.join(__dirname, "build", "entitlements.mac.plist");
  if (!keychainGroup) return base;
  const generated = path.join(__dirname, "dist", "entitlements.mac.plist");
  fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
  fs.writeFileSync(
    generated,
    fs
      .readFileSync(base, "utf8")
      .replace(
        "  </dict>",
        `    <key>keychain-access-groups</key>\n    <array>\n      <string>${keychainGroup}</string>\n    </array>\n  </dict>`,
      ),
  );
  return generated;
}

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: APP_ID,
  productName: "Quadit",
  copyright: "Copyright © Quadit contributors",
  directories: { output: "dist", buildResources: "build" },
  files: ["out/**", "!out/**/*.map", "assets/icon.png", "assets/trayTemplate*.png", "package.json"],
  // Quadit's own licence, beside the Electron and Chromium ones electron-builder adds.
  extraResources: [{ from: "../LICENSE", to: "LICENSE" }],
  extraMetadata: { quaditDesktop: keychainGroup ? { keychainAccessGroup: keychainGroup } : {} },
  artifactName: "Quadit-${version}-${os}-${arch}.${ext}",
  protocols: [{ name: "Quadit link", schemes: ["quadit"] }],
  // Off: what lets another program on the computer run code as the app or
  // attach to it (ELECTRON_RUN_AS_NODE, NODE_OPTIONS, --inspect). On: the
  // app's code is only its checked app.asar, and its cookies (the servers'
  // sessions) are encrypted with the system's keychain. The switches
  // Chromium reads are refused by the app itself (src/main/switches.ts).
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    enableCookieEncryption: true,
    // Changing the fuses breaks the ad-hoc signature an unsigned Apple silicon build needs to start.
    resetAdHocDarwinSignature: !signing,
  },
  // Releases are attached by the desktop-release workflow, never by electron-builder.
  publish: null,
  // Notarizing, between the signing of the macOS app and the packages made of it.
  ...(notarizing ? { afterSign: "./scripts/notarize.mjs" } : {}),

  mac: {
    category: "public.app-category.productivity",
    icon: "build/icon.icns",
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: entitlements(),
    entitlementsInherit: path.join(__dirname, "build", "entitlements.mac.inherit.plist"),
    // Without a certificate: no signing at all, rather than whatever identity the keychain happens to hold.
    identity: signing ? undefined : null,
    // Never electron-builder's own notarizing: afterSign does it.
    notarize: false,
    ...(env.QUADIT_MAC_PROVISIONING_PROFILE ? { provisioningProfile: env.QUADIT_MAC_PROVISIONING_PROFILE } : {}),
    extendInfo: { NSUserNotificationAlertStyle: "alert" },
    extraResources: [{ from: "cli/darwin-${arch}/quadit", to: "bin/quadit" }],
  },
  dmg: { title: "Quadit ${version}" },

  win: {
    icon: "build/icon.ico",
    target: [{ target: "nsis", arch: ["x64", "arm64"] }],
    // An empty link is "no certificate": it stops the fallback to CSC_LINK.
    cscLink: env.WIN_CSC_LINK ?? "",
    cscKeyPassword: env.WIN_CSC_KEY_PASSWORD ?? "",
  },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true },

  linux: {
    icon: "build/icon.png",
    category: "Office",
    synopsis: "Your Quadit servers in their own windows",
    maintainer: "Quadit maintainers <agrigoryan@users.noreply.github.com>",
    target: [
      { target: "AppImage", arch: ["x64", "arm64"] },
      { target: "deb", arch: ["x64", "arm64"] },
    ],
    extraResources: [{ from: "cli/linux-${arch}/quadit", to: "bin/quadit" }],
  },
};
