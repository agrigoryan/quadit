// The registry itself, on Windows only: each test has a variable of its own
// among the person's (the runner's account), which it takes away after.

import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { readUserVariable, systemPath, writeUserVariable } from "@/main/windows-environment";

const onWindows = describe.runIf(process.platform === "win32");
/** Each step starts Windows PowerShell, which takes a moment, more the first time. */
const SLOW = { timeout: 60_000 };

onWindows("the person's variables in the registry", SLOW, () => {
  const name = `QuaditAppTest${randomBytes(4).toString("hex")}`;
  afterEach(() => writeUserVariable(name, null), SLOW.timeout);

  it("is none for a variable that is not there", () => {
    expect(readUserVariable(name)).toBeNull();
  });

  it("writes and reads back a variable unexpanded, its type kept, whatever letters it holds", () => {
    const value = "%USERPROFILE%\\Programs\\Quadit Ünïcode 名前\\resources\\bin;;C:\\Tools";
    writeUserVariable(name, { value, expand: true });
    expect(readUserVariable(name)).toEqual({ value, expand: true });
    writeUserVariable(name, { value: "C:\\Tools", expand: false });
    expect(readUserVariable(name)).toEqual({ value: "C:\\Tools", expand: false });
  });

  it("writes and reads back a value as long as Windows lets a variable be, whatever its letters", () => {
    const value = "C:\\Tools Ünïcode 名前;".repeat(1_800).slice(0, 32_767);
    writeUserVariable(name, { value, expand: false });
    expect(readUserVariable(name)).toEqual({ value, expand: false });
  });

  it("takes a variable away", () => {
    writeUserVariable(name, { value: "x", expand: false });
    writeUserVariable(name, null);
    expect(readUserVariable(name)).toBeNull();
  });
});

onWindows("the PATH a program started now gets", SLOW, () => {
  it("is the machine's and the person's, expanded", async () => {
    const path = (await systemPath()).toLowerCase().split(";");
    const system32 = `${process.env.SystemRoot ?? "C:\\Windows"}\\system32`.toLowerCase();
    expect(path).toContain(system32);
    expect(path.some((folder) => folder.includes("%"))).toBe(false);
  });
});
