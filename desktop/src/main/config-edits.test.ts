import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import {
  type Applied,
  backUp,
  changedSince,
  diffOf,
  EditRefused,
  inPlace,
  planChanges,
  planReverts,
  sha256,
  writeEdits,
} from "@/main/config-edits";

/** Connect runs only on macOS and Linux (no Windows build of quadit); these tests need a POSIX shell, links and file modes. */
const posixOnly = describe.skipIf(process.platform === "win32");

/** A new folder, as its real path (the plans name files by theirs). */
function folder() {
  return realpathSync(mkdtempSync(join(tmpdir(), "quadit-desktop-edits-")));
}

/** Plans and writes `changes`, as Apply does, and gives the records with their file hashes filled in. */
function apply(changes: Parameters<typeof planChanges>[0], dir = folder()): Applied[] {
  const { edits, applied } = planChanges(changes);
  const backups = backUp(edits, join(dir, "backups"));
  writeEdits(edits);
  return applied.map((record) =>
    record.kind === "file"
      ? { ...record, sha256: sha256(readFileSync(record.path, "utf8")), backup: backups.get(record.path) ?? null }
      : record,
  );
}

function revert(applied: Applied[]): string[] {
  const { edits, notes } = planReverts(applied);
  writeEdits(edits);
  return notes;
}

posixOnly("JSON edits", () => {
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

posixOnly("TOML edits", () => {
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

  it("leaves alone a table that gained an entry, which taking the block out would hand to the table before it", () => {
    const path = join(folder(), "config.toml");
    writeFileSync(path, original);
    const applied = apply([
      { kind: "toml", path, table: ["mcp_servers", "quadit"], entries: { url: "https://a/mcp" } },
    ]);
    writeFileSync(path, `${readFileSync(path, "utf8")}startup_timeout_sec = 30\n`);
    expect(revert(applied)).toEqual([`${path}: the table the app added changed since; left as it is.`]);
    expect(readFileSync(path, "utf8")).toContain("[mcp_servers.quadit]");
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

posixOnly("whole files and links", () => {
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

  it("never replaces a quadit on the PATH it did not make, a link (broken or not) or a file", () => {
    const dir = folder();
    symlinkSync(join(dir, "gone"), join(dir, "quadit"));
    expect(() => planChanges([{ kind: "link", path: join(dir, "quadit"), target: "/app/quadit" }])).toThrow(
      new EditRefused(
        `${join(dir, "quadit")} is already there and the app did not make it: take it away, or put quadit on your PATH yourself.`,
      ),
    );
    symlinkSync("/app/quadit", join(dir, "ours"));
    expect(planChanges([{ kind: "link", path: join(dir, "ours"), target: "/app/quadit" }]).edits).toEqual([]);
  });

  it("refuses to write through a link to nothing, which would put the file where the plan does not show", () => {
    const dir = folder();
    symlinkSync(join(dir, "elsewhere", "config.json"), join(dir, "config.json"));
    expect(() => planChanges([{ kind: "written-by", path: join(dir, "config.json"), shown: "{}" }])).toThrow(
      new EditRefused(
        `${join(dir, "config.json")} is a link to ${join(dir, "elsewhere", "config.json")}, which is not there: the app does not write through it.`,
      ),
    );
  });

  it("writes through a scratch file of its own, never one already there", () => {
    const dir = folder();
    const path = join(dir, "settings.json");
    writeFileSync(path, "{}");
    // A link where a predictable scratch name would be: writing must not follow it.
    writeFileSync(join(dir, "victim"), "untouched");
    symlinkSync(join(dir, "victim"), `${path}.quadit-next`);
    apply([{ kind: "json", path, keyPath: ["a"], value: 1 }], dir);
    expect(readFileSync(join(dir, "victim"), "utf8")).toBe("untouched");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ a: 1 });
  });

  it("masks tokens on both sides of a diff", () => {
    const path = join(folder(), "config.json");
    const token = "qd_AbCdEf12_" + "x".repeat(40);
    writeFileSync(path, JSON.stringify({ url: "https://q", token }, null, 2));
    const { edits } = planReverts([{ kind: "file", path, sha256: sha256(readFileSync(path, "utf8")), backup: null }]);
    const diff = diffOf(edits[0] as (typeof edits)[0]);
    expect(diff).not.toContain(token);
    expect(diff).toContain('-  "token": "qd_…"');
    const settings = join(folder(), "settings.json");
    writeFileSync(settings, JSON.stringify({ headers: { Authorization: `Bearer ${token}` } }));
    const replaced = planChanges([{ kind: "json", path: settings, keyPath: ["headers"], value: {} }]).edits[0];
    expect(diffOf(replaced as NonNullable<typeof replaced>)).not.toContain(token);
  });

  it("edits the file a symbolic link leads to, and keeps the link", () => {
    const dir = folder();
    mkdirSync(join(dir, "dotfiles"));
    writeFileSync(join(dir, "dotfiles", "settings.json"), "{}");
    symlinkSync(join(dir, "dotfiles", "settings.json"), join(dir, "settings.json"));
    const { edits } = planChanges([{ kind: "json", path: join(dir, "settings.json"), keyPath: ["a"], value: 1 }]);
    expect(edits.map((e) => e.path)).toEqual([join(dir, "dotfiles", "settings.json")]);
    writeEdits(edits);
    expect(lstatSync(join(dir, "settings.json")).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({ a: 1 });
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

posixOnly("Profile lines and folders", () => {
  const LINE = 'export PATH="$HOME/.local/bin:$PATH" # Added by the Quadit app: Disconnect in the app takes it out.';

  it("adds a marked line to the end of a file once, and takes exactly that line back out", () => {
    const path = join(folder(), ".zprofile");
    writeFileSync(path, "eval $(brew shellenv)");
    const applied = apply([{ kind: "line", path, line: LINE }]);
    expect(readFileSync(path, "utf8")).toBe(`eval $(brew shellenv)\n${LINE}\n`);
    // Never twice.
    expect(planChanges([{ kind: "line", path, line: LINE }])).toEqual({ edits: [], applied: [] });

    writeFileSync(path, `${readFileSync(path, "utf8")}alias ll='ls -l'\n`);
    expect(revert(applied)).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("eval $(brew shellenv)\nalias ll='ls -l'\n");
  });

  it("makes a file that is not there for the line, and takes the file away with it when nothing else was added", () => {
    const dir = folder();
    const path = join(dir, "conf.d", "quadit.fish");
    const applied = apply([{ kind: "line", path, line: "fish_add_path --global --path $HOME/.local/bin" }]);
    expect(readFileSync(path, "utf8")).toBe("fish_add_path --global --path $HOME/.local/bin\n");
    revert(applied);
    expect(lstatSync(path, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("writes the line through a profile that is a symbolic link, which stays a link", () => {
    const dir = folder();
    const real = join(dir, "dotfiles", "zprofile");
    mkdirSync(join(dir, "dotfiles"));
    writeFileSync(real, "export EDITOR=nvim\n");
    const path = join(dir, ".zprofile");
    symlinkSync(real, path);
    const applied = apply([{ kind: "line", path, line: LINE }]);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe(`export EDITOR=nvim\n${LINE}\n`);
    revert(applied);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe("export EDITOR=nvim\n");
  });

  it("makes a folder with a link in it, shows both, and takes both back, leaving a folder that holds more", () => {
    const dir = folder();
    const bin = join(dir, ".local", "bin");
    const target = join(dir, "Quadit.app-quadit");
    writeFileSync(target, "");
    const changes = [
      { kind: "folder" as const, path: bin },
      { kind: "link" as const, path: join(bin, "quadit"), target },
    ];
    expect(planChanges(changes).edits.map((edit) => diffOf(edit))).toEqual([
      expect.stringContaining("+(a new folder)"),
      expect.stringContaining(`+→ ${target}`),
    ]);
    const applied = apply(changes);
    expect(readlinkSync(join(bin, "quadit"))).toBe(target);
    revert(applied);
    expect(lstatSync(bin, { throwIfNoEntry: false })).toBeUndefined();
    // A folder there already is never made, and one that holds the person's files now stays.
    expect(planChanges([{ kind: "folder", path: dir }])).toEqual({ edits: [], applied: [] });
    const again = apply(changes);
    writeFileSync(join(bin, "mine"), "");
    revert(again);
    expect(statSync(bin).isDirectory()).toBe(true);
    expect(lstatSync(join(bin, "quadit"), { throwIfNoEntry: false })).toBeUndefined();
  });
});

posixOnly("what is in place, and taking back in turn", () => {
  it("says whether a change's result is in its file already", () => {
    const dir = folder();
    const json = join(dir, "settings.json");
    const toml = join(dir, "config.toml");
    const rules = join(dir, "rules", "default.rules");
    const item = { kind: "json-item" as const, path: json, keyPath: ["permissions", "allow"], value: "Bash(quadit:*)" };
    const table = { kind: "toml" as const, path: toml, table: ["sandbox"], entries: { network_access: true } };
    const line = { kind: "line" as const, path: rules, line: 'prefix_rule(pattern=["quadit"], decision="allow")' };
    expect([inPlace(item), inPlace(table), inPlace(line)]).toEqual([false, false, false]);
    writeFileSync(json, JSON.stringify({ permissions: { allow: ["Read", "Bash(quadit:*)"] } }));
    writeFileSync(toml, "[sandbox]\nnetwork_access = true\nother = 1\n");
    apply([line]);
    expect([inPlace(item), inPlace(table), inPlace(line)]).toEqual([true, true, true]);
    writeFileSync(toml, "[sandbox]\nnetwork_access = false\n");
    expect(inPlace(table)).toBe(false);
    // A file that cannot be read as what it should be holds nothing in place.
    writeFileSync(json, "{ not json");
    expect(inPlace(item)).toBe(false);
  });

  it("takes back the last change to a key first, so a key changed twice goes back to before both", () => {
    const path = join(folder(), "settings.json");
    const first = apply([{ kind: "json", path, keyPath: ["mcpServers", "quadit"], value: { httpUrl: "u" } }]);
    const second = apply([
      { kind: "json", path, keyPath: ["mcpServers", "quadit"], value: { httpUrl: "u", trust: true } },
    ]);
    expect(revert([...first, ...second])).toEqual([]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
  });
});
