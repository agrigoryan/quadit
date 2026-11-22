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
#   2. "Listen to Quadit", left running: the agent shows as listening, a
#      stretch with nothing arriving passes in a wait, two comments on its
#      task get exactly one answer each, as itself, after each; a second
#      session told to listen is refused; after the first is stopped, a
#      third comment gets no answer.
#   3. Only for a tool that can be woken by a background command (claude
#      and agy; AGENT_CHECK_WAKES=1 or 0 says otherwise): a chat with a
#      person. The tool is run with the person's messages on its standard
#      input, one at a time (AGENT_CHECK_CHAT_COMMAND, AGENT_CHECK_CHAT_FORMAT
#      text or stream-json), told the person is there and will write again,
#      and asked to listen. It passes when a wait was started and is still
#      running while the tool answers the person's next question (so it runs
#      in the background), a comment is still answered, and told to stop the
#      agent stops listening (its lease goes within thirty seconds).
#      Unproven until the lead runs it: that the tool's one-prompt mode
#      reads a second message from standard input while a command runs in
#      the background (Claude Code's stream-json input is meant to; no
#      chat command is known for Antigravity CLI yet: set one), and that the
#      tool, so run, takes the chat for a person's.
#
# It prints the tool's version, each wait's length, the tokens the tool
# spent over the stretch with nothing arriving when it reports them as it
# goes (else "not reported"), and the folder that keeps every log.
#
# The tool is kept from the person's own Quadit as far as a script can:
#   - every quadit it runs is a wrapper (WORK/bin/quadit, first on PATH, so
#     a bare `quadit` is the wrapper too, and named in each prompt) that
#     drops QUADIT_URL and QUADIT_TOKEN and points QUADIT_CONFIG at this
#     check's login file, whatever the tool's settings set; for Codex,
#     whose settings can set QUADIT_CONFIG for every command and which
#     strips variables named like a token, the default command also sets
#     QUADIT_CONFIG through Codex's own -c;
#   - before a run it reads the tool's known MCP settings and refuses to run
#     while any MCP entry there mentions Quadit, in its name, its address or
#     its command, in any case: one could be used instead of the command
#     (AGENT_CHECK_ALLOW_MCP=1 runs anyway). It prints only the entry's name.
# What a script cannot prove: that the tool has no other way to the
# person's server (an MCP entry in a file this does not know of, or one that
# reaches Quadit by an address that does not name it, a plugin, a path to
# another quadit written somewhere it reads), or that the agent did not
# reach it with a command of its own making. The wrapper logs each call
# it gets (WORK/calls.log, with when it started and ended): calls made
# around it are not seen.
#
# The tool is given the skill of the quadit under test, never whatever older
# one the person's home folder holds, and the home folder is not written:
# the skill goes into the folder the tool runs in (WORK/cwd, made a git
# repository so it is a project root), at the project-level places the tools
# read, .agents/skills/quadit and .claude/skills/quadit. Project skills win
# over the user's in the tools that say how they rank them; elsewhere both
# may be loaded. So the verdict asks for proof that the new skill was
# followed: `quadit connect CODE` and `quadit wait` in the call log, neither
# of which an older skill knows.
#
# What the tools' documentation says about reading these (looked up
# 2026-11-21, not tried here; check a tool's version before a run):
#   codex          .agents/skills in every folder from the working one up to
#                  the repository root (developers.openai.com/codex/skills).
#   claude         .claude/skills in the starting folder and its parents up
#                  to the repository root (code.claude.com/docs/en/skills);
#                  nothing says whether `claude -p` differs.
#   agy            <workspace root>/.agents/skills and its parents up to the
#                  repository root (antigravity.google/docs/skills).
#   gemini         .agents/skills (or .gemini/skills) of the current folder,
#                  ranked above the user's (geminicli.com/docs/cli/skills);
#                  run headless in a folder it does not trust it stops or
#                  restricts itself, so the command below trusts this one
#                  (GEMINI_CLI_TRUST_WORKSPACE; sources disagree on the name).
#   cursor-agent   .agents/skills or .cursor/skills anywhere in the
#                  repository (cursor.com/docs/skills); a forum report, still
#                  open, says headless runs (-p) may not load project skills.
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
#   AGENT_CHECK_ALLOW_MCP=1  run although the tool has a quadit MCP server
#   QUADIT_BIN           the quadit to test (default ./bin/quadit)
#
# Needs bash, curl, python3, git and shasum. Exits 0 when every check passed.

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

# The tool's known MCP settings, and their kind.
mcp_settings() {
	case $tool in
	claude) printf '%s\n' "$HOME/.claude.json json" "$HOME/.claude/settings.json json" ;;
	codex) printf '%s\n' "$HOME/.codex/config.toml toml" ;;
	gemini) printf '%s\n' "$HOME/.gemini/settings.json json" ;;
	agy) printf '%s\n' "$HOME/.gemini/config/mcp_config.json json" ;;
	cursor-agent) printf '%s\n' "$HOME/.cursor/mcp.json json" ;;
	esac
}
# quadit_mcp FILE KIND: the names of the MCP entries of a settings file that mention Quadit anywhere (name, address,
# command, arguments), in any case; MCP entries are those under any key named mcpServers, mcp_servers or mcp.
quadit_mcp() { python3 -c 'import json,sys,tomllib
path, kind = sys.argv[1], sys.argv[2]
with open(path, "rb") as f:
    text = f.read()
# A settings file that is there but empty names no MCP server.
doc = {} if not text.strip() else tomllib.loads(text.decode()) if kind == "toml" else json.loads(text)
found = []
def walk(v):
    if isinstance(v, dict):
        for k, entries in v.items():
            if k in ("mcpServers", "mcp_servers", "mcp") and isinstance(entries, dict):
                for name, entry in entries.items():
                    if "quadit" in (name + json.dumps(entry, default=str)).lower():
                        found.append(name)
            walk(entries)
    elif isinstance(v, list):
        for item in v:
            walk(item)
walk(doc)
print(" ".join(sorted(set(found))))' "$1" "$2"; }
if [ "${AGENT_CHECK_ALLOW_MCP:-}" != 1 ]; then
	while read -r file kind; do
		[ -n "$file" ] && [ -f "$file" ] || continue
		names=$(quadit_mcp "$file" "$kind") || { echo "$file could not be read to look for a Quadit MCP server; run with AGENT_CHECK_ALLOW_MCP=1 to go on anyway." >&2; exit 2; }
		if [ -n "$names" ]; then
			echo "$tool has an MCP server that mentions Quadit in $file ($names), which it could use instead of the quadit command, and so reach your own Quadit." >&2
			echo "Turn it off for this check, or run with AGENT_CHECK_ALLOW_MCP=1 if you know it cannot reach it." >&2
			exit 2
		fi
	done < <(mcp_settings)
fi

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
run() { as_tool "$1" sh -c "$command" sh "$2${steer:+ $steer}" >"$work/$1.log" 2>&1; }
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
# tokens_now: the last running total of tokens the tool printed in the listening session's log, or nothing.
tokens_now() { python3 -c 'import re,sys
total = ""
for line in open(sys.argv[1], errors="replace"):
    m = re.search(r"(?i)(total[_ ]?tokens|tokens[ _]used)\W*([0-9][0-9,]*)", line)
    if m:
        total = m.group(2).replace(",", "")
print(total)' "$work/listen.log"; }
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
until_true() { # until_true SECONDS COMMAND...: polls once a second
	local end=$((SECONDS + $1)); shift
	until "$@"; do [ "$SECONDS" -lt "$end" ] || return 1; sleep 1; done
}
listens() { [ "$(agents)" = "connected listening" ]; }
answered() { [ "$(replies "$@")" -ge 1 ]; }
passed() { if "$@"; then echo 0; else echo 1; fi; }

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
idle_from=$(date +%s) tokens_from=$(tokens_now)
sleep "$idle"
idle_to=$(date +%s) tokens_to=$(tokens_now)
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
check "the second session was refused" "$(calls second | grep -E "pid=[0-9]+ status=[0-9]+ [0-9]+s wait" | grep -q "already listening" && echo 0 || echo 1)"
check "the second session did not take over" "$(calls second | grep -q "take=1" && echo 1 || echo 0)"

# Stop the first, as a person interrupts it; a comment after that gets no answer.
echo "   stop"
listen_pid=${sessions[0]}
kill -INT -- "-$listen_pid" 2>/dev/null || :
sleep 10
kill -TERM -- "-$listen_pid" 2>/dev/null || :
third=$(say "@$handle and 4 and 4? Answer here in a comment.")
sleep 90
check "after stop, the third comment got no answer" "$([ "$(replies "$third" 0)" = 0 ] && echo 0 || echo 1)" "$(replies "$third" 0) answers"

# 3. Listen in a chat, the wait in the background.
if [ "$wakes" = 1 ]; then
	echo "3. Listen to Quadit in a chat with a person"
	if [ -z "$chat_command" ]; then
		echo "  SKIP  no chat command is known for $tool: set AGENT_CHECK_CHAT_COMMAND (and AGENT_CHECK_CHAT_FORMAT) to run it"
	else
		# The stopped session's lease goes first: thirty seconds after a wait given up on, five minutes at most.
		check "the stopped session's lease ended" "$(passed until_true 360 not_listening)" "$(agents)"
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
		check "told to stop, it stopped listening" "$(passed until_true 90 not_listening)" "$(agents)"
		exec 3>&-
		kill -TERM -- "-$chat_pid" 2>/dev/null || :
	fi
fi

echo "waits of the listening session (seconds, what came):"
grep -E " end listen pid=[0-9]+ status=[0-9]+ [0-9]+s wait" "$work/calls.log" | awk '{for (i = 1; i < NF; i++) if ($i == "=>") { print "  " $6, $(i + 1); break }}' || :
echo "listening session: $(grep -cE " start listen pid=[0-9]+ wait( |$)" "$work/calls.log" || :) waits, $(awk '$3=="listen"{if(!f)f=$1;l=$1}END{print l-f}' "$work/calls.log")s from its first call to its last"
echo "the skill the tool was given (the tested quadit's own, sha256 $("$real" skill | shasum -a 256 | cut -c 1-12)):"
sed -n 's/^installed //p' "$work/skills.txt" | while read -r file; do echo "  $file  sha256 $(shasum -a 256 "$file" | cut -c 1-12)"; done
if [ -n "$tokens_from" ] && [ -n "$tokens_to" ] && [ "$tokens_to" -ge "$tokens_from" ]; then
	spent=$((tokens_to - tokens_from)) seconds=$((idle_to - idle_from))
	echo "idle cost: $spent tokens over ${seconds}s with nothing arriving, about $((spent * 3600 / seconds)) an hour"
else
	echo "idle cost: not reported (the tool printed no running total of tokens while it listened)"
fi
echo "tokens, as the tool printed them:"
grep -ihE "tokens?[ _]?(used|usage)|\"(input|output)_tokens\"" "$work/connect.log" "$work/listen.log" "$work/second.log" | sed 's/^/  /' | head -n 20 || echo "  (the tool printed none)"
[ "$failed" = 0 ] && echo "all checks passed" || echo "some checks failed"
exit "$failed"
