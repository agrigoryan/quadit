import { describe, expect, it } from "vitest";
import { accountName } from "@/main/account-name";

/** A system whose commands print what `printed` holds for them, and fail otherwise. */
function system(printed: Record<string, string>) {
  const ran: string[] = [];
  const run = async (command: string, args: string[]) => {
    const line = [command, ...args].join(" ");
    ran.push(line);
    const out = printed[line];
    if (out === undefined) throw new Error(`${command}: not found`);
    return out;
  };
  return { run, ran };
}

describe("accountName", () => {
  it("is the full name macOS keeps for the account", async () => {
    const { run } = system({ "id -F": "Ann Owner\n" });
    expect(await accountName("darwin", "ann", run)).toBe("Ann Owner");
  });

  it("is the name in the GECOS field on Linux, without its office and phone parts", async () => {
    const { run, ran } = system({
      "getent passwd ann": "ann:x:1000:1000:Ann Owner,Room 4,555-1234,:/home/ann:/bin/bash\n",
    });
    expect(await accountName("linux", "ann", run)).toBe("Ann Owner");
    expect(ran).toEqual(["getent passwd ann"]);
  });

  it("is the login name when the system keeps no full name, or cannot say", async () => {
    expect(await accountName("darwin", "ann", system({ "id -F": "\n" }).run)).toBe("ann");
    expect(await accountName("darwin", "ann", system({}).run)).toBe("ann");
    expect(
      await accountName("linux", "ann", system({ "getent passwd ann": "ann:x:1000:1000::/home/ann:/bin/sh\n" }).run),
    ).toBe("ann");
    expect(await accountName("linux", "ann", system({}).run)).toBe("ann");
  });

  it("is the account's display name on Windows, as PowerShell gives it, whatever letters it holds", async () => {
    const ran: string[][] = [];
    const run = async (command: string, args: string[]) => {
      ran.push([command, ...args]);
      return Buffer.from("Zoë Ångström", "utf8").toString("base64");
    };
    expect(await accountName("win32", "zoe", run)).toBe("Zoë Ångström");
    expect(ran[0]?.[0]).toMatch(/\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
    const script = Buffer.from(ran[0]?.at(-1) ?? "", "base64").toString("utf16le");
    expect(script).toContain("UserPrincipal]::Current.DisplayName");
  });

  it("is the login name on Windows when the account has no display name, or PowerShell cannot say", async () => {
    expect(await accountName("win32", "ann", async () => "")).toBe("ann");
    expect(await accountName("win32", "ann", system({}).run)).toBe("ann");
  });
});
