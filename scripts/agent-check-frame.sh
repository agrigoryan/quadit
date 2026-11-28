# What the checks with a real agent tool (agent-listen-check.sh,
# agent-workspaces-check.sh) share, sourced by them: keeping the person's own
# Quadit out of reach, a throwaway server, and the lines a check prints.
#
#   forget_own_quadit       unsets every QUADIT_* of the shell the check runs in
#   refuse_quadit_mcp TOOL  exits when TOOL's MCP settings name a Quadit server
#   start_server REAL DIR   a server of the quadit REAL on a free port, its data
#                           and log in DIR; sets url and server (its pid)
#   check, skip, passed, until_true, field: below
#
# A check that sources this sets failed=0 passes=0 skipped=() first.

# shellcheck shell=bash
# Some functions are only called through others (passed, until_true), and url and server are for the check.
# shellcheck disable=SC2329,SC2034
forget_own_quadit() {
	local v
	for v in $(env | sed -n 's/^\(QUADIT_[A-Z_]*\)=.*/\1/p'); do unset "$v"; done
}

# The tool's known MCP settings, and their kind.
mcp_settings() {
	case $1 in
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
# refuse_quadit_mcp TOOL: the check refuses to run while the tool's MCP settings name a Quadit server, which the tool
# could use instead of the quadit command, and so reach the person's own (AGENT_CHECK_ALLOW_MCP=1 runs anyway).
refuse_quadit_mcp() {
	[ "${AGENT_CHECK_ALLOW_MCP:-}" != 1 ] || return 0
	local file kind names
	while read -r file kind; do
		[ -n "$file" ] && [ -f "$file" ] || continue
		names=$(quadit_mcp "$file" "$kind") || { echo "$file could not be read to look for a Quadit MCP server; run with AGENT_CHECK_ALLOW_MCP=1 to go on anyway." >&2; exit 2; }
		if [ -n "$names" ]; then
			echo "$1 has an MCP server that mentions Quadit in $file ($names), which it could use instead of the quadit command, and so reach your own Quadit." >&2
			echo "Turn it off for this check, or run with AGENT_CHECK_ALLOW_MCP=1 if you know it cannot reach it." >&2
			exit 2
		fi
	done < <(mcp_settings "$1")
}

start_server() {
	local port
	port=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
	url="http://127.0.0.1:$port"
	"$1" serve --data "$2/server" --listen "127.0.0.1:$port" --url "$url" >"$2/server.log" 2>&1 &
	server=$!
	for _ in $(seq 100); do curl -sf "$url/healthz" >/dev/null 2>&1 && break; sleep 0.2; done
	curl -sf "$url/healthz" >/dev/null || { echo "the server did not start: $2/server.log" >&2; exit 1; }
}

check() { # check NAME CONDITION-RESULT(0/1) [DETAIL]
	if [ "$2" = 0 ]; then
		echo "  pass  $1"
		passes=$((passes + 1))
	else
		echo "  FAIL  $1${3:+: $3}"
		failed=1
	fi
}
skip() { # skip PHASE WHY: a phase not run, which is not a phase passed
	echo "  SKIPPED  $2"
	skipped+=("$1")
}
passed() { if "$@"; then echo 0; else echo 1; fi; }
until_true() { # until_true SECONDS COMMAND...: polls once a second
	local end=$((SECONDS + $1))
	shift
	until "$@"; do [ "$SECONDS" -lt "$end" ] || return 1; sleep 1; done
}
# field KEY[.KEY...]: that value of the JSON on standard input.
field() { python3 -c 'import json,sys;v=json.load(sys.stdin)
for k in sys.argv[1].split("."): v=v[k]
print(v)' "$1"; }
