// A stand-in for the quadit command's runner forms, for the desktop app's
// unit tests (src/main/runner.test.ts): what the app runs, answering as the
// real one does (internal/cli/run.go, run_status.go; agent-runs-contract.md,
// "The runner as built"): the same JSON, the same lines on the same output,
// the same exit codes.
//
//   run                    serves until SIGTERM or SIGINT: holds the lock
//                          (exit 3, "another quadit run serves this computer
//                          (pid N)", when another holds it), writes
//                          runner/status.json ("ready" for each entry), lets
//                          entries marked removing go, and with
//                          FAKE_RUN_PROGRAM=1 starts a program in a process
//                          group of its own, which it ends on SIGTERM.
//   run add login= project= folder= program= [program_path=]
//   run remove ID | login=PATH   with a runner serving: marks the entries removing and waits (2 s, the real one 60)
//   run list [--json]
//   run waiting login= project= --json   what the login file's "waiting" says of the project (read only)
//   run machine name=
//   --json me              the login file's "me" (QUADIT_CONFIG), as the server answers /me
//   login --path
//
// Where it differs, on purpose: the lock is a file holding the serving
// runner's pid, not a flock (a test says a runner serves by writing its own
// pid there); the folder rules are only the home folder and its ancestors
// (a test's folders are in the system's temporary folder, which the real
// rules refuse); the program's version is not asked.

const { spawn } = require("node:child_process");
const {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} = require("node:fs");
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
const MACHINE = { id: "3f9c0a7d5e21b864", name: "Test Mac" };
const TITLES = { claude: "Claude Code", codex: "Codex" };

const read = (file, empty) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : empty);
const write = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.next`, JSON.stringify(value, null, 2));
  renameSync(`${file}.next`, file);
};
const entries = () => read(registry, { entries: [] }).entries;
const save = (list) => write(registry, { version: 1, machine: MACHINE, entries: list });
const tilde = (p) => (p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
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
const keyed = (args) =>
  Object.fromEntries(args.filter((a) => a.includes("=")).map((a) => a.split(/=(.*)/s).slice(0, 2)));
const onPath = (name) =>
  (process.env.PATH ?? "")
    .split(":")
    .map((d) => path.join(d, name))
    .find((p) => existsSync(p) && statSync(p).isFile());

// A registry that cannot be read or written is said in one line, exit 1, as quadit says its errors.
process.on("uncaughtException", (err) => refuse(err.message));

const args = process.argv.slice(2);
const [first, second] = args;

if (first === "login" && second === "--path") {
  say(process.env.QUADIT_CONFIG || path.join(dir, "config.json"));
} else if (first === "--json" && second === "me") {
  const login = process.env.QUADIT_CONFIG;
  const me = login && existsSync(login) ? JSON.parse(readFileSync(login, "utf8")).me : undefined;
  if (!me) refuse("cannot reach https://q.example: connection refused");
  say(JSON.stringify(me, null, 2));
} else if (first === "run" && second === "add") {
  const a = keyed(args.slice(2));
  if (!a.login || !a.project || !a.folder || !a.program)
    refuse(
      "usage: quadit run add login=PATH project=KEY folder=PATH program=claude|codex [program_path=PATH] [max_minutes=N]",
    );
  const title = TITLES[a.program];
  if (!title) refuse("program= is claude or codex");
  if (!path.isAbsolute(a.folder)) refuse("folder= must be an absolute path");
  if (!existsSync(a.folder)) refuse(`${tilde(a.folder)} does not exist`);
  if (!statSync(a.folder).isDirectory()) refuse(`${tilde(a.folder)} is not a folder`);
  const folder = realpathSync(a.folder);
  if (folder === home) refuse("~ is your home folder: pick the project's own folder");
  if (home.startsWith(`${folder}/`) || folder === "/")
    refuse(`${folder} is above your home folder: pick the project's own folder`);
  const programPath = a.program_path || onPath(a.program);
  if (!programPath || !existsSync(programPath))
    refuse(`${title} was not found on this computer: install it, or give program_path=`);
  const me = existsSync(a.login) ? JSON.parse(readFileSync(a.login, "utf8")).me : undefined;
  if (!me) refuse("cannot reach https://q.example: connection refused");
  if (me.kind !== "agent")
    refuse(`this login is ${me.handle}'s, a person's: Quadit runs an agent with the agent's own login`);
  const names = me.project_names ?? {};
  const key = (me.projects ?? []).find(
    (k) => k.toLowerCase() === a.project.toLowerCase() || (names[k] ?? "").toLowerCase() === a.project.toLowerCase(),
  );
  if (!key)
    refuse(
      `${me.handle} may not work in ${a.project}: quadit me lists its projects${me.projects?.length ? ` (it may work in ${me.projects.join(", ")})` : ""}`,
    );
  const list = entries();
  for (const o of list) {
    if (o.agent === me.handle && o.project === key)
      refuse(`${me.handle} already runs ${o.project} on this computer, in ${tilde(o.folder)}`);
    if (o.folder === folder && o.project !== key)
      refuse(`${tilde(folder)} already runs ${o.project} on this computer: one project per folder`);
  }
  list.push({
    id: Math.random().toString(16).slice(2, 10).padEnd(8, "0"),
    server: "https://q.example",
    workspace_id: me.workspace_id ?? "w1",
    workspace: me.workspace_id ?? "personal",
    agent_id: `id-${me.handle}`,
    agent: me.handle,
    login: path.resolve(a.login),
    project_id: `id-${key}`,
    project: key,
    folder,
    program: a.program,
    program_path: programPath,
    mode: "in_place",
    max_minutes: 0,
    removing: false,
    added_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  });
  save(list);
  say(`Added: ${me.handle} runs ${key} in ${tilde(folder)} with ${title} 2.1.331 on ${MACHINE.name}.`);
} else if (first === "run" && second === "remove") {
  const rest = args.slice(2);
  const a = keyed(rest);
  const id = rest.find((r) => !r.includes("="));
  if (!id === !a.login) refuse("usage: quadit run remove ENTRY_ID | login=PATH [project=KEY]");
  const login = a.login && path.resolve(a.login);
  const matches = (e) =>
    id ? e.id === id : e.login === login && (!a.project || e.project.toLowerCase() === a.project.toLowerCase());
  const matched = entries().filter(matches);
  if (matched.length === 0) {
    say("Nothing to remove.");
    process.exit(0);
  }
  const done = () => {
    const left = entries();
    let code = 0;
    for (const m of matched) {
      if (left.some((e) => e.id === m.id)) {
        say(
          `Quadit is still telling the server how ${m.agent}'s last run ended; it is removed once the server answers.`,
        );
        code = 1;
      } else say(`Removed: ${m.agent} no longer runs ${m.project} on this computer.`);
    }
    process.exit(code);
  };
  if (!serving()) {
    // No runner serves: this one lets them go itself.
    save(entries().filter((e) => !matches(e)));
    done();
  }
  save(entries().map((e) => (matches(e) ? { ...e, removing: true } : e)));
  const until = Date.now() + 2_000;
  const wait = () => {
    if (!entries().some(matches) || Date.now() > until) done();
    else setTimeout(wait, 100);
  };
  wait();
} else if (first === "run" && second === "list") {
  const pid = serving();
  const states = pid ? read(status, { entries: {} }).entries : {};
  const list = entries();
  if (args.includes("--json")) {
    const out = {
      machine: read(registry, { machine: { id: "", name: "" } }).machine,
      serving: !!pid,
      entries: list.map((e) => (pid && states[e.id] ? { ...e, status: states[e.id] } : e)),
    };
    say(JSON.stringify(out, null, 2));
  } else if (list.length === 0) say("Nothing runs on this computer: quadit run add registers an agent's project.");
  else
    for (const e of list) {
      const words = e.removing
        ? "removing"
        : pid
          ? (states[e.id]?.state ?? "starting")
          : "not served: no quadit run is running";
      say(`${e.id}  ${e.agent}  ${e.project}  ${tilde(e.folder)}  ${TITLES[e.program] ?? e.program}  ${words}`);
    }
} else if (first === "run" && second === "waiting") {
  const a = keyed(args.slice(2));
  if (!a.login || !a.project) refuse("usage: quadit run waiting login=PATH project=KEY [--json]");
  const saved = existsSync(a.login) ? JSON.parse(readFileSync(a.login, "utf8")) : undefined;
  if (!saved?.me) refuse("cannot reach https://q.example: connection refused");
  const key = (saved.me.projects ?? []).find((k) => k.toLowerCase() === a.project.toLowerCase());
  if (!key) refuse(`${saved.me.handle} may not work in ${a.project}: quadit me lists its projects`);
  const waiting = saved.waiting?.[key] ?? { runs: 0, tasks: [] };
  say(
    JSON.stringify(
      { agent: saved.me.handle, project: key, runs: waiting.runs, tasks: waiting.tasks.slice(0, 5) },
      null,
      2,
    ),
  );
} else if (first === "run" && second === "machine") {
  const name = keyed(args.slice(2)).name ?? "";
  if (name.length < 1 || name.length > 64) refuse("name= is this computer's name: 1 to 64 characters");
  write(registry, { version: 1, machine: { ...MACHINE, name }, entries: entries() });
  say(`This computer is now ${JSON.stringify(name)}.`);
} else if (first === "run" && args.length === 1) {
  const other = serving();
  if (other) {
    writeSync(2, `another quadit run serves this computer (pid ${other})\n`);
    process.exit(3);
  }
  mkdirSync(path.dirname(lock), { recursive: true });
  writeFileSync(lock, String(process.pid));
  const count = entries().length;
  say(`quadit run: serving ${count} ${count === 1 ? "entry" : "entries"} on ${MACHINE.name} (stop with Ctrl-C)`);
  const programs = [];
  if (process.env.FAKE_RUN_PROGRAM === "1") {
    const program = spawn("/bin/sleep", ["600"], { detached: true, stdio: "ignore" });
    programs.push(program.pid);
    say(`program ${program.pid}`);
  }
  const tick = () => {
    const list = entries();
    if (list.some((e) => e.removing)) save(list.filter((e) => !e.removing));
    const ready = { state: "ready", task: "", since: "", pause: "", until: "", message: "", blocked: [] };
    write(status, {
      version: 1,
      pid: process.pid,
      at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      machine: MACHINE,
      entries: Object.fromEntries(entries().map((e) => [e.id, ready])),
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
  refuse(
    "usage: quadit run [registry=PATH] | run add … | run remove … | run list | run machine name=… | run --secret NAME -- COMMAND (quadit help run)",
  );
}
