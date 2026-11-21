#!/usr/bin/env bash
# Checks, with a real agent tool, that it connects to Quadit and listens from
# ordinary words (desktop contract §11). It spends the person's plan, so it
# is run by hand, never by CI:
#
#   make server && scripts/agent-listen-check.sh codex
#
# TOOL is codex, claude, agy, gemini or cursor-agent. On a throwaway server
# (its own port and data folder) it makes an agent with a login file of its
# own, then runs the tool's one-prompt command twice:
#
#   1. "Connect to Quadit CODE": the agent becomes connected, and no wait
#      was started.
#   2. "Listen to Quadit", left running: the agent shows as listening, one
#      empty wait passes, two comments on its task are answered once each, as
#      itself; a second session told to listen is refused; after the first is
#      stopped, a third comment gets no answer.
#
# It prints the tool's version, each wait's length and the tokens used, as
# far as the tool says them, and the folder that keeps every log.
#
# The tool never reaches the person's own Quadit: every quadit command it is
# told to run is a wrapper (WORK/bin/quadit) that drops QUADIT_URL and
# QUADIT_TOKEN and points QUADIT_CONFIG at this check's login file, whatever
# the tool's settings set; the tool's environment carries this server's
# address and the agent's token too, which win over any login file for a
# bare `quadit`. The wrapper logs each call (WORK/calls.log): that is how the
# waits are seen and timed.
#
# Adjusting it per tool:
#   AGENT_CHECK_COMMAND  the one-prompt command, as a shell line that gets the
#                        prompt in "$1" and runs in WORK/cwd, e.g.
#                        'codex exec --skip-git-repo-check "$1"'
#   AGENT_CHECK_STEER    the sentence after each prompt that names the
#                        wrapper (default: "Use WORK/bin/quadit for the
#                        quadit command."); "" for none
#   AGENT_CHECK_IDLE     seconds the listener is left with nothing (default 150)
#   AGENT_CHECK_ANSWER   seconds an answer may take (default 300)
#   QUADIT_BIN           the quadit to test (default ./bin/quadit)
#
# Needs bash, curl and python3. Exits 0 when every check passed.

# Some functions are only called through others (the trap, passed, until_true).
# shellcheck disable=SC2329
set -euo pipefail

tool=${1:?usage: scripts/agent-listen-check.sh codex|claude|agy|gemini|cursor-agent}
root=$(cd "$(dirname "$0")/.." && pwd)
real=$(cd "$root" && realpath "${QUADIT_BIN:-./bin/quadit}")
idle=${AGENT_CHECK_IDLE:-150}
answer_time=${AGENT_CHECK_ANSWER:-300}

# Nothing of the person's Quadit reaches this check.
for v in $(env | sed -n 's/^\(QUADIT_[A-Z_]*\)=.*/\1/p'); do unset "$v"; done

# The tool's one-prompt command; the prompt is "$1". Each line is the tool's documented one-prompt form
# (docs/agents.md) with the permission it needs to run the quadit command without asking: check it against
# the tool's version before a run, and set AGENT_CHECK_COMMAND to change it. They are expanded by the shell
# that runs them (run), not here.
# shellcheck disable=SC2016
case $tool in
codex) default_command='codex exec --skip-git-repo-check -s workspace-write -c sandbox_workspace_write.network_access=true "$1"' ;;
claude) default_command='claude -p --output-format json --allowedTools "Bash($AGENT_CHECK_WRAPPER:*)" "$1"' ;;
agy) default_command='agy -p "$1"' ;;
gemini) default_command='gemini -p "$1"' ;;
cursor-agent) default_command='cursor-agent -p --force "$1"' ;;
*) default_command="" ;;
esac
command=${AGENT_CHECK_COMMAND:-$default_command}
[ -n "$command" ] || { echo "no one-prompt command for $tool: set AGENT_CHECK_COMMAND" >&2; exit 2; }
[ -x "$real" ] || { echo "no quadit at $real: run make server, or set QUADIT_BIN" >&2; exit 2; }

work=$(mktemp -d "${TMPDIR:-/tmp}/agent-listen-check.XXXXXX")
mkdir -p "$work/bin" "$work/cwd"
server="" sessions=()
cleanup() {
	for pid in "${sessions[@]}"; do kill -TERM -- "-$pid" 2>/dev/null || :; done
	[ -z "$server" ] || { kill "$server" 2>/dev/null || :; wait "$server" 2>/dev/null || :; }
	echo "logs: $work"
}
trap cleanup EXIT

failed=0
check() { # check NAME CONDITION-RESULT(0/1) [DETAIL]
	if [ "$2" = 0 ]; then echo "  pass  $1"; else echo "  FAIL  $1${3:+: $3}"; failed=1; fi
}

# The server, on a free port, with a data folder of its own.
port=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
url="http://127.0.0.1:$port"
"$real" serve --data "$work/server" --listen "127.0.0.1:$port" --url "$url" >"$work/server.log" 2>&1 &
server=$!
for _ in $(seq 100); do curl -sf "$url/healthz" >/dev/null 2>&1 && break; sleep 0.2; done
curl -sf "$url/healthz" >/dev/null || { echo "the server did not start: $work/server.log" >&2; exit 1; }

# The person, signed in by a cookie for the set-up and by a token after it.
jar=$work/jar
curl -sf -c "$jar" -H "Origin: $url" -H "Content-Type: application/json" -X POST "$url/api/v1/auth/setup" \
	-d '{"name":"Check Person","email":"person@example.com","password":"correct-horse-battery","workspace_name":"Check"}' >"$work/setup.json"
slug=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["workspace"]["slug"])' "$work/setup.json")
api() { curl -sf -b "$jar" -H "Origin: $url" -H "Content-Type: application/json" -X "$1" "$url/api/v1/w/$slug$2" ${3:+-d "$3"}; }
field() { python3 -c 'import json,sys;v=json.load(sys.stdin)
for k in sys.argv[1].split("."): v=v[k]
print(v)' "$1"; }
person_token=$(api POST /tokens '{"user":"me","name":"check"}' | field token)
person() { QUADIT_URL=$url QUADIT_TOKEN=$person_token QUADIT_CONFIG=$work/none.json "$real" "$@"; }

# The agent, with a login file of its own.
handle="$tool-check"
person "do" agent.create "{\"name\":\"$tool\",\"handle\":\"$handle\"}" >/dev/null
agent_token=$(api POST /tokens "{\"user\":\"@$handle\",\"name\":\"check\"}" | field token)
printf '%s\n' "$agent_token" | QUADIT_CONFIG="$work/agent-login.json" "$real" login "$url" - >/dev/null

# The quadit the tool is told to run.
wrapper=$work/bin/quadit
cat >"$wrapper" <<EOF
#!/bin/sh
# This check's own login, whatever the tool's settings set; each call logged.
unset QUADIT_URL QUADIT_TOKEN
export QUADIT_CONFIG="$work/agent-login.json"
start=\$(date +%s)
echo "\$start start \${AGENT_CHECK_SESSION:-?} \$*" >>"$work/calls.log"
"$real" "\$@" >"$work/out.\$\$" 2>&1
status=\$?
cat "$work/out.\$\$"
end=\$(date +%s)
echo "\$end end \${AGENT_CHECK_SESSION:-?} status=\$status \$((end - start))s \$* => \$(head -n 1 "$work/out.\$\$")" >>"$work/calls.log"
rm -f "$work/out.\$\$"
exit \$status
EOF
chmod +x "$wrapper"
touch "$work/calls.log"
steer=${AGENT_CHECK_STEER-"Use $wrapper for the quadit command."}

# run SESSION PROMPT: the tool's one prompt, in its own process group, its output in WORK/SESSION.log.
run() {
	(
		cd "$work/cwd"
		export AGENT_CHECK_SESSION=$1 AGENT_CHECK_WRAPPER=$wrapper QUADIT_URL=$url QUADIT_TOKEN=$agent_token PATH="$work/bin:$PATH"
		exec sh -c "$command" sh "$2${steer:+ $steer}"
	) >"$work/$1.log" 2>&1
}
calls() { grep " end $1 " "$work/calls.log" || :; }
agents() { api GET /agents | python3 -c 'import json,sys
a=[a for a in json.load(sys.stdin)["agents"] if a["handle"]==sys.argv[1]][0]
print(("connected" if a.get("connected_at") else "not-connected")+" "+("listening" if a["listening"] else "not-listening"))' "@$handle"; }
answers() { person --json show "$1" | python3 -c 'import json,sys;print(sum(c["by"]==sys.argv[1] for c in json.load(sys.stdin).get("comments") or []))' "@$handle"; }
until_true() { # until_true SECONDS COMMAND...: polls once a second
	local end=$((SECONDS + $1)); shift
	until "$@"; do [ "$SECONDS" -lt "$end" ] || return 1; sleep 1; done
}
listens() { [ "$(agents)" = "connected listening" ]; }
answered() { [ "$(answers "$key")" -ge "$1" ]; }
passed() { if "$@"; then echo 0; else echo 1; fi; }

echo "tool: $tool"
case $tool in codex | claude | agy | gemini | cursor-agent) echo "version: $("$tool" --version 2>&1 | head -n 1)" ;; esac
echo "server: $url (workspace $slug), agent @$handle"

# 1. Connect.
echo "1. Connect to Quadit"
code=$(api POST /connect-codes "{\"agent\":\"@$handle\",\"tool\":\"$tool\"}" | field code)
run connect "Connect to Quadit $code" || :
check "the agent gave its code back" "$(calls connect | grep -q " connect $code" && echo 0 || echo 1)"
check "the agent is connected" "$([ "$(agents)" = "connected not-listening" ] && echo 0 || echo 1)" "$(agents)"
check "no wait was started" "$(calls connect | grep -Eq " (wait|listen)( |$)" && echo 1 || echo 0)"

# 2. Listen.
echo "2. Listen to Quadit"
key=$(person --json new GS "Say what 2 and 2 make" "assignee=@$handle" | field key)
set -m
run listen "Listen to Quadit" &
sessions+=($!)
set +m
check "the agent shows as listening" "$(passed until_true 180 listens)" "$(agents)"
# The assignment is the first item: it is handled (or not) before the comments.
sleep "$idle"
check "an empty wait passed" "$(calls listen | grep " wait" | grep -q "=> IDLE" && echo 0 || echo 1)"
# Answers counted are the agent's comments on the task; one to the assignment itself would be counted too, so
# they are counted from what is there before each comment.
base=$(answers "$key")
person comment "$key" "@$handle what do 2 and 2 make? Answer here in a comment." >/dev/null
check "the first comment was answered" "$(passed until_true "$answer_time" answered $((base + 1)))" "$(answers "$key") answers"
person comment "$key" "@$handle and 3 and 3? Answer here in a comment." >/dev/null
check "the second comment was answered" "$(passed until_true "$answer_time" answered $((base + 2)))" "$(answers "$key") answers"
sleep 30
check "each was answered once" "$([ "$(answers "$key")" = $((base + 2)) ] && echo 0 || echo 1)" "$(answers "$key") answers"

# A second session told to listen is refused while the first listens.
echo "   a second session"
second_session=0
timeout_at=$((SECONDS + answer_time))
set -m
run second "Listen to Quadit" &
second_pid=$!
sessions+=("$second_pid")
set +m
while kill -0 "$second_pid" 2>/dev/null && [ $SECONDS -lt $timeout_at ]; do sleep 2; done
if kill -0 "$second_pid" 2>/dev/null; then
	kill -TERM -- "-$second_pid" 2>/dev/null || :
	second_session=1
fi
check "the second session ended by itself" "$second_session"
check "the second session was refused" "$(calls second | grep " wait" | grep -q "already listening" && echo 0 || echo 1)"
check "the second session did not take over" "$(calls second | grep -q "take=1" && echo 1 || echo 0)"

# Stop the first, as a person interrupts it; a comment after that gets no answer.
echo "   stop"
listen_pid=${sessions[0]}
kill -INT -- "-$listen_pid" 2>/dev/null || :
sleep 10
kill -TERM -- "-$listen_pid" 2>/dev/null || :
person comment "$key" "@$handle and 4 and 4? Answer here in a comment." >/dev/null
sleep 90
check "after stop, the third comment got no answer" "$([ "$(answers "$key")" = $((base + 2)) ] && echo 0 || echo 1)" "$(answers "$key") answers"

echo "waits of the listening session (seconds, what came):"
grep " end listen status=[0-9]* [0-9]*s wait" "$work/calls.log" | awk '{for (i = 1; i < NF; i++) if ($i == "=>") { print "  " $5, $(i + 1); break }}' || :
echo "listening session: $(grep -c " start listen wait" "$work/calls.log" || :) waits, $(awk '$3=="listen"{if(!f)f=$1;l=$1}END{print l-f}' "$work/calls.log")s from its first call to its last"
echo "tokens, as the tool printed them:"
grep -ihE "tokens?[ _]?(used|usage)|\"(input|output)_tokens\"" "$work/connect.log" "$work/listen.log" "$work/second.log" | sed 's/^/  /' | head -n 20 || echo "  (the tool printed none)"
[ "$failed" = 0 ] && echo "all checks passed" || echo "some checks failed"
exit "$failed"
