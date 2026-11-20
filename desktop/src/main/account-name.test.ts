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

  it("is the login name on Windows, without asking the system anything", async () => {
    const { run, ran } = system({});
    expect(await accountName("win32", "ann", run)).toBe("ann");
    expect(ran).toEqual([]);
  });
});
