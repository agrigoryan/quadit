// The environment Windows gives a program started now, as it keeps it in
// the registry: the machine's variables and the person's own
// (HKCU\Environment). A program's own environment is the one it was started
// with, which a change since does not reach, so the app reads the registry
// for "the PATH a terminal opened now gets" (the login shell's PATH
// elsewhere), and writes the person's PATH there.
//
// A value is read and written unexpanded, its type kept (REG_EXPAND_SZ, as
// Windows makes the PATH, holds %USERPROFILE% and the like), and a change is
// then told to the system, so that what is started afterwards (a terminal,
// an agent's app) sees it without signing out.
//
// The registry is reached through Windows PowerShell (powershell.ts): no
// program the app carries, and a folder with any letters in its name comes
// through as it is.

import { execFile, execFileSync } from "node:child_process";
import { powershell, textIn, textOut, writeOut } from "@/main/powershell";

/** A variable of the person's own, unexpanded: `expand` when it is kept as REG_EXPAND_SZ (else REG_SZ). */
export interface UserVariable {
  value: string;
  expand: boolean;
}

const RUN_TIMEOUT_MS = 20_000;

/**
 * The PATH a program started now gets: the machine's, then the person's,
 * each expanded, as Windows puts them together. The app's own when
 * PowerShell cannot say.
 */
export function systemPath(): Promise<string> {
  const { program, args } =
    powershell(`$parts = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User')) | Where-Object { $_ }
${writeOut("$parts -join ';'")}`);
  return new Promise((resolve) => {
    execFile(program, args, { timeout: RUN_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      resolve(err ? (process.env.Path ?? process.env.PATH ?? "") : textOut(stdout));
    });
  });
}

/**
 * The person's own variable `name` as the registry keeps it; null when there
 * is none. Throws when it cannot be read, or is of a type other than text.
 */
export function readUserVariable(name: string): UserVariable | null {
  const { program, args } = powershell(`$ErrorActionPreference = 'Stop'
$name = ${textIn(name)}
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
if ($key -ne $null -and ($key.GetValueNames() -contains $name)) {
  [Console]::Out.Write($key.GetValueKind($name).ToString() + ':')
  ${writeOut("$key.GetValue($name, '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)")}
}`);
  const said = execFileSync(program, args, { encoding: "utf8", timeout: RUN_TIMEOUT_MS, windowsHide: true }).trim();
  if (said === "") return null;
  const [kind, value = ""] = said.split(":");
  if (kind !== "String" && kind !== "ExpandString")
    throw new Error(`the variable ${name} is kept as ${kind}, not as text`);
  return { value: textOut(value), expand: kind === "ExpandString" };
}

/**
 * Sets the person's own variable `name` (null takes it away), then tells
 * the system, without waiting for that. Throws when it cannot be written.
 */
export function writeUserVariable(name: string, variable: UserVariable | null) {
  const set = variable
    ? `$key.SetValue($name, ${textIn(variable.value)}, [Microsoft.Win32.RegistryValueKind]::${variable.expand ? "ExpandString" : "String"})`
    : "$key.DeleteValue($name, $false)";
  const write = powershell(`$ErrorActionPreference = 'Stop'
$name = ${textIn(name)}
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
${set}
$key.Close()`);
  execFileSync(write.program, write.args, { timeout: RUN_TIMEOUT_MS, windowsHide: true });
  // Windows' own message for it (WM_SETTINGCHANGE "Environment"), to every window, as the system's settings send it.
  const tell = `Add-Type -Namespace QuaditApp -Name Native -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint msg, System.UIntPtr wParam, string lParam, uint flags, uint timeout, out System.UIntPtr result);'
$result = [System.UIntPtr]::Zero
[void][QuaditApp.Native]::SendMessageTimeout([System.IntPtr]0xffff, 0x1A, [System.UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)`;
  const told = powershell(tell);
  execFile(told.program, told.args, { timeout: RUN_TIMEOUT_MS, windowsHide: true }, () => {
    // Nothing to do either way: what is started from now on reads the registry, the app among them.
  });
}
