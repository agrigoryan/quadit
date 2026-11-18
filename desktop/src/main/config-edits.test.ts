import { lstatSync, mkdtempSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import {
  type Applied,
  changedSince,
  diffOf,
  EditRefused,
  planChanges,
  planReverts,
  sha256,
  writeEdits,
} from "@/main/config-edits";

function folder() {
  return mkdtempSync(join(tmpdir(), "quadit-desktop-edits-"));
}

/** Plans and writes `changes`, as Apply does, and gives the records with their file hashes filled in. */
function apply(changes: Parameters<typeof planChanges>[0], dir = folder()): Applied[] {
  const { edits, applied } = planChanges(changes);
  const backups = writeEdits(edits, join(dir, "backups"));
  return applied.map((record) =>
    record.kind === "file"
      ? { ...record, sha256: sha256(readFileSync(record.path, "utf8")), backup: backups.get(record.path) ?? null }
      : record,
  );
}

function revert(applied: Applied[]): string[] {
  const { edits, notes } = planReverts(applied);
  writeEdits(edits, join(folder(), "backups"));
  return notes;
}

describe("JSON edits", () => {
  it("keeps a JSONC file's comments and formatting, and takes the key back out", () => {
    const path = join(folder(), "opencode.jsonc");
    const original = `{\n  // my models\n  "model": "x", /* keep */\n  "mcp": {\n    "other": { "type": "local" }\n  }\n}\n`;
    writeFileSync(path, original);
    const applied = apply([
      { kind: "json", path, keyPath: ["mcp", "quadit"], value: { type: "remote", url: "https://q.example/mcp" } },
    ]);
    const edited = readFileSync(path, "utf8");
    expect(edited).toContain("// my models");
    expect(edited).toContain("/* keep */");
    expect(edited).toContain('"url": "https://q.example/mcp"');
    expect(revert(applied)).toEqual([]);
    const reverted = readFileSync(path, "utf8");
    expect(reverted).toContain("// my models");
    expect(parse(reverted)).toEqual(parse(original));
  });

  it("makes a missing file, and takes it back to an empty object without the keys it made", () => {
    const path = join(folder(), "settings.json");
    const applied = apply([{ kind: "json", path, keyPath: ["env", "QUADIT_CONFIG"], value: "/c/claude.json" }]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ env: { QUADIT_CONFIG: "/c/claude.json" } });
    revert(applied);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
  });

  it("puts back the value a key had, and leaves alone a key changed since", () => {
    const path = join(folder(), "mcp.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { quadit: { url: "https://old/mcp" } } }));
    const applied = apply([
      { kind: "json", path, keyPath: ["mcpServers", "quadit"], value: { url: "https://new/mcp" } },
    ]);
    expect(revert(applied)).toEqual([]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ mcpServers: { quadit: { url: "https://old/mcp" } } });

    const again = apply([{ kind: "json", path, keyPath: ["mcpServers", "quadit"], value: { url: "https://new/mcp" } }]);
    writeFileSync(path, JSON.stringify({ mcpServers: { quadit: { url: "https://mine/mcp" } } }));
    expect(revert(again)).toEqual([`${path}: mcpServers.quadit changed since the app set it; left as it is.`]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ mcpServers: { quadit: { url: "https://mine/mcp" } } });
  });

  it("adds to a list once, and takes out only what it added", () => {
    const path = join(folder(), "settings.json");
    writeFileSync(path, JSON.stringify({ permissions: { allow: ["Read"] } }));
    const applied = apply([{ kind: "json-item", path, keyPath: ["permissions", "allow"], value: "Bash(quadit:*)" }]);
    expect(
      planChanges([{ kind: "json-item", path, keyPath: ["permissions", "allow"], value: "Bash(quadit:*)" }]).edits,
    ).toEqual([]);
    revert(applied);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ permissions: { allow: ["Read"] } });
  });

  it("refuses a file that is not JSON", () => {
    const path = join(folder(), "broken.json");
    writeFileSync(path, "{ nope");
    expect(() => planChanges([{ kind: "json", path, keyPath: ["a"], value: 1 }])).toThrow(EditRefused);
  });
});

describe("TOML edits", () => {
  const original = `model = "gpt"\n\n[mcp_servers.other]\ncommand = "x"\n`;

  it("appends a table, and takes it back out to the file as it was", () => {
    const path = join(folder(), "config.toml");
    writeFileSync(path, original);
    const applied = apply([
      { kind: "toml", path, table: ["mcp_servers", "quadit"], entries: { url: "https://q.example/mcp" } },
    ]);
    const edited = readFileSync(path, "utf8");
    expect(edited.startsWith(original)).toBe(true);
    expect(edited).toContain('[mcp_servers.quadit]\nurl = "https://q.example/mcp"');
    revert(applied);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("refuses a table that is already there, saying what to add by hand", () => {
    const path = join(folder(), "config.toml");
    writeFileSync(path, `${original}\n[sandbox_workspace_write]\nwritable_roots = ["/tmp"]\n`);
    expect(() =>
      planChanges([{ kind: "toml", path, table: ["sandbox_workspace_write"], entries: { network_access: true } }]),
    ).toThrow(
      new EditRefused(
        `${path} already has sandbox_workspace_write, so the app does not change it. Add these lines to it yourself, or take it out and try again:\n` +
          "# Added by the Quadit app; Disconnect in the app takes it out.\n[sandbox_workspace_write]\nnetwork_access = true",
      ),
    );
  });

  it("refuses a table a dotted key already defines", () => {
    const path = join(folder(), "config.toml");
    writeFileSync(path, `shell_environment_policy.set.HOME_X = "1"\n`);
    expect(() =>
      planChanges([
        { kind: "toml", path, table: ["shell_environment_policy", "set"], entries: { QUADIT_CONFIG: "/c.json" } },
      ]),
    ).toThrow(/already has shell_environment_policy.set/);
  });

  it("leaves a table changed since alone", () => {
    const path = join(folder(), "config.toml");
    writeFileSync(path, original);
    const applied = apply([
      { kind: "toml", path, table: ["mcp_servers", "quadit"], entries: { url: "https://a/mcp" } },
    ]);
    writeFileSync(path, readFileSync(path, "utf8").replace("https://a/mcp", "https://b/mcp"));
    expect(revert(applied)).toEqual([`${path}: the table the app added changed since; left as it is.`]);
  });
});

describe("whole files and links", () => {
  it("backs up a file it replaces, puts it back, and leaves alone one changed since", () => {
    const dir = folder();
    const path = join(dir, "skills", "quadit", "SKILL.md");
    const applied = apply([{ kind: "file", path, content: "skill v2\n" }], dir);
    expect(revert(applied)).toEqual([]);
    expect(() => statSync(path)).toThrow();

    writeFileSync(path, "skill v1\n");
    const replaced = apply([{ kind: "file", path, content: "skill v2\n" }], dir);
    const backup = replaced[0]?.kind === "file" ? replaced[0].backup : null;
    expect(backup && readFileSync(backup, "utf8")).toBe("skill v1\n");
    expect(backup && statSync(backup).mode & 0o777).toBe(0o600);
    revert(replaced);
    expect(readFileSync(path, "utf8")).toBe("skill v1\n");

    const edited = apply([{ kind: "file", path, content: "skill v2\n" }], dir);
    writeFileSync(path, "my own skill\n");
    expect(revert(edited)).toEqual([`${path}: it changed since the app wrote it; left as it is.`]);
    expect(readFileSync(path, "utf8")).toBe("my own skill\n");
  });

  it("links and unlinks, and refuses to replace a file that is not its link", () => {
    const dir = folder();
    const path = join(dir, "quadit");
    const applied = apply([{ kind: "link", path, target: "/Applications/Quadit.app/Contents/Resources/bin/quadit" }]);
    expect(readlinkSync(path)).toBe("/Applications/Quadit.app/Contents/Resources/bin/quadit");
    revert(applied);
    expect(() => lstatSync(path)).toThrow();
    writeFileSync(path, "#!/bin/sh\n");
    expect(() => planChanges([{ kind: "link", path, target: "/x" }])).toThrow(EditRefused);
  });

  it("notices a file changed between the plan and writing it", () => {
    const path = join(folder(), "a.json");
    writeFileSync(path, "{}");
    const { edits } = planChanges([{ kind: "json", path, keyPath: ["a"], value: 1 }]);
    expect(changedSince(edits)).toBeNull();
    writeFileSync(path, '{"b": 2}');
    expect(changedSince(edits)?.path).toBe(path);
  });

  it("shows an edit as a diff of the file", () => {
    const path = join(folder(), "a.json");
    writeFileSync(path, "{}\n");
    const { edits } = planChanges([{ kind: "json", path, keyPath: ["a"], value: 1 }]);
    const diff = diffOf(edits[0] as (typeof edits)[0]);
    expect(diff).toContain(`--- ${path}`);
    expect(diff).toContain('+  "a": 1');
  });
});
