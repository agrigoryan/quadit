import { describe, expect, it } from "vitest";
import { powershell } from "@/main/powershell";

describe("powershell", () => {
  it("carries the texts it is given on standard input, so its command line stays short whatever their length", () => {
    // A PATH as long as Windows lets a variable be (32,767 characters), with letters of every kind.
    const long = "C:\\Tools Ünïcode 名前;".repeat(1_800).slice(0, 32_767);
    const { args, input } = powershell("[Console]::Out.Write($given[0])", [long, ""]);
    // CreateProcess takes a command line of 32,767 characters at most, the program's path among them.
    expect(args.join(" ").length).toBeLessThan(4_000);
    expect(input.split("\n").filter(Boolean)).toEqual([`b:${Buffer.from(long, "utf8").toString("base64")}`, "b:"]);
    // Only base64 goes either way: no console code page can change it.
    expect(input).toMatch(/^[A-Za-z0-9+/=:\n]*$/);
  });

  it("gives nothing on standard input to a script given no texts", () => {
    expect(powershell("[Console]::Out.Write('x')").input).toBe("");
  });
});
