// The name Welcome offers as the person's own (welcome-page.ts): the full
// name their account on this computer has, as the system keeps it.

import { powershell, textOut, writeOut } from "@/main/powershell";

/** Runs a command and gives what it printed; rejects when it could not be run or failed. */
export type Run = (command: string, args: string[]) => Promise<string>;

/**
 * The full name of the account `login` on `platform`: macOS's (`id -F`),
 * on Linux the name in its GECOS field (up to the first comma, where the
 * office and the phone begin), on Windows the account's display name (a
 * Microsoft account's is the person's name). The login name itself where
 * there is none or the system cannot say. Never throws.
 */
export async function accountName(platform: NodeJS.Platform, login: string, run: Run): Promise<string> {
  let full = "";
  try {
    if (platform === "darwin") full = await run("id", ["-F"]);
    else if (platform === "linux") full = (await run("getent", ["passwd", login])).split(":")[4]?.split(",")[0] ?? "";
    else if (platform === "win32") {
      const { program, args } = powershell(`Add-Type -AssemblyName System.DirectoryServices.AccountManagement
${writeOut("[System.DirectoryServices.AccountManagement.UserPrincipal]::Current.DisplayName")}`);
      full = textOut(await run(program, args));
    }
  } catch {
    // No full name to be had: the login name serves.
  }
  return full.trim() || login;
}
