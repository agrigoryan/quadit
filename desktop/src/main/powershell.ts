// Windows PowerShell, which every Windows has, as the app asks the system
// what Node cannot (the registry: windows-environment.ts; the person's full
// name: account-name.ts). The script is handed over encoded on the command
// line; the texts it works on go on its standard input, never on the
// command line, which Windows limits to 32,767 characters (a person's PATH
// can be that long by itself). Both ways a text travels as base64 of UTF-8,
// so neither the console's code page nor anything in it can change a word.

import { win32 } from "node:path";

/**
 * The program, arguments and standard input that run `script` with the
 * texts `given`, which the script reads as `$given[0]`, `$given[1]`…:
 * Windows PowerShell by its place in the system folder, without the
 * person's profile.
 */
export function powershell(script: string, given: string[] = []): { program: string; args: string[]; input: string } {
  // Each text one line, "b:" before its base64 so that an empty text is a line too.
  const read =
    given.length > 0
      ? `$given = @(foreach ($line in [Console]::In.ReadToEnd().Split([char]10)) { if ($line.StartsWith('b:')) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Substring(2).Trim())) } })\n`
      : "";
  return {
    program: win32.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(read + script, "utf16le").toString("base64"),
    ],
    input: given.map((text) => `b:${Buffer.from(text, "utf8").toString("base64")}\n`).join(""),
  };
}

/** A PowerShell statement that writes the string `expression` gives out, as base64 of its UTF-8, for textOut. */
export function writeOut(expression: string): string {
  return `[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string](${expression}))))`;
}

/** What a writeOut wrote. */
export function textOut(written: string): string {
  return Buffer.from(written.trim(), "base64").toString("utf8");
}
