// Windows PowerShell, which every Windows has, as the app asks the system
// what Node cannot (the registry: windows-environment.ts; the person's full
// name: account-name.ts). A script is handed over encoded and its answer
// comes back as base64 of UTF-8, so neither the arguments nor the console's
// code page can change a word of either, whatever letters it holds.

import { win32 } from "node:path";

/** The program and arguments that run `script`: Windows PowerShell by its place in the system folder, without the person's profile. */
export function powershell(script: string): { program: string; args: string[] } {
  return {
    program: win32.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
  };
}

/** `text` as a PowerShell expression that gives it back, whatever it holds. */
export function textIn(text: string): string {
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(text, "utf8").toString("base64")}'))`;
}

/** A PowerShell statement that writes the string `expression` gives out, as base64 of its UTF-8, for textOut. */
export function writeOut(expression: string): string {
  return `[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string](${expression}))))`;
}

/** What a writeOut wrote. */
export function textOut(written: string): string {
  return Buffer.from(written.trim(), "base64").toString("utf8");
}
