#!/usr/bin/env bash
# Checks, with a real agent tool, that it connects to Quadit and listens from
# ordinary words. It spends the person's plan, so it is run by hand, never
# by CI:
#
#   make server && scripts/agent-listen-check.sh codex
#
# TOOL is codex, claude, agy, gemini or cursor-agent. On a throwaway server
# (its own port and data folder) it makes an agent with a login file of its
# own, gives the tool the skill of the quadit under test in the project it
# runs in (WORK/cwd), and runs four phases:
#
#   1. "Connect to Quadit CODE": the code is used, the agent is connected,
#      no wait was started.
#   2. "Listen to Quadit": the agent shows as listening, a stretch with
#      nothing arriving passes in a wait, two comments get exactly one
#      answer each, and a second session told to listen does not listen.
#   3. For a tool that wakes its agent for a background command (claude,
#      agy; AGENT_CHECK_WAKES says otherwise): a chat with a person, whose
#      question is answered while a wait is open, a comment still answered,
#      and told to stop, the agent stops listening.
#   4. A companion, as the desktop app runs one (`quadit listen by="the
#      check" --exec …` with the tool's one-prompt command): two comments
#      answered once each, a wait meanwhile refused, and stopped, the agent
#      stops showing as listening.
#
# Every quadit the tool runs is a wrapper (WORK/bin/quadit) on this check's
# login that logs each call (WORK/calls.log), and the check refuses to run
# while the tool's MCP settings name a Quadit server, which could reach the
# person's own (AGENT_CHECK_ALLOW_MCP=1 runs anyway).
#
# Settings: AGENT_CHECK_COMMAND (the one-prompt command, the prompt in "$1"),
# AGENT_CHECK_CHAT_COMMAND and AGENT_CHECK_CHAT_FORMAT (text or stream-json),
# AGENT_CHECK_STEER, AGENT_CHECK_IDLE (seconds, default 150),
# AGENT_CHECK_ANSWER (default 300), AGENT_CHECK_COMPANION=0, QUADIT_BIN.
# Ends with "N checks passed, M phases skipped: …" and exits 0 only when no
# check failed: a phase skipped is not a phase passed.

# Some functions are only called through others (the trap).
# shellcheck disable=SC2329
set -euo pipefail

tool=${1:?usage: scripts/agent-listen-check.sh codex|claude|agy|gemini|cursor-agent}
root=$(cd "$(dirname "$0")/.." && pwd)
real=$(cd "$root" && realpath "${QUADIT_BIN:-./bin/quadit}")
idle=${AGENT_CHECK_IDLE:-150}
answer_time=${AGENT_CHECK_ANSWER:-300}

# Nothing of the person's Quadit reaches this check.
# shellcheck source=scripts/agent-check-frame.sh
. "$root/scripts/agent-check-frame.sh"
forget_own_quadit

# The tool's one-prompt command; the prompt is "$1". Each line is the tool's documented one-prompt form
# (docs/agents.md) with the permission it needs to run the quadit command without asking: check it against
# the tool's version before a run, and set AGENT_CHECK_COMMAND to change it. They are expanded by the shell
# that runs them (run), not here.
# shellcheck disable=SC2016
case $tool in
codex) default_command='codex exec --skip-git-repo-check -s workspace-write -c sandbox_workspace_write.network_access=true -c "shell_environment_policy.set={QUADIT_CONFIG=\"$AGENT_CHECK_LOGIN\"}" "$1"' ;;
# The prompt comes before --allowedTools, which takes every word after it as a tool. Claude Code prefers a skill of
# the same name in the home folder to the project's (seen 2026-11-21: with an older quadit skill in ~/.claude/skills
# it followed that one), so it is told to load the project's settings and skills only, and no MCP server at all.
claude) default_command='claude -p "$1" --output-format json --setting-sources project,local --strict-mcp-config --allowedTools "Bash($AGENT_CHECK_WRAPPER:*)" "Bash(quadit:*)"' ;;
agy) default_command='agy -p "$1" --dangerously-skip-permissions' ;;
gemini) default_command='GEMINI_CLI_TRUST_WORKSPACE=true gemini -p "$1"' ;;
cursor-agent) default_command='cursor-agent -p --force "$1"' ;;
*) default_command="" ;;
esac
command=${AGENT_CHECK_COMMAND:-$default_command}

# Whether the tool wakes its agent for a background command, and how it is run as a chat with a person: a command
# that reads the person's messages from standard input, and the form each message is written in there.
# shellcheck disable=SC2016
case $tool in
claude)
	wakes=1 chat_format=stream-json
	default_chat='claude -p --input-format stream-json --output-format stream-json --verbose --setting-sources project,local --strict-mcp-config --allowedTools "Bash($AGENT_CHECK_WRAPPER:*)" "Bash(quadit:*)"'
	;;
agy) wakes=1 chat_format=text default_chat="" ;;
*) wakes=0 chat_format=text default_chat="" ;;
esac
wakes=${AGENT_CHECK_WAKES:-$wakes}
chat_command=${AGENT_CHECK_CHAT_COMMAND:-$default_chat}
chat_format=${AGENT_CHECK_CHAT_FORMAT:-$chat_format}
[ -n "$command" ] || { echo "no one-prompt command for $tool: set AGENT_CHECK_COMMAND" >&2; exit 2; }
[ -x "$real" ] || { echo "no quadit at $real: run make server, or set QUADIT_BIN" >&2; exit 2; }

refuse_quadit_mcp "$tool"

work=$(mktemp -d "${TMPDIR:-/tmp}/agent-listen-check.XXXXXX")
mkdir -p "$work/bin" "$work/cwd"
# The project the tool runs in, with the skill under test where the tools read a project's skills.
git -C "$work/cwd" init -q
"$real" skill install "$work/cwd/.agents/skills" "$work/cwd/.claude/skills" >"$work/skills.txt"
server="" sessions=()
cleanup() {
	for pid in "${sessions[@]}"; do kill -TERM -- "-$pid" 2>/dev/null || :; done
	[ -z "$server" ] || { kill "$server" 2>/dev/null || :; wait "$server" 2>/dev/null || :; }
	echo "logs: $work"
}
trap cleanup EXIT

failed=0 passes=0 skipped=()

# The server, on a free port, with a data folder of its own.
start_server "$real" "$work"

# The person, signed in by a cookie for the set-up and by a token after it.
jar=$work/jar
curl -sf -c "$jar" -H "Origin: $url" -H "Content-Type: application/json" -X POST "$url/api/v1/auth/setup" \
	-d '{"name":"Check Person","email":"person@example.com","password":"correct-horse-battery","workspace_name":"Check"}' >"$work/setup.json"
slug=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["workspace"]["slug"])' "$work/setup.json")
api() { curl -sf -b "$jar" -H "Origin: $url" -H "Content-Type: application/json" -X "$1" "$url/api/v1/w/$slug$2" ${3:+-d "$3"}; }
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
echo "\$start start \${AGENT_CHECK_SESSION:-?} pid=\$\$ \$*" >>"$work/calls.log"
"$real" "\$@" >"$work/out.\$\$" 2>&1
status=\$?
cat "$work/out.\$\$"
end=\$(date +%s)
echo "\$end end \${AGENT_CHECK_SESSION:-?} pid=\$\$ status=\$status \$((end - start))s \$* => \$(head -n 1 "$work/out.\$\$")" >>"$work/calls.log"
rm -f "$work/out.\$\$"
exit \$status
EOF
chmod +x "$wrapper"
touch "$work/calls.log"
steer=${AGENT_CHECK_STEER-"Use $wrapper for the quadit command."}

# as_tool SESSION COMMAND [ARG ...]: runs COMMAND as the tool is run, in WORK/cwd with this check's environment.
as_tool() {
	(
		cd "$work/cwd"
		export AGENT_CHECK_SESSION=$1 AGENT_CHECK_WRAPPER=$wrapper AGENT_CHECK_LOGIN=$work/agent-login.json QUADIT_URL=$url QUADIT_TOKEN=$agent_token PATH="$work/bin:$PATH"
		shift
		exec "$@"
	)
}
# run SESSION PROMPT: the tool's one prompt, its output in WORK/SESSION.log (in its own process group when run with &).
run() { as_tool "$1" sh -c "$command" sh "$2${steer:+ $steer}" >"$work/$1.log" 2>&1 </dev/null; }
# chat SESSION: the tool as a chat with a person, its messages read from WORK/chat.in, its output in WORK/SESSION.log.
chat() { as_tool "$1" sh -c "$chat_command" sh <"$work/chat.in" >"$work/$1.log" 2>&1; }
# tell TEXT: the person writes TEXT in the chat (to the tool's standard input, held open on descriptor 3).
tell() {
	case $chat_format in
	stream-json) python3 -c 'import json,sys;print(json.dumps({"type":"user","message":{"role":"user","content":sys.argv[1]}}))' "$1" >&3 ;;
	*) printf '%s\n' "$1" >&3 ;;
	esac
}
# open_wait SESSION: a wait of SESSION was started and has not ended.
open_wait() { python3 -c 'import sys
open_ = set()
for line in open(sys.argv[1]):
    f = line.split()
    if len(f) < 5 or f[2] != sys.argv[2]:
        continue
    if f[1] == "start" and f[4] == "wait":
        open_.add(f[3])
    elif f[1] == "end":
        open_.discard(f[3])
sys.exit(0 if open_ else 1)' "$work/calls.log" "$1"; }
# said_while_waiting SESSION OFFSET WORD: the tool's output since byte OFFSET holds WORD, and a wait is still open.
said_while_waiting() { tail -c "+$(($2 + 1))" "$work/$1.log" | grep -Eqw "$3" && open_wait "$1"; }
not_listening() { [ "$(agents)" = "connected not-listening" ]; }
calls() { grep " end $1 " "$work/calls.log" || :; }
started() { grep " start $1 " "$work/calls.log" || :; }
agents() { api GET /agents | python3 -c 'import json,sys
a=[a for a in json.load(sys.stdin)["agents"] if a["handle"]==sys.argv[1]][0]
print(("connected" if a.get("connected_at") else "not-connected")+" "+("listening" if a["listening"] else "not-listening"))' "@$handle"; }
# replies AFTER BEFORE [WORD ...]: how many comments the agent under test made on the task under test, on it or in a
# thread of it, after feed position AFTER and before BEFORE (0: no end); with WORDs, only those holding one of them
# as a word (the answer the question asks for).
replies() { person --json show "$key" | python3 -c 'import json,re,sys
who, after, before, words = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]) or 1 << 62, sys.argv[4:]
def answers(body):
    return not words or any(re.search(r"\b" + re.escape(w) + r"\b", body, re.I) for w in words)
print(sum(c["by"] == who and after < c["seq"] < before and answers(c.get("body", "")) for c in json.load(sys.stdin).get("comments") or []))' "@$handle" "$@"; }
# say TEXT: the person comments on the task; prints the comment's feed position.
say() { person --json comment "$key" "$1" | field seq; }
# held_through FROM TO: a wait of the listening session ended IDLE between FROM and TO, or was held all through.
held_through() { python3 -c 'import sys
t0, t1 = int(sys.argv[2]), int(sys.argv[3])
starts, ends = {}, {}
for line in open(sys.argv[1]):
    f = line.split()
    if len(f) < 5 or f[2] != "listen" or " wait" not in line:
        continue
    pid = f[3]
    if f[1] == "start":
        starts[pid] = int(f[0])
    elif f[1] == "end":
        ends[pid] = (int(f[0]), line.rstrip().endswith("=> IDLE"))
idle = any(idle and t0 <= at <= t1 for at, idle in ends.values())
held = any(at <= t0 and (pid not in ends or ends[pid][0] >= t1) for pid, at in starts.items())
sys.exit(0 if idle or held else 1)' "$work/calls.log" "$1" "$2"; }
listens() { [ "$(agents)" = "connected listening" ]; }
answered() { [ "$(replies "$@")" -ge 1 ]; }

echo "tool: $tool"
case $tool in codex | claude | agy | gemini | cursor-agent) echo "version: $("$tool" --version 2>&1 | head -n 1)" ;; esac
echo "server: $url (workspace $slug), agent @$handle"

# 1. Connect.
echo "1. Connect to Quadit"
api POST /connect-codes "{\"agent\":\"@$handle\",\"tool\":\"$tool\"}" >"$work/code.json"
code=$(field code <"$work/code.json")
code_id=$(field id <"$work/code.json")
run connect "Connect to Quadit $code" || :
check "the code was given back and used" "$([ "$(api GET "/connect-codes/$code_id" | field used)" = True ] && echo 0 || echo 1)" \
	"the tool did not follow the new skill (the code was not used); it may have read an older skill from the home folder"
check "quadit connect $code ran and succeeded" "$(calls connect | grep -E " status=0 .* connect " | grep -q "$code" && echo 0 || echo 1)" \
	"the tool did not follow the new skill (no quadit connect $code that succeeded); it may have read an older skill from the home folder"
check "the agent is connected" "$([ "$(agents)" = "connected not-listening" ] && echo 0 || echo 1)" "$(agents)"
check "no wait was started" "$(started connect | grep -Eq "pid=[0-9]+ (wait|listen)( |$)" && echo 1 || echo 0)"

# 2. Listen.
echo "2. Listen to Quadit"
key=$(person --json new GS "Say what 2 and 2 make" "assignee=@$handle" | field key)
set -m
run listen "Listen to Quadit" &
sessions+=($!)
set +m
check "the agent shows as listening" "$(passed until_true 180 listens)" "$(agents)"
check "the agent listens with quadit wait" "$(started listen | grep -Eq "pid=[0-9]+ wait( |$)" && echo 0 || echo 1)" \
	"the tool did not follow the new skill (no quadit wait seen); it may have read an older skill from the home folder"
# The assignment is the first item: it is handled (or not) before the stretch with nothing arriving.
sleep 30
idle_from=$(date +%s)
sleep "$idle"
idle_to=$(date +%s)
check "a stretch with nothing arriving passed in a wait" "$(passed held_through "$idle_from" "$idle_to")"
first=$(say "@$handle what do 2 and 2 make? Answer here in a comment.")
check "the first comment was answered" "$(passed until_true "$answer_time" answered "$first" 0 4 four)" "$(replies "$first" 0) answers after it"
second=$(say "@$handle and 3 and 3? Answer here in a comment.")
check "the second comment was answered" "$(passed until_true "$answer_time" answered "$second" 0 6 six)" "$(replies "$second" 0) answers after it"
sleep 30
check "the first comment got exactly one answer, saying 4" "$([ "$(replies "$first" "$second")" = 1 ] && [ "$(replies "$first" "$second" 4 four)" = 1 ] && echo 0 || echo 1)" \
	"$(replies "$first" "$second") comments by @$handle between it and the second"
check "the second comment got exactly one answer, saying 6" "$([ "$(replies "$second" 0)" = 1 ] && [ "$(replies "$second" 0 6 six)" = 1 ] && echo 0 || echo 1)" \
	"$(replies "$second" 0) comments by @$handle after it"

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
# It learns that from quadit listening, as the skill has it ask first, or from a wait the server refuses.
check "the second session found the agent already listening" "$(calls second | grep -Eq "listening => Something already listens as you|s wait.*already listening from another session" && echo 0 || echo 1)"
check "the second session held no wait" "$(calls second | grep -Eq "status=0 [0-9]+s wait" && echo 1 || echo 0)"
check "the second session did not take over" "$(calls second | grep -q "take=1" && echo 1 || echo 0)"

# Stop the first, as a person interrupts it.
listen_pid=${sessions[0]}
kill -INT -- "-$listen_pid" 2>/dev/null || :
sleep 10
kill -TERM -- "-$listen_pid" 2>/dev/null || :
# A tool may leave the wait it put in the background running when it is stopped (Antigravity CLI does): end it here,
# as the next item would, and say so.
sleep 2
left=$(awk '$3 == "listen" && $2 == "start" && $5 == "wait" { open[$4] = 1 } $3 == "listen" && $2 == "end" { delete open[$4] } END { for (p in open) print substr(p, 5) }' "$work/calls.log")
for pid in $left; do pkill -TERM -P "$pid" 2>/dev/null || :; done
[ -z "$left" ] || echo "   note: stopped, the tool left its background wait running; the check ended it"

# A companion, as the desktop app runs one: listen as the agent's login (through the wrapper, so its lease file is the
# check's own), each item a run of the tool's one-prompt command with the wake sentence (WORK/bin/wake, which keeps
# each run's length and output in WORK/runs).
companion() {
	cat >"$work/bin/wake" <<EOF
#!/bin/sh
# One run of the tool for one inbox item, as the desktop app makes it.
n=\$(ls "$work/runs" | wc -l | tr -d ' ')
start=\$(date +%s)
sh -c "\$AGENT_CHECK_ONE_PROMPT" sh "Quadit woke you for this inbox item:
\$QUADIT_ITEM
Handle it with the quadit skill: answer where you were asked, and write nothing when it asks nothing of you.${steer:+ $steer}" >"$work/runs/\$n.log" 2>&1
status=\$?
echo "run \$n: \$((\$(date +%s) - start))s, exit \$status" >>"$work/runs.txt"
exit \$status
EOF
	chmod +x "$work/bin/wake"
	mkdir -p "$work/runs"
	AGENT_CHECK_ONE_PROMPT=$command as_tool companion "$wrapper" listen "by=the check" --exec "$work/bin/wake" >"$work/companion.log" 2>&1
}
# as_agent ARGS: quadit as the agent, outside any tool, with this check's login.
as_agent() { QUADIT_URL=$url QUADIT_TOKEN=$agent_token QUADIT_CONFIG=$work/none.json "$real" "$@"; }
names_the_check() { as_agent listening | grep -q "the check"; }

# 3. Listen in a chat, the wait in the background.
if [ "$wakes" = 1 ]; then
	echo "3. Listen to Quadit in a chat with a person"
	if [ -z "$chat_command" ]; then
		skip "3 (a chat)" "no chat command is known for $tool: set AGENT_CHECK_CHAT_COMMAND (and AGENT_CHECK_CHAT_FORMAT) to run it"
	else
		# The stopped session's lease goes first: ninety seconds after its last request.
		check "the stopped session's lease ended" "$(passed until_true 180 not_listening)" "$(agents)"
		mkfifo "$work/chat.in"
		set -m
		chat chat &
		chat_pid=$!
		sessions+=("$chat_pid")
		set +m
		exec 3>"$work/chat.in"
		tell "I am the person you work for, here in this chat, and I will write to you again while you work. Listen to Quadit.${steer:+ $steer}"
		check "a wait was started" "$(passed until_true 180 open_wait chat)"
		offset=$(wc -c <"$work/chat.log")
		tell "While you listen: what is 7 times 6? Answer me here, in this chat."
		check "the person's question was answered while the wait ran in the background" "$(passed until_true "$answer_time" said_while_waiting chat "$offset" "42|forty-two")" \
			"no answer while a wait ran: the wait was not in the background, or the question was not answered"
		fifth=$(say "@$handle what do 5 and 5 make? Answer here in a comment.")
		check "a comment was still answered" "$(passed until_true "$answer_time" answered "$fifth" 0 10 ten)" "$(replies "$fifth" 0) answers after it"
		tell "Stop listening."
		check "told to stop, it stopped listening" "$(passed until_true 180 not_listening)" "$(agents)"
		exec 3>&-
		kill -TERM -- "-$chat_pid" 2>/dev/null || :
	fi
else
	echo "3. Listen to Quadit in a chat with a person"
	skip "3 (a chat)" "$tool is not known to wake its agent for a command it left running: set AGENT_CHECK_WAKES=1 to run it"
fi

# 4. A companion, as the desktop app keeps one.
echo "4. A companion, as the Quadit app runs one"
if [ "${AGENT_CHECK_COMPANION:-1}" != 1 ]; then
	skip "4 (a companion)" "AGENT_CHECK_COMPANION=0"
else
	check "the sessions before have stopped listening" "$(passed until_true 180 not_listening)" "$(agents)"
	set -m
	companion &
	companion_pid=$!
	sessions+=("$companion_pid")
	set +m
	check "the agent shows as listening, and quadit listening names the check" "$(passed until_true 60 names_the_check)" "$(as_agent listening 2>&1)"
	sixth=$(say "@$handle what do 2 and 2 make? Answer here in a comment.")
	check "the first comment was answered" "$(passed until_true "$answer_time" answered "$sixth" 0 4 four)" "$(replies "$sixth" 0) answers after it"
	seventh=$(say "@$handle and 3 and 3? Answer here in a comment.")
	check "the second comment was answered" "$(passed until_true "$answer_time" answered "$seventh" 0 6 six)" "$(replies "$seventh" 0) answers after it"
	refused=$(as_agent wait for=1 2>&1 || :)
	check "a wait meanwhile is refused, naming the check" "$(printf '%s' "$refused" | grep -q "already listening from another session (the check" && echo 0 || echo 1)" "$refused"
	sleep 30
	check "the first comment got exactly one answer, saying 4" "$([ "$(replies "$sixth" "$seventh")" = 1 ] && [ "$(replies "$sixth" "$seventh" 4 four)" = 1 ] && echo 0 || echo 1)" \
		"$(replies "$sixth" "$seventh") comments by @$handle between it and the second"
	check "the second comment got exactly one answer, saying 6" "$([ "$(replies "$seventh" 0)" = 1 ] && [ "$(replies "$seventh" 0 6 six)" = 1 ] && echo 0 || echo 1)" \
		"$(replies "$seventh" 0) comments by @$handle after it"
	kill -INT -- "-$companion_pid" 2>/dev/null || :
	sleep 5
	kill -TERM -- "-$companion_pid" 2>/dev/null || :
	check "stopped, the companion stops listening" "$(passed until_true 180 not_listening)" "$(agents)"
	echo "the companion's runs (one for each item, its assignment included):"
	sed 's/^/  /' "$work/runs.txt" 2>/dev/null || echo "  (none)"
	for run in "$work"/runs/*.log; do
		[ -f "$run" ] || continue
		tokens=$(grep -ihE "tokens?[ _]?(used|usage)|\"(input|output)_tokens\"" "$run" | head -n 3 | tr '\n' ' ' || :)
		echo "  $(basename "$run" .log): ${tokens:-tokens not reported}"
	done
fi

echo "waits of the listening session (seconds, what came):"
grep -E " end listen pid=[0-9]+ status=[0-9]+ [0-9]+s wait" "$work/calls.log" | awk '{for (i = 1; i < NF; i++) if ($i == "=>") { print "  " $6, $(i + 1); break }}' || :
echo "listening session: $(grep -cE " start listen pid=[0-9]+ wait( |$)" "$work/calls.log" || :) waits, $(awk '$3=="listen"{if(!f)f=$1;l=$1}END{print l-f}' "$work/calls.log")s from its first call to its last"
echo "the skill the tool was given (the tested quadit's own, sha256 $("$real" skill | shasum -a 256 | cut -c 1-12)):"
sed -n 's/^installed //p' "$work/skills.txt" | while read -r file; do echo "  $file  sha256 $(shasum -a 256 "$file" | cut -c 1-12)"; done
echo "tokens, as the tool printed them:"
grep -ihE "tokens?[ _]?(used|usage)|\"(input|output)_tokens\"" "$work/connect.log" "$work/listen.log" "$work/second.log" | sed 's/^/  /' | head -n 20 || echo "  (the tool printed none)"
summary="$passes checks passed, ${#skipped[@]} phases skipped${skipped[*]:+: ${skipped[*]}}"
if [ "$failed" = 0 ]; then echo "$summary"; else echo "some checks failed; $summary"; fi
exit "$failed"
