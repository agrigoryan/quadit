// The registry itself, on Windows only: each test has a variable of its own
// among the person's (the runner's account), which it takes away after.

import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { readUserVariable, systemPath, writeUserVariable } from "@/main/windows-environment";

const onWindows = describe.runIf(process.platform === "win32");

onWindows("the person's variables in the registry", () => {
  const name = `QuaditAppTest${randomBytes(4).toString("hex")}`;
  afterEach(() => writeUserVariable(name, null));

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

  it("takes a variable away", () => {
    writeUserVariable(name, { value: "x", expand: false });
    writeUserVariable(name, null);
    expect(readUserVariable(name)).toBeNull();
  });
});

onWindows("the PATH a program started now gets", () => {
  it("is the machine's and the person's, expanded", async () => {
    const path = (await systemPath()).toLowerCase().split(";");
    const system32 = `${process.env.SystemRoot ?? "C:\\Windows"}\\system32`.toLowerCase();
    expect(path).toContain(system32);
    expect(path.some((folder) => folder.includes("%"))).toBe(false);
  });
});
