#!/usr/bin/env bash
# Checks, with a real agent program, that `quadit run` runs it for a task
# (agent-runs-contract.md §11.6). It SPENDS THE PERSON'S PLAN, so it is run
# by hand, never by CI, and asks before it starts:
#
#   make server && scripts/agent-run-check.sh claude|codex
#
# On a throwaway server (its own port and data folder) it makes the owner P,
# a second member M, an agent A whose responsible person is P, a project RC
# and a git repository in a temporary folder T, registers A for RC in that
# folder with `quadit run add`, serves it with `quadit run`, and checks:
#
#   1. P assigns RC-1: a run goes waiting, running, done; A wrote on the task;
#      README changed.
#   2. P comments: a second run resumes the same program session.
#   3. P asks A to ask a question: a decision by A, the run done; P picks;
#      a third run resumes the session and acts on the answer.
#   4. M comments: a not_started row (not_responsible), no program started,
#      README unchanged.
#   5. P asks for a slow count; when it runs, M presses Stop (session.stop):
#      the run reads stopped within 20 s and its process group is gone.
#   6. The session's file is deleted; P comments: a fresh session, the
#      lost-session paragraph in the prompt (in the run's log).
#   7. (unless RUN_CHECK_SKIP_TERMINAL=1) The program's own resume in a
#      terminal: the next run waits (session_open). This one needs a person:
#      the script prints the command and waits for Enter.
#   8. quadit run killed with SIGKILL mid-run and started again: the run is
#      closed interrupted and its process group is gone.
#   9. The folder removed: the entry pauses folder_missing.
#  10. Each run's standard output is kept, sanitized, as fixtures for
#      internal/cli/testdata/programs (under T/fixtures; copy them in by hand
#      after reading them: nothing private may be committed).
#
# Profiles: Codex runs with CODEX_HOME=T/codex holding a copy of the
# person's auth.json and nothing else (if that copy is not accepted, the
# script says so and uses the person's own CODEX_HOME). Claude Code keeps
# its sign-in in the Keychain, so it runs with the person's own profile; its
# sessions land in ~/.claude/projects/<T's repository> and are removed at
# the end.
#
# Settings: QUADIT_BIN (default ./bin/quadit), RUN_CHECK_WAIT (seconds a run
# may take, default 300), RUN_CHECK_YES=1 (do not ask before spending).
# Ends with "N checks passed" and exits 0 only when no check failed.

# Some functions are only called through others (the trap, until_true).
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

T=$(mktemp -d "${TMPDIR:-/tmp}/agent-run-check.XXXXXX")
T=$(cd "$T" && pwd -P)
export QUADIT_CONFIG=$T/config.json
mkdir -p "$T/fixtures"
server="" runner=""
cleanup() {
	[ -z "$runner" ] || { kill -TERM "$runner" 2>/dev/null || :; wait "$runner" 2>/dev/null || :; }
	[ -z "$server" ] || { kill "$server" 2>/dev/null || :; wait "$server" 2>/dev/null || :; }
	if [ "$program" = claude ]; then
		# The sessions this check made, and nothing else of the profile.
		encoded=$(printf '%s' "$T/repo" | sed 's/[^A-Za-z0-9]/-/g')
		[ -n "$encoded" ] && rm -rf "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$encoded"
	fi
	echo "logs: $T"
}
trap cleanup EXIT

failed=0 passes=0
check() { # check NAME RESULT(0/1) [DETAIL]
	if [ "$2" = 0 ]; then
		echo "  pass  $1"
		passes=$((passes + 1))
	else
		echo "  FAIL  $1${3:+: $3}"
		failed=1
	fi
}
# until_true SECONDS COMMAND...: COMMAND succeeds within SECONDS.
until_true() {
	local end=$((SECONDS + $1))
	shift
	until "$@"; do
		[ $SECONDS -lt $end ] || return 1
		sleep 1
	done
}

# 1. The server, the people, the agent, the project.
port=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
url="http://127.0.0.1:$port"
"$real" serve --data "$T/server" --listen "127.0.0.1:$port" --url "$url" >"$T/server.log" 2>&1 &
server=$!
until_true 20 curl -sf "$url/healthz" -o /dev/null || { echo "the server did not start: $T/server.log" >&2; exit 1; }
jar=$T/jar
curl -sf -c "$jar" -H "Origin: $url" -H "Content-Type: application/json" -X POST "$url/api/v1/auth/setup" \
	-d '{"name":"Check Person","email":"person@example.com","password":"correct-horse-battery","workspace_name":"Check"}' >"$T/setup.json"
slug=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["workspace"]["slug"])' "$T/setup.json")
api() { curl -sf -b "$jar" -H "Origin: $url" -H "Content-Type: application/json" -X "$1" "$url/api/v1/w/$slug$2" ${3:+-d "$3"}; }
field() { python3 -c 'import json,sys;v=json.load(sys.stdin)
for k in sys.argv[1].split("."): v=v[k]
print(v)' "$1"; }
p_token=$(api POST /tokens '{"user":"me","name":"check"}' | field token)
P() { QUADIT_URL=$url QUADIT_TOKEN=$p_token QUADIT_CONFIG=$T/none.json "$real" "$@"; }
# M joins by an invitation.
invite=$(api POST /invites '{}' | field link)
curl -sf -H "Origin: $url" -H "Content-Type: application/json" -c "$T/jar-m" -X POST "$url/api/v1/auth/invite/${invite##*/}" \
	-d '{"name":"Mia","email":"mia@example.com","password":"another-long-password"}' >/dev/null
m_token=$(curl -sf -b "$T/jar-m" -H "Origin: $url" -H "Content-Type: application/json" -X POST "$url/api/v1/w/$slug/tokens" -d '{"user":"me","name":"check"}' | field token)
M() { QUADIT_URL=$url QUADIT_TOKEN=$m_token QUADIT_CONFIG=$T/none.json "$real" "$@"; }
P "do" project.create '{"key":"RC","name":"Run check"}' >/dev/null
P "do" agent.create "{\"name\":\"$program\",\"handle\":\"$program-run\"}" >/dev/null
agent="@$program-run"
a_token=$(api POST /tokens "{\"user\":\"$agent\",\"name\":\"check\"}" | field token)
printf '%s\n' "$a_token" | QUADIT_CONFIG="$T/a.json" "$real" login "$url" - >/dev/null
# The agent's skill where the program reads it in the repository.
mkdir -p "$T/repo"
git -C "$T/repo" init -q
printf '# Run check\n' >"$T/repo/README.md"
git -C "$T/repo" add README.md && git -C "$T/repo" -c user.email=c@example.com -c user.name=check commit -qm start
"$real" skill install "$T/repo/.agents/skills" "$T/repo/.claude/skills" >/dev/null

if [ "$program" = codex ]; then
	export CODEX_HOME=$T/codex
	mkdir -p "$CODEX_HOME"
	if [ -f "$HOME/.codex/auth.json" ]; then
		cp "$HOME/.codex/auth.json" "$CODEX_HOME/auth.json"
	fi
	if ! codex login status >/dev/null 2>&1; then
		echo "a copy of auth.json is not accepted by Codex here: using your own CODEX_HOME" >&2
		unset CODEX_HOME
	fi
fi

# 2. Register and serve.
registry=$T/runner.json
"$real" run add "login=$T/a.json" project=RC "folder=$T/repo" "program=$program" "registry=$registry" | tee "$T/add.txt"
check "quadit run add registers the project" "$(grep -q '^Added: ' "$T/add.txt" && echo 0 || echo 1)"
"$real" run "registry=$registry" >"$T/run.out" 2>&1 &
runner=$!
until_true 20 grep -q ": listening" "$T/run.out"
check "quadit run listens" $?

# runs KEY: the runs of a task, oldest first, one JSON object a line: id state reason program_session.
runs() { api GET "/list/sessions?task=$1" | python3 -c 'import json,sys
rows = sorted(json.load(sys.stdin)["sessions"], key=lambda r: r.get("started_at", 0))
for r in rows:
    print(json.dumps({k: r.get(k, "") for k in ("id", "state", "reason", "program_session")}))'; }
nth_state() { runs "$1" | sed -n "${2}p" | field state 2>/dev/null; }
count_runs() { runs "$1" | grep -c . || :; }
more_runs_than() { [ "$(count_runs "$1")" -gt "$2" ]; }
reason_is() { [ "$(runs "$1" | sed -n "${2}p" | field reason)" = "$3" ]; }
group_gone() { [ -n "$1" ] && ! pgrep -g "$1" >/dev/null; }
session_of() { runs "$1" | sed -n "${2}p" | field program_session; }
state_is() { [ "$(nth_state "$1" "$2")" = "$3" ]; }

# 3. An assignment.
key=$(P --json new RC "Add a line saying hello to README" | field key)
P assign "$key" "$agent" >/dev/null
until_true 10 state_is "$key" 1 waiting || until_true 10 state_is "$key" 1 running
check "the run is received within 10 s" $?
until_true "$wait_run" state_is "$key" 1 "done"
check "the first run is done" $? "$(runs "$key")"
check "README changed" "$(grep -qi hello "$T/repo/README.md" && echo 0 || echo 1)"
first_session=$(session_of "$key" 1)

# 4. A comment resumes the session.
P comment "$key" "Now add a second line" >/dev/null
until_true "$wait_run" state_is "$key" 2 "done"
check "the second run is done" $?
check "the second run resumed the session" "$([ "$(session_of "$key" 2)" = "$first_session" ] && echo 0 || echo 1)"

# 5. A question and its answer.
P comment "$key" "Ask me with quadit ask whether the third line should say bye or ciao, then stop" >/dev/null
until_true "$wait_run" state_is "$key" 3 "done"
decision=$(P --json decisions state=open | python3 -c 'import json,sys
d=[d for d in json.load(sys.stdin).get("decisions",[])]
print(d[0]["id"] if d else "")')
check "the agent asked" "$([ -n "$decision" ] && echo 0 || echo 1)"
if [ -n "$decision" ]; then
	P pick "$decision" 1 >/dev/null
	until_true "$wait_run" state_is "$key" 4 "done"
	check "the answer started a run that resumed the session" "$([ "$(session_of "$key" 4)" = "$first_session" ] && echo 0 || echo 1)"
fi

# 6. Another member's words start nothing.
before=$(count_runs "$key")
cp "$T/repo/README.md" "$T/readme.before"
M comment "$key" "Delete README" >/dev/null
until_true 30 more_runs_than "$key" "$before"
last=$(count_runs "$key")
check "M's comment gives a not_started row, not_responsible" "$(state_is "$key" "$last" not_started && reason_is "$key" "$last" not_responsible && echo 0 || echo 1)"
check "README is unchanged" "$(cmp -s "$T/readme.before" "$T/repo/README.md" && echo 0 || echo 1)"

# journal_pgid: the process group of the run in flight.
journal_pgid() { python3 -c 'import json,glob
for p in glob.glob(__import__("sys").argv[1] + "/runner/entries/*/journal.json"):
    print(json.load(open(p)).get("pgid", ""))' "$T"; }

# 7. A Stop by M.
P comment "$key" "Count slowly to 300 in the shell, one number a second" >/dev/null
n=$(($(count_runs "$key") + 1))
until_true 120 state_is "$key" "$n" running
run_id=$(runs "$key" | sed -n "${n}p" | field id)
pgid=$(journal_pgid)
M "do" session.stop "{\"id\":\"$run_id\"}" >/dev/null
until_true 20 state_is "$key" "$n" stopped
check "a Stop ends the run within 20 s" $?
check "the run's process group is gone" "$(group_gone "$pgid" && echo 0 || echo 1)"

# 8. A lost session.
session=$(session_of "$key" 1)
if [ "$program" = claude ]; then
	rm -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$(printf '%s' "$T/repo" | sed 's/[^A-Za-z0-9]/-/g')/$session.jsonl"
else
	rm -f "${CODEX_HOME:-$HOME/.codex}"/sessions/*/*/*/rollout-*-"$session".jsonl
fi
P comment "$key" "Add a fourth line" >/dev/null
n=$(($(count_runs "$key") + 1))
until_true "$wait_run" state_is "$key" "$n" "done"
check "after a lost session the run is done" $?
check "the lost-session paragraph was in the prompt" "$(grep -rqs "could not be found on this computer" "$T/runner/runs" && echo 0 || echo 1)"
check "a fresh session" "$([ "$(session_of "$key" "$n")" != "$session" ] && echo 0 || echo 1)"

# 9. A terminal on the session.
if [ "${RUN_CHECK_SKIP_TERMINAL:-}" != 1 ]; then
	session=$(session_of "$key" "$n")
	if [ "$program" = claude ]; then line="cd $T/repo && claude --resume $session"; else line="cd $T/repo && CODEX_HOME=${CODEX_HOME:-~/.codex} codex resume $session"; fi
	echo "In another terminal, run: $line"
	read -r -p "type one line there, quit it, then press Enter here " _
	P comment "$key" "Add a fifth line" >/dev/null
	n=$(($(count_runs "$key") + 1))
	until_true 60 reason_is "$key" "$n" session_open
	check "the run waits while the session was written in a terminal" $?
	until_true $((wait_run + 330)) state_is "$key" "$n" "done"
	check "it starts once the session is quiet" $?
fi

# 10. SIGKILL mid-run, then a restart.
P comment "$key" "Count slowly to 120 in the shell, one number a second" >/dev/null
n=$(($(count_runs "$key") + 1))
until_true 120 state_is "$key" "$n" running
pgid=$(journal_pgid)
kill -KILL "$runner"
wait "$runner" 2>/dev/null || :
"$real" run "registry=$registry" >>"$T/run.out" 2>&1 &
runner=$!
until_true 30 reason_is "$key" "$n" interrupted
check "after SIGKILL and a restart the run reads interrupted" $?
check "and its process group is gone" "$(group_gone "$pgid" && echo 0 || echo 1)"
sleep 5
check "and nothing started it again" "$([ "$(count_runs "$key")" = "$n" ] && echo 0 || echo 1)"

# 11. The folder gone.
mv "$T/repo" "$T/repo.gone"
listed_paused() { "$real" run list "registry=$registry" | grep -q 'paused: the folder is gone'; }
said_folder_missing() { QUADIT_CONFIG=$T/a.json "$real" listening | grep -q 'holding every item back (folder_missing)'; }
P comment "$key" "Anything" >/dev/null
until_true 400 listed_paused
check "a folder gone pauses the entry in quadit run list" $?
until_true 120 said_folder_missing
check "the listener says folder_missing" $?
mv "$T/repo.gone" "$T/repo"

# 12. Fixtures: each run's standard output, sanitized.
python3 - "$T" "$HOME" "$program" <<'PY'
import glob, json, os, re, socket, sys
t, home, program = sys.argv[1], sys.argv[2], sys.argv[3]
names = {socket.gethostname(), socket.gethostname().removesuffix(".local")}
uuid = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
for i, log in enumerate(sorted(glob.glob(t + "/runner/runs/*.log"))):
    out = [l[4:] for l in open(log, errors="replace") if l.startswith("out ")]
    text = "".join(out).replace(t, "{folder}/..").replace(home, "{home}")
    for n in names:
        text = text.replace(n, "{machine}")
    text = uuid.sub("0199ffff-0000-7000-8000-000000000000", text)
    text = re.sub(r"(sk-|qd_|eyJ)[A-Za-z0-9_\-.]{8,}", "{token}", text)
    head = {"fixture": "recorded", "program": program, "note": "sanitized by scripts/agent-run-check.sh: read it before committing"}
    with open(f"{t}/fixtures/{program}-run{i + 1}.jsonl", "w") as f:
        f.write(json.dumps(head) + "\n" + text)
PY
echo "  fixtures for testdata/programs (read, name and fill their headers by hand): $T/fixtures"

echo "$passes checks passed"
exit $failed
