// The command-line switches the installed app refuses to start with, as
// Linear's does. Each lets another program on the computer read or steer
// the app's windows and its signed-in sessions (a DevTools port, the main
// process's inspector), see or change its traffic (a proxy, host rules,
// certificate checks off), or loosen its sandbox. A packaged app has the
// matching Electron fuses off as well (electron-builder.config.cjs); this
// covers what Chromium itself reads. Run from source the app keeps them:
// development needs them, and the end-to-end suite drives the app through
// two of them.

const REFUSED = [
  "remote-debugging-port",
  "remote-debugging-pipe",
  "remote-debugging-address",
  "remote-allow-origins",
  "inspect",
  "inspect-brk",
  "inspect-port",
  "inspect-wait",
  "inspect-publish-uid",
  "debug",
  "debug-brk",
  "no-sandbox",
  "disable-web-security",
  "disable-site-isolation-trials",
  "ignore-certificate-errors",
  "ignore-certificate-errors-spki-list",
  "allow-insecure-localhost",
  "proxy-server",
  "proxy-pac-url",
  "proxy-bypass-list",
  "proxy-auto-detect",
  "host-rules",
  "host-resolver-rules",
  "js-flags",
  "load-extension",
];

/**
 * The refused switches among `argv` (as "--name" or "--name=value", in any
 * letter case: Chromium reads both). `hasSwitch` is Chromium's own reading
 * of the command line (app.commandLine.hasSwitch), which also sees a
 * switch that came another way.
 */
export function refusedSwitches(argv: readonly string[], hasSwitch: (name: string) => boolean): string[] {
  const given = new Set(
    argv.flatMap((arg) => {
      const match = /^--?([a-z0-9-]+)(?:=.*)?$/i.exec(arg);
      return match?.[1] ? [match[1].toLowerCase()] : [];
    }),
  );
  return REFUSED.filter((name) => given.has(name) || hasSwitch(name));
}
