#!/usr/bin/env bash
# Checks, with a real agent program, that `quadit run` runs it for a task
# (agent-runs-contract.md §11.6). It SPENDS THE PERSON'S PLAN, so it is run
# by hand, never by CI, and asks before it starts:
#
#   make server && scripts/agent-run-check.sh claude|codex
#
# On a throwaway server (its own port and data folder) it makes the owner P,
# a second member M, an agent A whose responsible person is P, a project RC,
# and a git repository; registers A for RC in that repository with `quadit
# run add`, serves it with `quadit run`, and checks, one line per step
# (PASS or FAIL, and what it saw), stopping at the first failure with the
# paths of the logs:
#
#   assignment: a run goes waiting, running, done; README changed
#   a comment: a second run resumes the same program session
#   a question: a decision by A; P picks; the next run resumes the session
#   M's comment: a not_started row (not_responsible); nothing started
#   a Stop by M: the run reads stopped within 20 s; its process group gone
#   a lost session: a fresh one, the lost-session words in the prompt
#   a terminal on the session (needs you; RUN_CHECK_SKIP_TERMINAL=1 skips):
#     the next run waits (session_open), then runs
#   quadit run killed with SIGKILL mid-run, then started again: the run reads
#     interrupted, its group is gone, nothing starts twice
#   the folder gone: the entry pauses folder_missing
#   fixtures: each run's standard output, sanitized, for testdata/programs
#
# Where things are:
#   logs, the server's data, the registry: a folder under $TMPDIR (kept, and
#     named at the end);
#   the repository: a private folder in your home folder,
#     ~/.quadit-run-check.XXXXXX/repo (the folder rules refuse $TMPDIR and
#     /tmp), removed at the end;
#   Codex runs with CODEX_HOME holding only a copy of your auth.json, removed
#     at the end (when that copy is refused, your own CODEX_HOME is used);
#   Claude Code keeps its sign-in in the Keychain, so it runs with your own
#     profile; the sessions it makes for the throwaway repository
#     (~/.claude/projects/<that repository>) are removed at the end.
# Every session id it deletes or shows is the one quadit run recorded on
# this computer (its state.json), a UUID, never a server's value; a file is
# deleted only after its contents name the throwaway repository.
#
# Settings: QUADIT_BIN (default ./bin/quadit), RUN_CHECK_WAIT (seconds a run
# may take, default 300), RUN_CHECK_YES=1 (do not ask before spending).

# Some functions are only called through others (the trap, expect).
# shellcheck disable=SC2329
set -euo pipefail

program=${1:?usage: scripts/agent-run-check.sh claude|codex}
case $program in claude | codex) ;; *) echo "usage: scripts/agent-run-check.sh claude|codex" >&2; exit 2 ;; esac
root=$(cd "$(dirname "$0")/.." && pwd)
real=$(cd "$root" && realpath "${QUADIT_BIN:-./bin/quadit}")
wait_run=${RUN_CHECK_WAIT:-300}
[ -x "$real" ] || { echo "no quadit at $real: run make server, or set QUADIT_BIN" >&2; exit 2; }
command -v "$program" >/dev/null || { echo "$program is not on PATH" >&2; exit 2; }

# Nothing of the person's Quadit reaches this check.
for v in $(env | sed -n 's/^\(QUADIT_[A-Z_]*\)=.*/\1/p'); do unset "$v"; done

if [ "${RUN_CHECK_YES:-}" != 1 ]; then
	echo "This check runs $program for real, several times: it spends your plan."
	read -r -p "Go on? [y/N] " answer
	[ "$answer" = y ] || [ "$answer" = Y ] || exit 1
fi

W=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/agent-run-check.XXXXXX")" && pwd -P)
private=$(cd "$(mktemp -d "$HOME/.quadit-run-check.XXXXXX")" && pwd -P)
chmod 700 "$private"
repo=$private/repo
export QUADIT_CONFIG=$W/config.json
mkdir -p "$W/fixtures"
server="" runner="" copied_auth=""
# encoded: the folder Claude Code keeps a folder's sessions in.
encoded() { printf '%s' "$1" | sed 's/[^A-Za-z0-9]/-/g'; }
claude_projects=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects
cleanup() {
	[ -z "$runner" ] || { kill -TERM "$runner" 2>/dev/null || :; wait "$runner" 2>/dev/null || :; }
	[ -z "$server" ] || { kill "$server" 2>/dev/null || :; wait "$server" 2>/dev/null || :; }
	[ -z "$copied_auth" ] || rm -f "$copied_auth"
	if [ "$program" = claude ] && [ -d "$claude_projects/$(encoded "$repo")" ]; then
		rm -rf "${claude_projects:?}/$(encoded "$repo")"
	fi
	rm -rf "$private"
}
trap cleanup EXIT

pass() { printf 'PASS  %s: %s\n' "$1" "$2"; }
fail() {
	printf 'FAIL  %s: %s\n' "$1" "$2"
	printf 'logs: %s (quadit run: %s, the server: %s, each run: %s)\n' "$W" "$W/run.out" "$W/server.log" "$W/runner/runs"
	exit 1
}
# expect NAME SECONDS CHECK [ARG ...]: CHECK, which prints what it sees,
# succeeds within SECONDS; else the check stops here.
expect() {
	local name=$1 secs=$2 seen end
	shift 2
	end=$((SECONDS + secs))
	while :; do
		if seen=$("$@" 2>&1); then
			pass "$name" "$seen"
			return
		fi
		[ $SECONDS -lt "$end" ] || fail "$name" "$seen"
		sleep 1
	done
}

# The server, the people, the agent, the project, the repository.
port=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
url="http://127.0.0.1:$port"
"$real" serve --data "$W/server" --listen "127.0.0.1:$port" --url "$url" >"$W/server.log" 2>&1 &
server=$!
up() { curl -sf "$url/healthz" -o /dev/null && echo "the server answers on $url"; }
expect "a throwaway server" 20 up
jar=$W/jar
curl -sf -c "$jar" -H "Origin: $url" -H "Content-Type: application/json" -X POST "$url/api/v1/auth/setup" \
	-d '{"name":"Check Person","email":"person@example.com","password":"correct-horse-battery","workspace_name":"Check"}' >"$W/setup.json"
slug=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["workspace"]["slug"])' "$W/setup.json")
api() { curl -sf -b "$jar" -H "Origin: $url" -H "Content-Type: application/json" -X "$1" "$url/api/v1/w/$slug$2" ${3:+-d "$3"}; }
field() { python3 -c 'import json,sys;v=json.load(sys.stdin)
for k in sys.argv[1].split("."): v=v[k]
print(v)' "$1"; }
p_token=$(api POST /tokens '{"user":"me","name":"check"}' | field token)
P() { QUADIT_URL=$url QUADIT_TOKEN=$p_token QUADIT_CONFIG=$W/none.json "$real" "$@"; }
invite=$(api POST /invites '{}' | field link)
curl -sf -H "Origin: $url" -H "Content-Type: application/json" -c "$W/jar-m" -X POST "$url/api/v1/auth/invite/${invite##*/}" \
	-d '{"name":"Mia","email":"mia@example.com","password":"another-long-password"}' >/dev/null
m_token=$(curl -sf -b "$W/jar-m" -H "Origin: $url" -H "Content-Type: application/json" -X POST "$url/api/v1/w/$slug/tokens" -d '{"user":"me","name":"check"}' | field token)
M() { QUADIT_URL=$url QUADIT_TOKEN=$m_token QUADIT_CONFIG=$W/none.json "$real" "$@"; }
P "do" project.create '{"key":"RC","name":"Run check"}' >/dev/null
P "do" agent.create "{\"name\":\"$program\",\"handle\":\"$program-run\"}" >/dev/null
agent="@$program-run"
a_token=$(api POST /tokens "{\"user\":\"$agent\",\"name\":\"check\"}" | field token)
printf '%s\n' "$a_token" | QUADIT_CONFIG="$W/a.json" "$real" login "$url" - >/dev/null
mkdir -p "$repo"
git -C "$repo" init -q
printf '# Run check\n' >"$repo/README.md"
git -C "$repo" add README.md && git -C "$repo" -c user.email=c@example.com -c user.name=check commit -qm start
"$real" skill install "$repo/.agents/skills" "$repo/.claude/skills" >/dev/null

if [ "$program" = codex ]; then
	export CODEX_HOME=$W/codex
	mkdir -p "$CODEX_HOME" && chmod 700 "$CODEX_HOME"
	if [ -f "$HOME/.codex/auth.json" ]; then
		cp "$HOME/.codex/auth.json" "$CODEX_HOME/auth.json"
		copied_auth=$CODEX_HOME/auth.json
	fi
	if ! codex login status >/dev/null 2>&1; then
		echo "Codex does not take a copy of auth.json here: your own CODEX_HOME is used" >&2
		rm -f "$copied_auth"
		copied_auth=""
		unset CODEX_HOME
	fi
fi

# What the check reads.
registry=$W/runner.json
runs() { api GET "/list/sessions?task=$1" | python3 -c 'import json,sys
rows = sorted(json.load(sys.stdin)["sessions"], key=lambda r: r.get("started_at", 0))
for r in rows:
    print(json.dumps({k: r.get(k) or "" for k in ("id", "state", "reason")}))'; }
count_runs() { runs "$1" | grep -c . || :; }
# run_is KEY N STATE [REASON]: the Nth run (from 1) is in STATE (with REASON).
run_is() {
	local row
	row=$(runs "$1" | sed -n "${2}p")
	[ -n "$row" ] || { echo "run $2 of $1 is not there yet"; return 1; }
	local state reason
	state=$(printf '%s' "$row" | field state) reason=$(printf '%s' "$row" | field reason)
	echo "run $2 of $1 is $state${reason:+ ($reason)}"
	[ "$state" = "$3" ] && { [ -z "${4:-}" ] || [ "$reason" = "$4" ]; }
}
run_open_or_done() { run_is "$1" "$2" waiting || run_is "$1" "$2" running || run_is "$1" "$2" "done"; }
# local_session KEY: the program session quadit run recorded for KEY on this computer, a UUID.
local_session() { python3 -c 'import glob,json,re,sys
for p in glob.glob(sys.argv[1] + "/runner/entries/*/state.json"):
    s = json.load(open(p)).get("tasks", {}).get(sys.argv[2], {}).get("session", "")
    if re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", s):
        print(s)' "$W" "$1"; }
session_is() { local s; s=$(local_session "$1"); echo "the recorded session of $1 is ${s:-none}"; [ -n "$s" ] && [ "$s" = "$2" ]; }
session_is_not() { local s; s=$(local_session "$1"); echo "the recorded session of $1 is ${s:-none}"; [ -n "$s" ] && [ "$s" != "$2" ]; }
journal_pgid() { python3 -c 'import glob,json,sys
for p in glob.glob(sys.argv[1] + "/runner/entries/*/journal.json"):
    print(json.load(open(p)).get("pgid", ""))' "$W"; }
group_gone() { if [ -n "$1" ] && ! pgrep -g "$1" >/dev/null; then echo "process group $1 is gone"; else echo "process group ${1:-?} still runs"; return 1; fi; }
said() { if grep -q "$1" "$W/run.out"; then echo "quadit run said: $(grep "$1" "$W/run.out" | tail -1)"; else echo "quadit run did not say \"$1\""; return 1; fi; }
readme_has() { if grep -qi "$1" "$repo/README.md"; then echo "README has \"$1\""; else echo "README lacks \"$1\": $(tr '\n' ' ' <"$repo/README.md")"; return 1; fi; }
start_runner() {
	"$real" run "registry=$registry" >>"$W/run.out" 2>&1 &
	runner=$!
}

# Register and serve.
added() { "$real" run add "login=$W/a.json" project=RC "folder=$repo" "program=$program" "registry=$registry"; }
expect "quadit run add registers the project" 30 added
start_runner
# The program's own settings may make it work as another Quadit agent: then
# the entry pauses, and this check cannot go on without changing them,
# which it never does.
listens_or_mismatch() { "$real" run list "registry=$registry" | grep -Eq 'ready|working on|login' || grep -q ": listening" "$W/run.out"; }
expect "quadit run starts the entry" 30 listens_or_mismatch
if "$real" run list "registry=$registry" | grep -q "work as another Quadit login"; then
	title=$([ "$program" = claude ] && echo "Claude Code" || echo "Codex")
	echo "STOP  $title on this computer is set up to work as another Quadit agent (its settings set QUADIT_CONFIG): this check cannot run here without changing that. Run it where $title is not connected to another Quadit."
	exit 1
fi
expect "quadit run listens" 30 said ": listening"

key=$(P --json new RC "Add a line saying hello to README" | field key)
P assign "$key" "$agent" >/dev/null
expect "the assignment is received" 15 run_open_or_done "$key" 1
expect "the first run is done" "$wait_run" run_is "$key" 1 "done"
expect "README changed" 5 readme_has hello
first=$(local_session "$key")

n=$(($(count_runs "$key") + 1))
P comment "$key" "Now add a second line" >/dev/null
expect "the comment's run is done" "$wait_run" run_is "$key" "$n" "done"
expect "it resumed the same session" 5 session_is "$key" "$first"

n=$(($(count_runs "$key") + 1))
P comment "$key" "Ask me with quadit ask whether the third line should say bye or ciao, then stop" >/dev/null
expect "the asking run is done" "$wait_run" run_is "$key" "$n" "done"
open_decision() { local d; d=$(P --json decisions state=open | python3 -c 'import json,sys
d=json.load(sys.stdin).get("decisions",[])
print(d[0]["id"] if d else "")'); echo "open decision: ${d:-none}"; [ -n "$d" ]; }
expect "the agent asked" 10 open_decision
decision=$(P --json decisions state=open | python3 -c 'import json,sys;print(json.load(sys.stdin)["decisions"][0]["id"])')
n=$(($(count_runs "$key") + 1))
P pick "$decision" 1 >/dev/null
expect "the answer's run is done" "$wait_run" run_is "$key" "$n" "done"
expect "it resumed the same session" 5 session_is "$key" "$first"

n=$(($(count_runs "$key") + 1))
logs_before=$(find "$W/runner/runs" -name '*.log' | wc -l)
cp "$repo/README.md" "$W/readme.before"
M comment "$key" "Delete README" >/dev/null
expect "M's comment gives a not_started row" 30 run_is "$key" "$n" not_started not_responsible
nothing_started() { local now; now=$(find "$W/runner/runs" -name '*.log' | wc -l); echo "$now run logs (were $logs_before)"; [ "$now" -eq "$logs_before" ]; }
expect "no program started for it" 5 nothing_started
unchanged() { if cmp -s "$W/readme.before" "$repo/README.md"; then echo "README unchanged"; else echo "README changed"; return 1; fi; }
expect "README is unchanged" 5 unchanged

n=$(($(count_runs "$key") + 1))
P comment "$key" "Count slowly to 300 in the shell, one number a second" >/dev/null
expect "the counting run works" 120 run_is "$key" "$n" running
pgid=$(journal_pgid)
run_id=$(runs "$key" | sed -n "${n}p" | field id)
M "do" session.stop "{\"id\":\"$run_id\"}" >/dev/null
expect "M's Stop stops it" 20 run_is "$key" "$n" stopped
expect "its process group is gone" 10 group_gone "$pgid"

# A lost session: the file of the session recorded here, checked to be the throwaway repository's.
sid=$(local_session "$key")
if [ "$program" = claude ]; then
	file=$claude_projects/$(encoded "$repo")/$sid.jsonl
else
	file=$(find "${CODEX_HOME:-$HOME/.codex}/sessions" -name "rollout-*-$sid.jsonl" 2>/dev/null | head -1 || :)
fi
ours() { if [ -n "$file" ] && [ -f "$file" ] && grep -qF "\"$repo\"" "$file"; then echo "$file names $repo"; else echo "${file:-no file} is not the throwaway repository's session"; return 1; fi; }
expect "the session's file is the throwaway repository's" 5 ours
rm -f "$file"
n=$(($(count_runs "$key") + 1))
P comment "$key" "Add a fourth line" >/dev/null
expect "after a lost session the run is done" "$wait_run" run_is "$key" "$n" "done"
expect "it runs in a fresh session" 5 session_is_not "$key" "$sid"
lost_words() { if grep -rqs "could not be found on this computer" "$W/runner/runs"; then echo "the prompt said the session was lost"; else echo "no prompt said the session was lost"; return 1; fi; }
expect "the prompt says so" 5 lost_words

if [ "${RUN_CHECK_SKIP_TERMINAL:-}" != 1 ]; then
	sid=$(local_session "$key")
	if [ "$program" = claude ]; then
		printf 'In another terminal, run:  cd %q && claude --resume %q\n' "$repo" "$sid"
	else
		printf 'In another terminal, run:  cd %q && CODEX_HOME=%q codex resume %q\n' "$repo" "${CODEX_HOME:-$HOME/.codex}" "$sid"
	fi
	read -r -p "type one line there, quit it, then press Enter here " _
	n=$(($(count_runs "$key") + 1))
	P comment "$key" "Add a fifth line" >/dev/null
	expect "the run waits while the session was written in a terminal" 60 run_is "$key" "$n" waiting session_open
	expect "it runs once the session is quiet" $((wait_run + 330)) run_is "$key" "$n" "done"
fi

n=$(($(count_runs "$key") + 1))
P comment "$key" "Count slowly to 120 in the shell, one number a second" >/dev/null
expect "the counting run works" 120 run_is "$key" "$n" running
pgid=$(journal_pgid)
kill -KILL "$runner"
wait "$runner" 2>/dev/null || :
start_runner
expect "after SIGKILL and a restart the run reads interrupted" 30 run_is "$key" "$n" failed interrupted
expect "its process group is gone" 10 group_gone "$pgid"
sleep 5
no_more() { local now; now=$(count_runs "$key"); echo "$now runs (the interrupted one is $n)"; [ "$now" -eq "$n" ]; }
expect "nothing started it again" 5 no_more

mv "$repo" "$repo.gone"
P comment "$key" "Anything" >/dev/null
listed_paused() { local line; line=$("$real" run list "registry=$registry"); echo "$line"; printf '%s' "$line" | grep -q 'paused: the folder is gone'; }
expect "the folder gone pauses the entry" 400 listed_paused
said_missing() { local line; line=$(QUADIT_CONFIG=$W/a.json "$real" listening | grep '^RC:'); echo "$line"; printf '%s' "$line" | grep -q '(folder_missing)'; }
expect "the listener says folder_missing" 120 said_missing
mv "$repo.gone" "$repo"

# Fixtures: each run's standard output, sanitized; read them before committing any.
python3 - "$W" "$HOME" "$program" "$repo" <<'PY'
import glob, json, re, socket, sys
w, home, program, repo = sys.argv[1:5]
names = {socket.gethostname(), socket.gethostname().removesuffix(".local")}
uuid = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
for i, log in enumerate(sorted(glob.glob(w + "/runner/runs/*.log"))):
    text = "".join(l[4:] for l in open(log, errors="replace") if l.startswith("out "))
    text = text.replace(repo, "{folder}").replace(w, "{work}").replace(home, "{home}")
    for n in names:
        text = text.replace(n, "{machine}")
    text = uuid.sub("0199ffff-0000-7000-8000-000000000000", text)
    text = re.sub(r"(sk-|qd_|eyJ)[A-Za-z0-9_\-.]{8,}", "{token}", text)
    head = {"fixture": "recorded", "program": program, "note": "sanitized by scripts/agent-run-check.sh: read it, and fill in exit, stderr and expect, before committing"}
    with open(f"{w}/fixtures/{program}-run{i + 1}.jsonl", "w") as f:
        f.write(json.dumps(head) + "\n" + text)
PY
pass "fixtures" "$W/fixtures (sanitized; read before copying any into internal/cli/testdata/programs)"
echo "all checks passed; logs: $W"
