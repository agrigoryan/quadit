#!/usr/bin/env bash
# Checks, with a real agent tool following the real skill, that one tool works
# in two workspaces at once, each chat in its own. It spends the person's
# plan, so it is run by hand, never by CI:
#
#   make server && scripts/agent-workspaces-check.sh claude
#
# TOOL is claude or codex. On a throwaway server (its own port and data
# folder) it makes two workspaces, Games and Acme, each with a project SVA
# whose SVA-12 has a title of its own, and an agent of the same handle in
# each; connects the tool to both with `quadit login` (two login files and
# index.json, in a folder QUADIT_CONFIG names) and ties a folder to each with
# `quadit use NAME project=SVA`. Then:
#
#   1. A chat in a folder tied to none, told "Check Quadit": it asks which
#      workspace (or refuses), and does nothing in either.
#   2. Two chats listen at once, one in each tied folder, told "Listen to
#      Quadit": each listens to SVA in its own workspace. When they do not,
#      the phases after are skipped.
#   3. A comment for the agent on each SVA-12: each answered once, in its own
#      workspace, every call of each chat in its own folder and workspace.
#   4. `quadit logout --workspace=<Acme>` while both listen: the Acme chat
#      stops, saying why (when its wait outlasts two minutes, a comment in
#      Acme ends the wait sooner); the Games chat goes on and answers a third
#      comment.
#   5. Acme connected again, a companion (`quadit listen --workspace=<Acme>
#      --exec …` with the tool's one-prompt command, as the skill gives it)
#      answers in Acme while the Games chat answers in Games.
#
# Each chat is the tool's one-prompt run (case 1 of the skill's Listening).
# Nothing of the person's own Quadit is in reach: every QUADIT_* is unset;
# every quadit the tool runs is a wrapper (WORK/bin/quadit) that uses this
# check's login folder whatever the tool's settings say, and logs each call
# with the folder it ran in (WORK/calls.log); the tool runs without the
# person's settings that set QUADIT_CONFIG (Claude Code without the user's
# settings, with --settings setting it to this check's; Codex with
# --ignore-user-config, keeping only the model and reasoning effort of
# ~/.codex/config.toml), saves no session, may run only the wrapper (Claude
# Code), and the check refuses to run while the tool's MCP settings name a
# Quadit server. At the end it checks the tools' transcripts for a quadit run
# outside the wrapper and for the person's own server (port 4780), whose
# connections it watched meanwhile (lsof), and that its login folder is the
# only one any call used.
#
# The tied folders are under the home folder (~/.quadit-workspaces-check.*:
# the folder rules refuse $TMPDIR and /tmp), moved to the Trash at the end.
# Settings: AGENT_CHECK_COMMAND (the one-prompt command, the prompt in "$1"),
# AGENT_CHECK_STEER (words after every prompt), AGENT_CHECK_LISTEN (words
# after "Listen to Quadit." alone, such as what the chat would otherwise ask
# first), AGENT_CHECK_ANSWER (seconds, default 300), QUADIT_BIN.
# Ends with "N checks passed, M phases skipped: …" and exits 0 only when no
# check failed: a phase skipped is not a phase passed.

# Some functions are only called through others (the trap), and each workspace's values are read through of.
# shellcheck disable=SC2329,SC2034
set -euo pipefail

tool=${1:?usage: scripts/agent-workspaces-check.sh claude|codex}
root=$(cd "$(dirname "$0")/.." && pwd)
real=$(cd "$root" && realpath "${QUADIT_BIN:-./bin/quadit}")
answer_time=${AGENT_CHECK_ANSWER:-300}

# Nothing of the person's Quadit reaches this check.
# shellcheck source=scripts/agent-check-frame.sh
. "$root/scripts/agent-check-frame.sh"
forget_own_quadit

# The tool's one-prompt command; the prompt is "$1". Each is the tool's documented one-prompt form (docs/agents.md)
# with the permission it needs to run the quadit command without asking, and without the person's settings that
# point QUADIT_CONFIG at their own login. They are expanded by the shell that runs them (run), not here.
# shellcheck disable=SC2016
case $tool in
# The prompt comes before --allowedTools, which takes every word after it as a tool. Claude Code prefers a skill of
# the same name in the home folder to the project's, so it loads the project's settings and skills only.
claude) default_command='claude -p "$1" --output-format stream-json --verbose --no-session-persistence --setting-sources project,local --strict-mcp-config --settings "$AGENT_CHECK_SETTINGS" --allowedTools "Bash($AGENT_CHECK_WRAPPER:*)"' ;;
codex) default_command='codex exec --json --ephemeral --ignore-user-config --skip-git-repo-check -s workspace-write -c sandbox_workspace_write.network_access=true -c "shell_environment_policy.set={QUADIT_CONFIG=\"$AGENT_CHECK_LOGIN\"}" ${AGENT_CHECK_MODEL:+-c "model=\"$AGENT_CHECK_MODEL\""} ${AGENT_CHECK_EFFORT:+-c "model_reasoning_effort=\"$AGENT_CHECK_EFFORT\""} "$1"' ;;
*)
	echo "usage: scripts/agent-workspaces-check.sh claude|codex" >&2
	exit 2
	;;
esac
command=${AGENT_CHECK_COMMAND:-$default_command}
[ -x "$real" ] || { echo "no quadit at $real: run make server, or set QUADIT_BIN" >&2; exit 2; }
refuse_quadit_mcp "$tool"
# Codex without the person's config.toml still thinks with their model.
model="" effort=""
if [ "$tool" = codex ] && [ -f "$HOME/.codex/config.toml" ]; then
	read -r model effort < <(python3 -c 'import sys,tomllib
d = tomllib.load(open(sys.argv[1], "rb"))
print(d.get("model") or "", d.get("model_reasoning_effort") or "")' "$HOME/.codex/config.toml")
fi

work=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/agent-workspaces-check.XXXXXX")" && pwd -P)
folders=$(mktemp -d "$HOME/.quadit-workspaces-check.XXXXXX")
mkdir -p "$work/bin" "$work/config" "$work/out" "$work/runs"
base=$work/config/$tool.json
server="" sessions=() watcher=""
cleanup() {
	for pid in "${sessions[@]}"; do kill -TERM -- "-$pid" 2>/dev/null || :; done
	# A tool may leave a quadit it started running when it is stopped: end each wrapper call that never ended.
	sleep 1
	for pid in $(unended); do
		pkill -TERM -P "$pid" 2>/dev/null || :
		kill -TERM "$pid" 2>/dev/null || :
	done
	[ -z "$watcher" ] || kill "$watcher" 2>/dev/null || :
	[ -z "$server" ] || { kill "$server" 2>/dev/null || :; wait "$server" 2>/dev/null || :; }
	sleep 1
	left=$(pgrep -fl -- "$work" || :)
	[ -z "$left" ] || printf 'still running, of this check:\n%s\n' "$left"
	trash "$folders" 2>/dev/null || echo "the tied folders are left at $folders"
	echo "logs: $work"
}
trap cleanup EXIT

failed=0 passes=0 skipped=()

# The person's own server, asked only what it is (read-only): it is there to be missed.
own=$(curl -s --max-time 2 http://127.0.0.1:4780/api/v1/version || :)
# Who among this check's processes holds a connection to it, sampled every second all through.
watch_own() {
	while :; do
		for pid in $(lsof -nP -iTCP:4780 -sTCP:ESTABLISHED -t 2>/dev/null || :); do
			p=$pid
			while [ -n "$p" ] && [ "$p" -gt 1 ]; do
				if [ "$p" = "$$" ]; then
					echo "$(date +%s) $(ps -o pid=,command= -p "$pid")" >>"$work/own-server.txt"
					break
				fi
				p=$(ps -o ppid= -p "$p" | tr -d ' ')
			done
		done
		sleep 1
	done
}
touch "$work/own-server.txt"
watch_own &
watcher=$!

start_server "$real" "$work"

# The person, signed in by a cookie, owns both workspaces.
jar=$work/jar
curl -sf -c "$jar" -H "Origin: $url" -H "Content-Type: application/json" -X POST "$url/api/v1/auth/setup" \
	-d '{"name":"Check Person","email":"person@example.com","password":"correct-horse-battery","workspace_name":"Games"}' >"$work/setup.json"
curl -sf -b "$jar" -H "Origin: $url" -H "Content-Type: application/json" -X POST "$url/api/v1/workspaces" \
	-d '{"name":"Acme","slug":"acme"}' >"$work/acme.json"
# Each workspace's values are WS_NAME (games_id, acme_folder…), read with of.
games_id=$(field workspace.id <"$work/setup.json")
games_slug=$(field workspace.slug <"$work/setup.json")
acme_id=$(field id <"$work/acme.json")
acme_slug=$(field slug <"$work/acme.json")
games_name=Games acme_name=Acme
games_title="The boss needs a second phase" acme_title="The header overlaps the menu"
# of WS NAME: that variable of the workspace (games or acme).
of() {
	local v=${1}_$2
	printf '%s' "${!v}"
}
api() { curl -sf -b "$jar" -H "Origin: $url" -H "Content-Type: application/json" -X "$2" "$url/api/v1/w/$(of "$1" slug)$3" ${4:+-d "$4"}; }
agent_api() { curl -sf -H "Authorization: Bearer $(of "$1" token)" "$url/api/v1/w/$(of "$1" slug)$2"; }
person() {
	local ws=$1
	shift
	QUADIT_URL=$url QUADIT_TOKEN=$(of "$ws" person) QUADIT_CONFIG=$work/none.json "$real" "$@"
}

# In each: the project, eleven tasks and SVA-12, the agent, and its login, the second beside the first.
handle="$tool-check"
for ws in games acme; do
	printf -v "${ws}_person" '%s' "$(api "$ws" POST /tokens '{"user":"me","name":"check"}' | field token)"
	person "$ws" "do" project.create '{"key":"SVA","name":"Samurai vs Aliens"}' >/dev/null
	for n in $(seq 11); do person "$ws" new SVA "$(of "$ws" name) task $n" >/dev/null; done
	[ "$(person "$ws" --json new SVA "$(of "$ws" title)" | field key)" = SVA-12 ] || { echo "SVA-12 was not made in $ws" >&2; exit 1; }
	person "$ws" "do" agent.create "{\"name\":\"$tool\",\"handle\":\"$handle\"}" >/dev/null
	printf -v "${ws}_token" '%s' "$(api "$ws" POST /tokens "{\"user\":\"@$handle\",\"name\":\"check\"}" | field token)"
	of "$ws" token | QUADIT_CONFIG=$base "$real" login "$url" - >>"$work/login.txt"
done

# The folders the chats run in, the skill under test in each, two of them tied.
for dir in games acme untied; do
	mkdir "$folders/$dir"
	git -C "$folders/$dir" init -q
	"$real" skill install "$folders/$dir/.agents/skills" "$folders/$dir/.claude/skills" >>"$work/skills.txt"
done
games_folder=$(cd "$folders/games" && pwd -P) acme_folder=$(cd "$folders/acme" && pwd -P) untied_folder=$(cd "$folders/untied" && pwd -P)
for ws in games acme; do QUADIT_CONFIG=$base "$real" use "$ws" project=SVA "folder=$(of "$ws" folder)" >>"$work/login.txt"; done

# The quadit the tool is told to run.
wrapper=$work/bin/quadit
cat >"$wrapper" <<EOF
#!/bin/sh
# This check's own logins, whatever the tool's settings set; each call logged, tab-separated, with the folder it ran
# in, the workspace the environment names and the login file used; its output kept in WORK/out.
unset QUADIT_URL QUADIT_TOKEN
case \${QUADIT_CONFIG:-} in "$work/config/"*) ;; *) export QUADIT_CONFIG="$base" ;; esac
args=\$(printf '%s' "\$*" | tr '\t\n' '  ')
out="$work/out/\${AGENT_CHECK_SESSION:-x}.\$\$"
start=\$(date +%s)
printf '%s\tstart\t%s\t%s\t%s\t%s\t%s\t%s\n' "\$start" "\${AGENT_CHECK_SESSION:-?}" "\$\$" "\$(pwd -P)" "\${QUADIT_WORKSPACE:--}" "\$QUADIT_CONFIG" "\$args" >>"$work/calls.log"
"$real" "\$@" >"\$out" 2>&1
status=\$?
cat "\$out"
end=\$(date +%s)
printf '%s\tend\t%s\t%s\t%s\t%s\t%s\tstatus=%s\t%ss\t%s\t%s\n' "\$end" "\${AGENT_CHECK_SESSION:-?}" "\$\$" "\$(pwd -P)" "\${QUADIT_WORKSPACE:--}" "\$QUADIT_CONFIG" "\$status" "\$((end - start))" "\$args" "\$(head -n 1 "\$out")" >>"$work/calls.log"
exit \$status
EOF
chmod +x "$wrapper"
touch "$work/calls.log"
steer=${AGENT_CHECK_STEER-"Use $wrapper for the quadit command."}
listen_words=${AGENT_CHECK_LISTEN:-}

# as_tool SESSION FOLDER COMMAND [ARG ...]: runs COMMAND as the tool is run, in FOLDER with this check's environment.
as_tool() {
	local session=$1 dir=$2
	shift 2
	(
		cd "$dir"
		export AGENT_CHECK_SESSION=$session AGENT_CHECK_WRAPPER=$wrapper AGENT_CHECK_LOGIN=$base QUADIT_CONFIG=$base \
			AGENT_CHECK_SETTINGS="{\"env\":{\"QUADIT_CONFIG\":\"$base\"}}" AGENT_CHECK_MODEL=$model AGENT_CHECK_EFFORT=$effort PATH="$work/bin:$PATH"
		exec "$@"
	)
}
# run SESSION FOLDER PROMPT: the tool's one prompt, its output in WORK/SESSION.log.
run() { as_tool "$1" "$2" sh -c "$command" sh "$3${steer:+ $steer}" >"$work/$1.log" 2>&1 </dev/null; }
# start SESSION FOLDER PROMPT: run in the background, in a process group of its own; its pid in started.
start() {
	set -m
	run "$@" &
	started=$!
	set +m
	sessions+=("$started")
}
ended() { ! kill -0 "$1" 2>/dev/null; }
# stop PID: a person's interrupt, then an end.
stop() {
	kill -INT -- "-$1" 2>/dev/null || :
	until_true 10 ended "$1" || kill -TERM -- "-$1" 2>/dev/null || :
}
# unended: the wrapper calls that started and did not end.
unended() { awk -F'\t' '$2 == "start" { open[$4] = 1 } $2 == "end" { delete open[$4] } END { for (p in open) print p }' "$work/calls.log"; }

# listens WS: the agent listens to SVA in WS, live.
listens() { agent_api "$1" /listening | python3 -c 'import json,sys
sys.exit(0 if any(l.get("project") == "SVA" and l.get("live") for l in json.load(sys.stdin).get("listeners") or []) else 1)'; }
not_listening() { [ "$(api "$1" GET /agents | python3 -c 'import json,sys
print([a for a in json.load(sys.stdin)["agents"] if a["handle"] == sys.argv[1]][0]["listening"])' "@$handle")" = False ]; }
names_the_check() { agent_api "$1" /listening | grep -q '"the check'; }
# say WS TEXT: the person comments on WS's SVA-12; prints the comment's feed position.
say() { person "$1" --json comment SVA-12 "$2" | field seq; }
# replies WS AFTER [WORD ...]: how many comments the agent made on WS's SVA-12, on it or in a thread of it, after
# feed position AFTER; with WORDs, only those holding one of them as a word.
replies() { person "$1" --json show SVA-12 | python3 -c 'import json,re,sys
who, after, words = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
def holds(body):
    return not words or any(re.search(r"\b" + re.escape(w) + r"\b", body, re.I) for w in words)
print(sum(c["by"] == who and c["seq"] > after and holds(c.get("body", "")) for c in json.load(sys.stdin).get("comments") or []))' "@$handle" "${@:2}"; }
answered() { [ "$(replies "$@")" -ge 1 ]; }
# once WS AFTER RIGHT WRONG: exactly one answer after AFTER, holding a word of RIGHT ("4 four") and none of WRONG.
once() {
	local right wrong
	read -ra right <<<"$3"
	read -ra wrong <<<"$4"
	[ "$(replies "$1" "$2")" = 1 ] && [ "$(replies "$1" "$2" "${right[@]}")" = 1 ] && [ "$(replies "$1" "$2" "${wrong[@]}")" = 0 ]
}
# writes WS: every change the agent made in WS, one line each, from the feed.
writes() {
	local who
	who=$(api "$1" GET /agents | python3 -c 'import json,sys
print([a for a in json.load(sys.stdin)["agents"] if a["handle"] == sys.argv[1]][0]["user_id"])' "@$handle")
	api "$1" GET "/events?after=0&limit=2000" | python3 -c 'import json,sys
for e in json.load(sys.stdin).get("events") or []:
    if e.get("actor_id") == sys.argv[1]:
        row = (e.get("data") or {}).get("row") or {}
        print(e["seq"], e["type"], " ".join(str(row.get("body", "")).split())[:70])' "$who"
}
# answers_are WS N...: the agent's comments in WS, anywhere, are one for each N, in that order, each saying its N.
answers_are() {
	local ws=$1
	shift
	writes "$ws" | python3 -c 'import re,sys
words = {"4": "four", "6": "six", "10": "ten", "14": "fourteen", "16": "sixteen", "18": "eighteen"}
said = [l.split(" ", 2)[2] if l.count(" ") >= 2 else "" for l in sys.stdin.read().splitlines() if l.split(" ")[1:2] == ["comment.created"]]
want = sys.argv[1:]
ok = len(said) == len(want) and all(re.search(r"\b(" + n + "|" + words.get(n, n) + r")\b", body, re.I) for n, body in zip(want, said))
print(" | ".join(said))
sys.exit(0 if ok else 1)' "$@"
}
# calls SESSION: the session's calls that ended, as logged.
calls() { awk -F'\t' -v s="$1" '$2 == "end" && $3 == s' "$work/calls.log"; }
# strays SESSION WS: the session's calls that ran outside WS's folder, named another workspace than WS's, or used a
# login file outside this check's; printed, and none (in a session that made calls) is success.
strays() { python3 -c 'import sys
log, session, folder, wsid, slug, name, config = sys.argv[1:]
bad, made = 0, 0
for line in open(log):
    f = line.rstrip("\n").split("\t")
    if len(f) < 7 or f[1] != "start" or f[2] != session:
        continue
    made += 1
    cwd, env_ws, login, args = f[4], f[5], f[6], f[7] if len(f) > 7 else ""
    named = [a.split("=", 1)[1] for a in args.split() if a.startswith("--workspace=")]
    wrong = []
    if cwd != folder and not cwd.startswith(folder + "/"):
        wrong.append("ran in " + cwd)
    if env_ws not in ("-", wsid):
        wrong.append("QUADIT_WORKSPACE=" + env_ws)
    if any(n.lower() not in (wsid, slug, name.lower()) for n in named):
        wrong.append("named " + ",".join(named))
    if not login.startswith(config + "/"):
        wrong.append("login " + login)
    if wrong:
        bad = 1
        print("   ", "; ".join(wrong), "|", args[:120])
if not made:
    print("    it made no call")
sys.exit(bad or not made)' "$work/calls.log" "$1" "$(of "$2" folder)" "$(of "$2" id)" "$(of "$2" slug)" "$(of "$2" name)" "$work/config"; }
# excerpt SESSION: the session's calls, short, for the report.
excerpt() { calls "$1" | awk -F'\t' -v home="$folders" '{ cwd = $5; sub(home "/", "", cwd); ws = ($6 == "-") ? "" : " QUADIT_WORKSPACE=" substr($6, 1, 8) "…"; printf "    [%s%s] %s %s quadit %s => %s\n", cwd, ws, $8, $9, substr($10, 1, 110), substr($11, 1, 70) }'; }
# said SESSION: the tool's last words in the session (Claude Code's result, Codex's last message).
said() { python3 -c 'import json,sys
last = ""
for line in open(sys.argv[1], errors="replace"):
    try:
        e = json.loads(line)
    except ValueError:
        continue
    if not isinstance(e, dict):
        continue
    if e.get("type") == "result" and isinstance(e.get("result"), str):
        last = e["result"]
    item = e.get("item") or {}
    if e.get("type") == "item.completed" and item.get("type") == "agent_message":
        last = item.get("text", "")
print(last.strip() or "(nothing said)")' "$work/$1.log"; }
# untraced: the quadit runs in the tools' transcripts that the wrapper did not log, and any mention of the person's
# own server or login folders; printed, and none is success.
untraced() { python3 -c 'import json,re,sys,glob,collections
work, wrapper = sys.argv[1], sys.argv[2]
own = re.compile(r"(?:127\.0\.0\.1|localhost):4780|Application Support/[Qq]uadit|quadit-data|\.local/bin/quadit|Quadit\.app")
# A quadit by its path (a word ending /quadit, its quotes taken off), or by its name where a command starts.
by_path = re.compile(r"[^\s/]*(/\S*/quadit)(?![\w/.-])")
by_name = re.compile(r"(?:^|[;&|(]|\blc\s+[\x27\"])\s*quadit(?![\w/.-])")
ran = collections.Counter()
bad = 0
logs = [p for p in glob.glob(work + "/*.log") if not p.endswith(("/server.log", "/companion.log"))] + glob.glob(work + "/runs/*.log")
for path in logs:
    session = "companion" if "/runs/" in path else path.rsplit("/", 1)[1][:-4]
    denied = set()
    commands = {}
    for line in open(path, errors="replace"):
        if own.search(line):
            bad = 1
            print("    names the person\x27s own Quadit:", path, line.strip()[:160])
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if not isinstance(e, dict):
            continue
        item = e.get("item") or {}
        if e.get("type") == "item.completed" and item.get("type") == "command_execution":
            commands[item.get("id")] = item.get("command", "")
        if e.get("subtype") == "permission_denied":
            denied.add(e.get("tool_use_id"))
        message = e.get("message") if isinstance(e.get("message"), dict) else {}
        for c in message.get("content") or []:
            if not isinstance(c, dict):
                continue
            if c.get("type") == "tool_use" and c.get("name") == "Bash":
                commands[c.get("id")] = (c.get("input") or {}).get("command", "")
            if c.get("type") == "tool_result" and c.get("is_error") and "permission" in json.dumps(c.get("content")).lower():
                denied.add(c.get("tool_use_id"))
    for id, command in commands.items():
        if id in denied:
            continue
        for w in by_path.findall(command):
            if w != wrapper:
                bad = 1
                print("    ran another quadit:", session, command[:160])
            ran[session] += 1
        ran[session] += len(by_name.findall(command))
logged = collections.Counter(l.split("\t")[2] for l in open(work + "/calls.log") if l.split("\t")[1:2] == ["start"])
for session, n in ran.items():
    if n > logged[session]:
        bad = 1
        print(f"    {session}: {n} quadit runs in its transcript, {logged[session]} through the wrapper")
sys.exit(bad)' "$work" "$wrapper"; }

echo "tool: $tool, $("$tool" --version 2>&1 | head -n 1)${model:+, model $model${effort:+ ($effort)}}"
echo "server: $url; Games $games_id, Acme $acme_id; agent @$handle in each"
echo "the person's own server (port 4780): ${own:-not answering}"

echo "0. Set up"
check "two connections and two tied folders in index.json" "$(python3 -c 'import json,sys
d = json.load(open(sys.argv[1]))
ok = sorted(c["workspace_id"] for c in d["connections"]) == sorted(sys.argv[2:4]) and sorted((f["workspace_id"], f["project"]) for f in d["folders"]) == sorted((w, "SVA") for w in sys.argv[2:4])
sys.exit(0 if ok else 1)' "$work/config/index.json" "$games_id" "$acme_id" && echo 0 || echo 1)" "$(cat "$work/config/index.json")"

# 1. A folder tied to none.
echo "1. Check Quadit, in a folder tied to none"
start untied "$untied_folder" "Check Quadit."
untied_pid=$started
check "the chat ended by itself" "$(passed until_true "$answer_time" ended "$untied_pid")"
stop "$untied_pid"
untied_said=$(said untied)
acted=$(calls untied | awk -F'\t' '$8 == "status=0" { split($10, a, " "); verb = a[1]; if (verb == "me" || verb == "help" || verb == "version" || verb == "skill" || (verb == "use" && (a[2] == "" || a[2] ~ /^--/ && a[2] !~ /^--workspace/))) next; print "    " $10 }')
check "it did nothing in either workspace (no command but me or use alone succeeded)" "$([ -z "$acted" ] && echo 0 || echo 1)" "$acted"
check "no folder was tied" "$(python3 -c 'import json,sys;sys.exit(0 if len(json.load(open(sys.argv[1]))["folders"]) == 2 else 1)' "$work/config/index.json" && echo 0 || echo 1)"
check "it asked which workspace, naming both" "$(printf '%s' "$untied_said" | grep -qi games && printf '%s' "$untied_said" | grep -qi acme && echo 0 || echo 1)"

# 2. Two chats listen at once.
echo "2. Listen to Quadit, in each tied folder"
start games "$games_folder" "Listen to Quadit.${listen_words:+ $listen_words}"
games_pid=$started
start acme "$acme_folder" "Listen to Quadit.${listen_words:+ $listen_words}"
acme_pid=$started
both_listen() { listens games && listens acme; }
listening=$(passed until_true 300 both_listen)
check "both listen to SVA, each in its own workspace" "$listening" \
	"Games: $(agent_api games /listening), Acme: $(agent_api acme /listening); the chats said: $(said games | head -c 300) / $(said acme | head -c 300)"
if [ "$listening" != 0 ]; then
	skip "3 to 5 (answering, a logout, a companion)" "the chats do not both listen"
else

	# 3. A comment for the agent in each.
	echo "3. A comment for the agent on each SVA-12"
	games_first=$(say games "@$handle what do 2 and 2 make? Answer here in a comment.")
	acme_first=$(say acme "@$handle what do 3 and 3 make? Answer here in a comment.")
	check "Games' comment answered" "$(passed until_true "$answer_time" answered games "$games_first" 4 four)" "$(replies games "$games_first") answers after it"
	check "Acme's comment answered" "$(passed until_true "$answer_time" answered acme "$acme_first" 6 six)" "$(replies acme "$acme_first") answers after it"
	sleep 30
	check "Games: exactly one answer, saying 4, none saying 6" "$(passed once games "$games_first" "4 four" "6 six")" "$(replies games "$games_first") answers"
	check "Acme: exactly one answer, saying 6, none saying 4" "$(passed once acme "$acme_first" "6 six" "4 four")" "$(replies acme "$acme_first") answers"
	check "each chat acknowledged its item" "$(calls games | grep -q "status=0.*	ack " && calls acme | grep -q "status=0.*	ack " && echo 0 || echo 1)"
	for ws in games acme; do
		strays_out=$(strays "$ws" "$ws" 2>&1) || strays_out=${strays_out:-the call log could not be read}
		check "every call of the $(of "$ws" name) chat ran in its folder and workspace" "$([ -z "$strays_out" ] && echo 0 || echo 1)" "$strays_out"
	done

	# 4. Acme taken away while both listen.
	echo "4. quadit logout --workspace=Acme, while both listen"
	check "both still listen" "$(passed both_listen)"
	(cd "$work" && QUADIT_CONFIG=$base "$real" logout --workspace="$acme_id") >>"$work/login.txt" 2>&1
	logout_at=$(date +%s)
	# A wait that started before the logout holds on with the login it read, so the chat learns of it when that wait ends:
	# within a hold for a wait in the foreground; for a long one in the background, a comment ends it sooner.
	check "the Acme chat stopped by itself within two minutes" "$(passed until_true 120 ended "$acme_pid")" \
		"Acme still shows it listening: $(agent_api acme /listening)"
	if ! ended "$acme_pid"; then
		acme_late=$(say acme "@$handle what do 9 and 9 make? Answer here in a comment.")
		check "told of a comment in Acme, the Acme chat stopped" "$(passed until_true "$answer_time" ended "$acme_pid")"
	fi
	stop "$acme_pid"
	acme_said=$(said acme)
	check "its next command in Acme was refused: not connected there" "$(calls acme | awk -F'\t' -v t="$logout_at" '$1 >= t' | grep -v "status=0" | grep -qi "not connected" && echo 0 || echo 1)"
	check "it said why it stopped" "$(printf '%s' "$acme_said" | grep -qiE "connect|logged out|log ?out|removed" && echo 0 || echo 1)"
	check "the agent stops showing as listening in Acme" "$(passed until_true 180 not_listening acme)"
	check "the Games chat still runs and listens" "$( ! ended "$games_pid" && listens games && echo 0 || echo 1)"
	games_second=$(say games "@$handle and 5 and 5? Answer here in a comment.")
	check "Games' third comment answered" "$(passed until_true "$answer_time" answered games "$games_second" 10 ten)" "$(replies games "$games_second") answers after it"
	sleep 30
	check "Games: exactly one answer, saying 10" "$(passed once games "$games_second" "10 ten" "4 four")" "$(replies games "$games_second") answers"
	check "Acme: no answer after the logout" "$([ "$(replies acme "$acme_first")" = 1 ] && echo 0 || echo 1)" "$(replies acme "$acme_first") answers after the first comment"
	# The comment the logged-out chat was told of stays unread: whatever listens there next is handed it, the companion below.

	# 5. A companion in Acme while the Games chat listens.
	echo "5. A companion in Acme, as the skill gives it, while the Games chat listens"
	of acme token | QUADIT_CONFIG=$base "$real" login "$url" - >>"$work/login.txt"
	check "Acme is connected again" "$(python3 -c 'import json,sys;sys.exit(0 if len(json.load(open(sys.argv[1]))["connections"]) == 2 else 1)' "$work/config/index.json" && echo 0 || echo 1)"
	cat >"$work/bin/wake" <<EOF
#!/bin/sh
# One run of the tool for one inbox item, with the skill's companion prompt.
n=\$(ls "$work/runs" | wc -l | tr -d ' ')
start=\$(date +%s)
sh -c "\$AGENT_CHECK_ONE_PROMPT" sh "Quadit woke you for this inbox item:
\$QUADIT_ITEM
Handle it with the quadit skill: answer where you were asked, and write nothing when it asks nothing of you.${steer:+ $steer}" >"$work/runs/\$n.log" 2>&1
status=\$?
echo "run \$n: \$((\$(date +%s) - start))s, exit \$status, QUADIT_WORKSPACE=\$QUADIT_WORKSPACE, in \$(pwd -P)" >>"$work/runs.txt"
exit \$status
EOF
	chmod +x "$work/bin/wake"
	set -m
	AGENT_CHECK_ONE_PROMPT=$command as_tool companion "$acme_folder" "$wrapper" listen project=SVA --workspace="$acme_id" "by=the check" --exec "$work/bin/wake" >"$work/companion.log" 2>&1 &
	companion_pid=$!
	sessions+=("$companion_pid")
	set +m
	check "the companion listens in Acme, named the check" "$(passed until_true 60 names_the_check acme)" "$(agent_api acme /listening)"
	if [ -n "${acme_late:-}" ]; then
		check "the comment the logged-out chat was told of is handed to the companion, and answered" "$(passed until_true "$answer_time" answered acme "$acme_late" 18 eighteen)"
	fi
	acme_second=$(say acme "@$handle what do 7 and 7 make? Answer here in a comment.")
	games_third=$(say games "@$handle and 8 and 8? Answer here in a comment.")
	check "Acme's comment answered by the companion's run" "$(passed until_true "$answer_time" answered acme "$acme_second" 14 fourteen)" "$(replies acme "$acme_second") answers after it"
	check "Games' comment answered by the Games chat" "$(passed until_true "$answer_time" answered games "$games_third" 16 sixteen)" "$(replies games "$games_third") answers after it"
	sleep 30
	check "Acme: exactly one answer, saying 14, none saying 16" "$(passed once acme "$acme_second" "14 fourteen" "16 sixteen")" "$(replies acme "$acme_second") answers"
	check "Games: exactly one answer, saying 16, none saying 14" "$(passed once games "$games_third" "16 sixteen" "14 fourteen")" "$(replies games "$games_third") answers"
	for pair in "companion acme the companion's runs" "games games the Games chat"; do
		read -r session ws who <<<"$pair"
		strays_out=$(strays "$session" "$ws" 2>&1) || strays_out=${strays_out:-the call log could not be read}
		check "every call of $who ran in $(of "$ws" name)'s folder and workspace" "$([ -z "$strays_out" ] && echo 0 || echo 1)" "$strays_out"
	done
	stop "$companion_pid"
	stop "$games_pid"
	check "stopped, nothing listens in Acme" "$(passed until_true 180 not_listening acme)"
fi

echo "6. The person's own Quadit, and the logs"
for ws in games acme; do
	echo "   what @$handle wrote in $(of "$ws" name), from its feed:"
	writes "$ws" | sed 's/^/    /'
done
if [ "$listening" = 0 ]; then
	acme_answers="6 14"
	[ -z "${acme_late:-}" ] || acme_answers="6 18 14"
	games_said=$(answers_are games 4 10 16) && games_ok=0 || games_ok=1
	check "the agent's comments in Games, anywhere, are its answers there: 4, 10, 16" "$games_ok" "$games_said"
	# shellcheck disable=SC2086 # the numbers are words
	acme_said_all=$(answers_are acme $acme_answers) && acme_ok=0 || acme_ok=1
	check "the agent's comments in Acme, anywhere, are its answers there: ${acme_answers// /, }" "$acme_ok" "$acme_said_all"
fi
check "no call used a login outside this check's folder" "$(awk -F'\t' -v c="$work/config/" '$2 == "start" && index($7, c) != 1' "$work/calls.log" | grep -q . && echo 1 || echo 0)"
untraced_out=$(untraced 2>&1) || untraced_out=${untraced_out:-the transcripts could not be read}
check "every quadit in the transcripts ran through the wrapper, and none names the person's own Quadit" "$([ -z "$untraced_out" ] && echo 0 || echo 1)" "$untraced_out"
check "no process of this check connected to port 4780" "$([ -s "$work/own-server.txt" ] && echo 1 || echo 0)" "$(cat "$work/own-server.txt")"
echo "the person's own server now: $(curl -s --max-time 2 http://127.0.0.1:4780/api/v1/version || echo "not answering")"

for session in games acme untied companion; do
	echo "calls of $session:"
	excerpt "$session"
done
echo "the untied chat said:"
printf '%s\n' "$untied_said" | sed 's/^/    /'
echo "the Acme chat said, stopping:"
printf '%s\n' "$acme_said" | sed 's/^/    /'
echo "the companion's runs:"
sed 's/^/    /' "$work/runs.txt" 2>/dev/null || echo "    (none)"
echo "paid runs: $((3 + $(find "$work/runs" -name '*.log' | wc -l))), as each reported its use:"
for log in "$work"/games.log "$work"/acme.log "$work"/untied.log "$work"/runs/*.log; do
	[ -f "$log" ] || continue
	python3 -c 'import json,sys
cost = turns = 0
tokens = {}
for line in open(sys.argv[1], errors="replace"):
    try:
        e = json.loads(line)
    except ValueError:
        continue
    if not isinstance(e, dict):
        continue
    if e.get("type") == "result":
        cost, turns = e.get("total_cost_usd") or cost, turns + (e.get("num_turns") or 0)
    if e.get("type") == "turn.completed":
        for k, v in (e.get("usage") or {}).items():
            tokens[k] = tokens.get(k, 0) + v
use = f"{turns} turns, {cost:.2f} USD as Claude Code counts it" if turns else ", ".join(f"{k} {v}" for k, v in tokens.items()) or "not reported"
name = sys.argv[1].rsplit("/", 1)[1][:-4]
print("   ", ("companion run " if "/runs/" in sys.argv[1] else "") + name + ":", use)' "$log"
done
echo "the skill the tool was given (the tested quadit's own, sha256 $("$real" skill | shasum -a 256 | cut -c 1-12))"
summary="$passes checks passed, ${#skipped[@]} phases skipped${skipped[*]:+: ${skipped[*]}}"
if [ "$failed" = 0 ]; then echo "$summary"; else echo "some checks failed; $summary"; fi
exit "$failed"
