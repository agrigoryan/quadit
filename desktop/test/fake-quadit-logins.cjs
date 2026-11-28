// A stand-in for a quadit that keeps a login per workspace, for the desktop
// app's unit tests of a tool connected in several (src/main/connections.test.ts):
// what Connect runs of it, as the multi-workspace design says the command
// does (§3.2 the files and the index, §3.3 the commands). It is run as
// `node fake-quadit-logins.cjs STAND-IN ARGS…` by a script STAND-IN, whose
// path names the files of its server, beside it:
//   STAND-IN.server.json  what the server says: { surface, defaultConfig,
//                         tokens: { TOKEN: { url, user_id, handle, kind,
//                         workspace: { id, slug, name } } }, revokeFails }
//   STAND-IN.logins       the arguments of each login, a line each
//   STAND-IN.revoked      each token revoked with the token itself, a line each
//
//   version                 "quadit 9.9.9 (agent surface S)"
//   skill                   the skill's text
//   login --path            QUADIT_CONFIG, else the default login
//   login URL - [--app P]   the token on standard input: the first login of
//                           the base login QUADIT_CONFIG names goes into it;
//                           one of another workspace beside it, as
//                           <base>-<slug>.json, both listed in index.json (the
//                           first after its own /me: unknown, it is refused
//                           and nothing changes); the same workspace again
//                           replaces its token
//   --json me               the identity of the login QUADIT_WORKSPACE or the
//                           only one selects; with several and none, the list
//   logout --workspace=ID [--revoke=TOKEN_ID]   folder ties stay
//   use ID folder=PATH | use --clear folder=PATH   a tie carries project ""

const { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } = require("node:fs");
const path = require("node:path");

const [standIn, command, ...args] = process.argv.slice(2);
const server = JSON.parse(readFileSync(`${standIn}.server.json`, "utf8"));
const base = process.env.QUADIT_CONFIG || server.defaultConfig;
const indexFile = path.join(path.dirname(base), "index.json");

const fail = (words, code = 1) => {
  process.stderr.write(`${words}\n`);
  process.exit(code);
};
const read = (file, empty) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : empty);
const write = (file, value, mode) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.next`, JSON.stringify(value, null, 2), { mode });
  renameSync(`${file}.next`, file);
};
const index = () => read(indexFile, { connections: [], folders: [] });
const mine = (list) => list.connections.filter((c) => c.tool === base);
/** The identity the server gives the login in `file`; null when it does not know its token. */
const identityOf = (file) => server.tokens[read(file, {}).token] ?? null;
const entryOf = (file, who) => ({
  tool: base,
  login: file,
  server: who.url,
  workspace_id: who.workspace.id,
  workspace: who.workspace.slug,
  workspace_name: who.workspace.name,
  agent_id: who.user_id,
  agent: who.handle,
});

switch (command) {
  case "version":
    process.stdout.write(`quadit 9.9.9 (agent surface ${server.surface ?? "3.1"})\n`);
    break;
  case "skill":
    process.stdout.write("# Quadit skill\n");
    break;
  case "login": {
    if (args[0] === "--path") {
      process.stdout.write(`${base}\n`);
      break;
    }
    if (args[1] !== "-") fail("usage: quadit login URL -", 2);
    appendFileSync(`${standIn}.logins`, `${args.join(" ")}\n`);
    const token = readFileSync(0, "utf8").trim();
    const who = server.tokens[token];
    if (!who) fail("the server refused the token");
    const saved = { url: args[0], token };
    const list = index();
    const listed = mine(list);
    const same = listed.find((c) => c.workspace_id === who.workspace.id);
    if (same) {
      write(same.login, saved, 0o600);
      break;
    }
    if (listed.length === 0 && !existsSync(base)) {
      write(base, saved, 0o600);
      break;
    }
    if (listed.length === 0) {
      const first = identityOf(base);
      if (!first) fail(`cannot reach ${read(base, {}).url}: the login there says nothing of its workspace`);
      if (first.workspace.id === who.workspace.id) {
        write(base, saved, 0o600);
        break;
      }
      list.connections.push(entryOf(base, first));
    }
    const stem = base.replace(/\.json$/, "");
    const slug = /^[a-z0-9][a-z0-9-]{0,62}$/.test(who.workspace.slug) ? who.workspace.slug : "workspace";
    let file = `${stem}-${slug}.json`;
    for (let n = 2; existsSync(file); n++) file = `${stem}-${slug}-${n}.json`;
    write(file, saved, 0o600);
    list.connections.push(entryOf(file, who));
    write(indexFile, list);
    break;
  }
  case "--json": {
    if (args[0] !== "me") fail("unknown command", 2);
    const listed = mine(index());
    const wanted = process.env.QUADIT_WORKSPACE;
    if (listed.length > 1 && !wanted) {
      process.stdout.write(`${JSON.stringify({ connections: listed })}\n`);
      break;
    }
    const entry = wanted ? listed.find((c) => c.workspace_id === wanted) : listed[0];
    const who = identityOf(entry ? entry.login : base);
    if (!who) fail("not signed in");
    process.stdout.write(`${JSON.stringify({ ...who, handle: `@${who.handle}` })}\n`);
    break;
  }
  case "logout": {
    const workspace = args.find((a) => a.startsWith("--workspace="))?.slice("--workspace=".length);
    const revoke = args.find((a) => a.startsWith("--revoke="))?.slice("--revoke=".length);
    const list = index();
    const entry = mine(list).find((c) => c.workspace_id === workspace);
    if (!entry) fail(`no login in ${workspace}`);
    if (revoke) {
      if (server.revokeFails) fail(`cannot reach ${entry.server}`);
      appendFileSync(`${standIn}.revoked`, `${revoke}\n`);
    }
    rmSync(entry.login, { force: true });
    list.connections = list.connections.filter((c) => c !== entry);
    write(indexFile, list);
    break;
  }
  case "use": {
    const list = index();
    const folder = args.find((a) => a.startsWith("folder="))?.slice("folder=".length);
    if (!folder) fail("usage: quadit use W folder=PATH", 2);
    list.folders = list.folders.filter((f) => f.folder !== folder);
    if (args[0] !== "--clear") {
      if (!mine(list).some((c) => c.workspace_id === args[0])) fail(`this tool works in no workspace ${args[0]}`);
      list.folders.push({ folder, workspace_id: args[0], project: "" });
    }
    write(indexFile, list);
    break;
  }
  default:
    fail(`unknown command "${command}"`, 2);
}
