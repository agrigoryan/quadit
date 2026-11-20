// The name Welcome offers as the person's own (welcome-page.ts): the full
// name their account on this computer has, as the system keeps it.

/** Runs a command and gives what it printed; rejects when it could not be run or failed. */
export type Run = (command: string, args: string[]) => Promise<string>;

/**
 * The full name of the account `login` on `platform`: macOS's (`id -F`),
 * or on Linux the name in its GECOS field (up to the first comma, where
 * the office and the phone begin). The login name itself where there is
 * none or the system cannot say, and on Windows. Never throws.
 */
export async function accountName(platform: NodeJS.Platform, login: string, run: Run): Promise<string> {
  let full = "";
  try {
    if (platform === "darwin") full = await run("id", ["-F"]);
    else if (platform === "linux") full = (await run("getent", ["passwd", login])).split(":")[4]?.split(",")[0] ?? "";
  } catch {
    // No full name to be had: the login name serves.
  }
  return full.trim() || login;
}
