// A stand-in for the quadit command's runner forms (agent-runs-contract.md
// §5.2, §5.11, §5.12), for the desktop app's unit tests (src/main/runner.test.ts):
// small, and only what the app runs.
//
//   run                    serves until SIGTERM or SIGINT: holds the lock
//                          (runner/runner.lock, a pid; exit 3 when a live
//                          other holds it), writes runner/status.json
//                          ("ready" for each entry), drops entries marked
//                          removing, and with FAKE_RUN_PROGRAM=1 starts a
//                          program in a process group of its own, which it
//                          ends on SIGTERM.
//   run add login= project= folder= program= [program_path=]
//   run remove ID | login=PATH   marks removing and waits (2 s) for a serving runner, else drops
//   run list --json
//   --json me              the login file's "me" (QUADIT_CONFIG)
//   login --path
//
// Its folder is the default login folder under HOME, as quadit's is.

const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } = require("node:fs");
const { homedir } = require("node:os");
const path = require("node:path");

const home = process.env.HOME || homedir();
const dir =
  process.platform === "darwin"
    ? path.join(home, "Library", "Application Support", "quadit")
    : path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "quadit");
const registry = path.join(dir, "runner.json");
const lock = path.join(dir, "runner", "runner.lock");
const status = path.join(dir, "runner", "status.json");

const read = (file, empty) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : empty);
const write = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.next`, JSON.stringify(value, null, 2));
  renameSync(`${file}.next`, file);
};
const entries = () => read(registry, { version: 1, entries: [] }).entries;
const save = (list) =>
  write(registry, { version: 1, machine: { id: "3f9c0a7d5e21b864", name: "Test Mac" }, entries: list });
const tilde = (path) => (path.startsWith(home) ? `~${path.slice(home.length)}` : path);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** The pid of the runner that serves, or 0. */
const serving = () => {
  const pid = existsSync(lock) ? Number(readFileSync(lock, "utf8")) : 0;
  return pid && pid !== process.pid && alive(pid) ? pid : 0;
};
// Written at once: it exits right after.
const say = (words) => writeSync(1, `${words}\n`);
const refuse = (words) => {
  writeSync(2, `${words}\n`);
  process.exit(1);
};
const keyed = (args) => Object.fromEntries(args.map((arg) => arg.split(/=(.*)/s).slice(0, 2)));

const args = process.argv.slice(2);
const [first, second] = args;

if (first === "login" && second === "--path") {
  say(process.env.QUADIT_CONFIG || path.join(dir, "config.json"));
} else if (first === "--json" && second === "me") {
  const login = process.env.QUADIT_CONFIG;
  const me = login && existsSync(login) ? JSON.parse(readFileSync(login, "utf8")).me : undefined;
  if (!me) refuse("cannot reach https://q.example: connection refused");
  say(JSON.stringify(me));
} else if (first === "run" && second === "add") {
  const a = keyed(args.slice(2));
  if (!path.isAbsolute(a.folder ?? "")) refuse("folder= must be an absolute path");
  if (!existsSync(a.folder)) refuse(`${tilde(a.folder)} does not exist`);
  if (a.program !== "claude" && a.program !== "codex") refuse("program= is claude or codex");
  const me = JSON.parse(readFileSync(a.login, "utf8")).me;
  const list = entries();
  const same = list.find((e) => e.login === a.login && e.project === a.project);
  if (same) refuse(`${me.handle} already runs ${a.project} on this computer, in ${tilde(same.folder)}`);
  const id = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
  list.push({
    id,
    login: a.login,
    agent: me.handle,
    project: a.project,
    folder: a.folder,
    program: a.program,
    removing: false,
  });
  save(list);
  const title = a.program === "claude" ? "Claude Code" : "Codex";
  say(`Added: ${me.handle} runs ${a.project} in ${tilde(a.folder)} with ${title} 9.9.9 on Test Mac.`);
} else if (first === "run" && second === "remove") {
  const by = args[2] ?? "";
  const matches = (e) => (by.startsWith("login=") ? e.login === by.slice("login=".length) : e.id === by);
  const list = entries();
  if (!list.some(matches)) {
    say("Nothing to remove.");
    process.exit(0);
  }
  if (!serving()) {
    save(list.filter((e) => !matches(e)));
    say("Removed.");
    process.exit(0);
  }
  save(list.map((e) => (matches(e) ? { ...e, removing: true } : e)));
  const until = Date.now() + 2_000;
  const wait = () => {
    if (!entries().some(matches)) {
      say("Removed.");
      process.exit(0);
    }
    if (Date.now() > until)
      refuse("Quadit is still telling the server how the last run ended; it is removed once the server answers.");
    setTimeout(wait, 100);
  };
  wait();
} else if (first === "run" && second === "list" && args[2] === "--json") {
  const pid = serving();
  const states = pid ? read(status, { entries: {} }).entries : {};
  say(
    JSON.stringify({
      machine: { id: "3f9c0a7d5e21b864", name: "Test Mac" },
      serving: !!pid,
      entries: entries().map((e) => ({ ...e, ...(pid && states[e.id] ? { status: states[e.id] } : {}) })),
    }),
  );
} else if (first === "run" && args.length === 1) {
  const other = serving();
  if (other) {
    writeSync(2, `another quadit run serves this computer (pid ${other})\n`);
    process.exit(3);
  }
  mkdirSync(path.dirname(lock), { recursive: true });
  writeFileSync(lock, String(process.pid));
  say(`quadit run: serving ${entries().length} entries on Test Mac (stop with Ctrl-C)`);
  const programs = [];
  if (process.env.FAKE_RUN_PROGRAM === "1") {
    const program = spawn("/bin/sleep", ["600"], { detached: true, stdio: "ignore" });
    programs.push(program.pid);
    say(`program ${program.pid}`);
  }
  const tick = () => {
    const list = entries();
    if (list.some((e) => e.removing)) save(list.filter((e) => !e.removing));
    write(status, {
      version: 1,
      pid: process.pid,
      entries: Object.fromEntries(entries().map((e) => [e.id, { state: "ready", blocked: [] }])),
    });
  };
  tick();
  const timer = setInterval(tick, 200);
  const stop = () => {
    clearInterval(timer);
    for (const pid of programs) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        // Gone already.
      }
    }
    rmSync(lock, { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} else {
  refuse(`fake quadit: not a form it knows: ${args.join(" ")}`);
}
