#!/usr/bin/env bash
# Fills a fresh Quadit server with the demo workspace the website's
# screenshots show: a small studio (three people, four agents) building
# "Tidewell", a tide and weather app. Everything in it is made up.
#
#   QUADIT_SEED_URL=http://127.0.0.1:4791 website/shots/seed.sh
#
# Run it from the repository's root after `make build`, against a server
# with a new, empty data directory (capture.ts starts one and runs this).
# Sign in as maya@harbor.example / correct-horse-battery.
set -euo pipefail

B=${QUADIT_SEED_URL:-http://127.0.0.1:4791}
Q=${QUADIT_BIN:-./bin/quadit}
ART=${QUADIT_SEED_ART:-$(dirname "$0")/art}
PASS=correct-horse-battery
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export QUADIT_URL=$B QUADIT_CONFIG=$TMP/cli.json

day() { python3 -c "import datetime,sys;print((datetime.date.today()+datetime.timedelta(days=int(sys.argv[1]))).isoformat())" "$1"; }
json() { python3 -c "import json,sys;d=json.load(sys.stdin);print(eval(sys.argv[1],{'d':d}))" "$1"; }

# A request as the server's own pages make it: a write made with the sign-in
# cookie has to name its origin and send its body as JSON.
web() { curl -sf -H "Origin: $B" -H "Content-Type: application/json" "$@"; }
# One signed-in person: a cookie jar, then an API token of their own for the CLI.
jar() { echo "$TMP/$1.jar"; }
token_of() { web -b "$(jar "$1")" -X POST "$B/api/v1/w/$WS/tokens" -d "{\"name\":\"seed\"${2:+,\"user\":\"$2\"}}" | json 'd["token"]'; }
settok() { eval "TOK_$1=\$2"; }
tok() { eval "echo \"\$TOK_$1\""; }
as() { local who=$1; shift; QUADIT_TOKEN=$(tok "$who") "$Q" "$@" >/dev/null; }
asj() { local who=$1; shift; QUADIT_TOKEN=$(tok "$who") "$Q" --json "$@"; }
do_() { local who=$1 type=$2 args=$3; as "$who" do "$type" "$args"; }

web -c "$(jar maya)" -X POST "$B/api/v1/auth/setup" \
  -d "{\"name\":\"Maya Okafor\",\"email\":\"maya@harbor.example\",\"password\":\"$PASS\",\"workspace_name\":\"Harbor Studio\"}" >/dev/null \
  || { echo "setup failed: is the server fresh and running at $B?" >&2; exit 1; }
WS=harbor-studio
settok maya "$(token_of maya)"

# Two more people, by invitation.
for p in "jonas:Jonas Lindqvist" "priya:Priya Raman"; do
  h=${p%%:*} name=${p#*:}
  link=$(web -b "$(jar maya)" -X POST "$B/api/v1/w/$WS/invites" -d '{"role":"member"}' | json 'd["link"]')
  web -c "$(jar "$h")" -X POST "$B/api/v1/auth/invite/${link##*/}" \
    -d "{\"name\":\"$name\",\"email\":\"$h@harbor.example\",\"password\":\"$PASS\"}" >/dev/null
  settok "$h" "$(token_of "$h")"
done

do_ maya project.create '{"key":"TDW","name":"Tidewell","description":"Tides, swell and wind for small-boat sailors, on iPhone and iPad.","settings":{"cycles":true,"cycle_days":14,"estimates":true}}'
do_ maya project.create '{"key":"WEB","name":"Website","description":"tidewell.app and the press kit."}'

# Short handles for the people.
for h in maya jonas priya; do
  was=$(asj "$h" me | json '(d.get("member") or d.get("user") or d)["handle"]')
  do_ maya member.update "{\"id\":\"$was\",\"handle\":\"$h\"}"
done
MAYA=@maya JONAS=@jonas PRIYA=@priya

for a in \
  "{\"name\":\"Atlas\",\"handle\":\"atlas\",\"role\":\"admin\",\"responsible\":\"$MAYA\",\"description\":\"Plans the cycle, hands out work, keeps the board honest\"}" \
  "{\"name\":\"Iris\",\"handle\":\"iris\",\"responsible\":\"$JONAS\",\"description\":\"Icons, illustrations and App Store screenshots\"}" \
  "{\"name\":\"Forge\",\"handle\":\"forge\",\"responsible\":\"$PRIYA\",\"description\":\"Swift and server code, with tests\"}" \
  "{\"name\":\"Scout\",\"handle\":\"scout\",\"responsible\":\"$PRIYA\",\"description\":\"Builds, device checks and release notes\"}"; do
  do_ maya agent.create "$a"
done
for a in atlas iris forge scout; do settok "$a" "$(token_of maya "@$a")"; done

for l in design:#8b5cf6 ios:#3b82f6 server:#10b981 bug:#ef4444 copy:#f59e0b; do
  do_ maya label.create "{\"name\":\"${l%%:*}\",\"color\":\"${l##*:}\",\"project\":\"TDW\"}"
done
do_ maya epic.create "{\"project\":\"TDW\",\"name\":\"Tidewell 2.0\",\"description\":\"A faster tide chart, offline stations, a new icon.\",\"state\":\"active\",\"lead\":\"$MAYA\",\"start_on\":\"$(day -20)\",\"target_on\":\"$(day 24)\"}"
do_ maya epic.create "{\"project\":\"TDW\",\"name\":\"Lock Screen widgets\",\"state\":\"planned\",\"lead\":\"$JONAS\",\"start_on\":\"$(day 25)\",\"target_on\":\"$(day 60)\"}"
do_ maya milestone.create "{\"epic\":\"Tidewell 2.0\",\"name\":\"Beta to testers\",\"target_on\":\"$(day 6)\"}"
do_ maya milestone.create "{\"epic\":\"Tidewell 2.0\",\"name\":\"App Store release\",\"target_on\":\"$(day 24)\"}"
# Cycles of 14 days are made with the project; the tasks below are in the current one.
CYCLE=1
do_ maya preference.create '{"body":"Icons stay legible at 29 pt: no thin lines, no more than three colours.","project":"TDW","labels":["design"]}'

task() { do_ "$1" task.create "$2"; }
E='"epic":"Tidewell 2.0"'
C="\"cycle\":\"$CYCLE\""
task maya "{\"project\":\"TDW\",\"title\":\"App icon for 2.0\",\"assignee\":\"@iris\",\"labels\":[\"design\"],$E,$C,\"priority\":2,\"estimate\":3,\"status\":\"In Progress\",\"description\":\"The 1.x icon is a blue square with a sine wave. For 2.0 we want something that reads on a crowded home screen.\\n\\n- legible at 29 pt\\n- works on light and dark wallpapers\\n- three directions, then we pick one\"}"
task maya "{\"project\":\"TDW\",\"title\":\"Redraw the tide chart at 120 fps\",\"assignee\":\"@forge\",\"labels\":[\"ios\"],$E,$C,\"priority\":2,\"estimate\":5,\"status\":\"In Progress\"}"
task maya "{\"project\":\"TDW\",\"title\":\"Offline cache for station data\",\"assignee\":\"@forge\",\"labels\":[\"ios\",\"server\"],$E,$C,\"priority\":3,\"estimate\":3,\"status\":\"Todo\"}"
task maya "{\"project\":\"TDW\",\"title\":\"Small-craft advisory alerts\",\"assignee\":\"$PRIYA\",\"labels\":[\"ios\"],$E,$C,\"priority\":2,\"estimate\":5,\"status\":\"Todo\",\"due_on\":\"$(day 5)\"}"
task maya "{\"project\":\"TDW\",\"title\":\"Tide chart clips its label at low water\",\"assignee\":\"@forge\",\"labels\":[\"ios\",\"bug\"],$C,\"priority\":3,\"estimate\":1,\"status\":\"In Progress\"}"
task maya "{\"project\":\"TDW\",\"title\":\"Onboarding: three screens, not five\",\"assignee\":\"$JONAS\",\"labels\":[\"design\",\"copy\"],$E,$C,\"priority\":3,\"estimate\":2,\"status\":\"In Progress\"}"
task maya "{\"project\":\"TDW\",\"title\":\"Next high tide widget\",\"labels\":[\"design\",\"ios\"],\"epic\":\"Lock Screen widgets\",\"status\":\"Backlog\",\"estimate\":5}"
task maya "{\"project\":\"TDW\",\"title\":\"Moon phase on the Lock Screen\",\"labels\":[\"design\"],\"epic\":\"Lock Screen widgets\",\"status\":\"Backlog\",\"estimate\":2}"
task maya "{\"project\":\"TDW\",\"title\":\"Crash opening a station in iPad split view\",\"assignee\":\"$PRIYA\",\"labels\":[\"ios\",\"bug\"],$C,\"priority\":1,\"estimate\":2,\"status\":\"In Progress\"}"
task maya "{\"project\":\"TDW\",\"title\":\"Release notes for beta 3\",\"assignee\":\"@scout\",\"labels\":[\"copy\"],$E,$C,\"priority\":3,\"estimate\":1,\"status\":\"Todo\"}"
task maya "{\"project\":\"TDW\",\"title\":\"Portuguese translation\",\"labels\":[\"copy\"],\"status\":\"Backlog\",\"estimate\":3}"
task maya "{\"project\":\"TDW\",\"title\":\"Swell height in feet or metres by region\",\"assignee\":\"@forge\",\"labels\":[\"ios\"],$E,$C,\"priority\":3,\"estimate\":2,\"status\":\"In Progress\"}"
task maya "{\"project\":\"TDW\",\"title\":\"Beta 3 to external testers\",\"assignee\":\"@scout\",\"labels\":[\"ios\"],$E,$C,\"priority\":2,\"estimate\":1,\"status\":\"Todo\"}"
task maya "{\"project\":\"TDW\",\"parent\":\"TDW-2\",\"title\":\"Build chart paths off the main thread\",\"assignee\":\"@forge\",\"labels\":[\"ios\"],\"status\":\"Done\",\"estimate\":2}"
task maya "{\"project\":\"TDW\",\"parent\":\"TDW-2\",\"title\":\"Cache the hour labels' glyphs\",\"assignee\":\"@forge\",\"labels\":[\"ios\"],\"status\":\"Todo\",\"estimate\":1}"
task maya "{\"project\":\"TDW\",\"title\":\"Sunrise and sunset under the chart\",\"labels\":[\"ios\"],$E,\"status\":\"Done\",\"estimate\":1}"
task maya "{\"project\":\"TDW\",\"title\":\"Wind arrows point the wrong way in the southern hemisphere\",\"assignee\":\"@forge\",\"labels\":[\"ios\",\"bug\"],$C,\"status\":\"In Progress\",\"priority\":2,\"estimate\":1}"
task maya '{"project":"WEB","title":"Press kit with the new icon","labels":[],"status":"Backlog"}'
task maya "{\"project\":\"WEB\",\"title\":\"App Store screenshots for 2.0\",\"assignee\":\"@iris\",\"status\":\"Todo\"}"
do_ maya relation.add '{"task":"TDW-13","type":"blocked_by","other":"TDW-9"}'
do_ maya resource.create '{"name":"iPhone 15 test device","description":"The shared phone on the desk, for device checks"}'
do_ maya resource.create '{"name":"Build Mac","description":"Signs and uploads builds"}'

# The decision the screenshots centre on: Iris asks, with a picture per option.
as iris take TDW-1
as iris ask TDW-1 "Which direction for the 2.0 icon?" \
  option="Wave::One bold wave. Strong at large sizes, busy below 40 pt." file="$ART/icon-wave.png" \
  option="Tide clock::A dial with the moon and the water line. Says what the app does." file="$ART/icon-tideclock.png" \
  option="Lighthouse::Warm and friendly; the beam turns to noise when small." file="$ART/icon-lighthouse.png" \
  recommended=2 why="Reads best at 29 pt on a busy home screen, and the dial is ours alone." ask="$MAYA"

# Results with evidence, and decisions already answered.
as forge take TDW-17
as forge result TDW-17 "Arrows now use the bearing the wind blows from, everywhere." checked="Hobart, Auckland and Valparaíso stations in the simulator" measured="0 of 212 stations off by more than 1°" not_verified="on a device in the southern hemisphere"
as forge update TDW-17 status=Done
as forge take TDW-12
as forge ask TDW-12 "Swell height for US stations?" option="Feet::What US charts and forecasts use" option="Metres::One unit everywhere" recommended=1 ask="$MAYA"
D=$(asj maya show TDW-12 | json 'd["decisions"][0]["id"]')
as maya pick "$D" 1 note="Feet in the US, metres elsewhere; a setting to override."
as forge result TDW-12 "Feet for US stations, metres elsewhere, and a units setting." checked="unit tests for 14 regions" measured="settings screen at 1x and 3x"
as forge update TDW-12 status=Done
as forge take TDW-5
as forge comment TDW-5 "At the lowest tides the label sat under the axis. It now moves above the curve when there is no room below." waiting_on="$PRIYA"
as scout take TDW-13
as scout approval TDW-13 "Send beta 3 to the 140 external testers?" ask="$MAYA"
as priya comment TDW-9 "Reproduced on iPad Air in split view at one third width. @forge can you look at the layout pass?"
as atlas comment TDW-3 "Planned for this cycle after the chart work. @forge takes it once TDW-2 is done."
as jonas comment TDW-1 "Love where these are going. Whichever we pick, keep the corner radius of the system mask."

# Agents at work: shared machines, and session records.
as scout do resource.acquire '{"resource":"iPhone 15 test device","task":"TDW-13","note":"smoke test of beta 3"}'
as forge do resource.acquire '{"resource":"Build Mac","task":"TDW-2","note":"profiling build"}'
as iris do resource.acquire '{"resource":"iPhone 15 test device","task":"TDW-1","note":"icons on a real home screen"}'
session() {
  local who=$1 task=$2 title=$3; shift 3
  local id
  id=$(asj "$who" do session.start "{\"task\":\"$task\",\"title\":\"$title\"}" | json 'd.get("ref") or d["results"][0]["ref"]')
  do_ "$who" session.update "{\"id\":\"$id\",\"add_steps\":$1${2:+,\"state\":\"$2\"}}"
}
session forge TDW-2 "Profile the chart on iPhone 12" '[{"text":"Instruments trace: path building is 9 ms a frame"},{"text":"Moved path building to a background queue"},{"text":"Now 3.1 ms a frame; 120 fps on ProMotion"}]'
session iris TDW-1 "Three icon directions" '[{"text":"Sketched nine directions, kept three"},{"text":"Rendered each at 1024, 180, 87 and 58 px"},{"text":"Checked them on light and dark wallpapers"}]'
session scout TDW-13 "Smoke test beta 3" '[{"text":"Installed build 2.0 (312) on the test iPhone"},{"text":"Opened 20 stations, offline and online"}]'
session atlas TDW-3 "Plan cycle 14" '[{"text":"Moved 4 tasks in, 2 out"},{"text":"Asked Maya about the beta date"}]' done

# Docs: a plan with a thread on a few of its words, a principles page, and a database.
PLAN=$(asj maya do doc.create "$(python3 - <<'PY'
import json
md = """Tidewell 2.0 is about one thing: the tide chart should feel instant, everywhere, even with no signal at the dock.

## What ships

- TDW-2
- TDW-3
- TDW-4
- TDW-1

## What waits

We ship the Lock Screen widgets in 2.1, after the chart work settles. Moon phase goes with them.

## Dates

| Step | When |
| --- | --- |
| Beta to testers | next week |
| App Store release | in three weeks |

## Open questions

- Do alerts need a quiet-hours setting from day one?
- Who writes the App Store text?
"""
print(json.dumps({"title": "2.0 launch plan", "icon": "🌊", "project": "TDW", "markdown": md}))
PY
)" | json 'd.get("ref") or d["results"][0]["ref"]')
BLOCK=$(asj maya doc "$PLAN" | json '[b["id"] for b in d["blocks"] if isinstance(b.get("content"),list) and "widgets in 2.1" in "".join(c.get("text","") for c in b["content"] if isinstance(c,dict))][0]')
as jonas comment page="$PLAN" block="$BLOCK" quote="Lock Screen widgets in 2.1" "Could the high-tide widget make 2.0? Testers ask for it more than anything else."
T=$(asj jonas comments "$PLAN" | json '(d.get("threads") or d.get("comments"))[0]["id"]' 2>/dev/null || true)
[ -n "${T:-}" ] && as atlas reply "$T" "It needs the offline cache first. If that lands this week, Forge estimates two more days for the widget."

asj maya do doc.create "$(python3 -c 'import json;print(json.dumps({"title":"Design principles","icon":"🧭","project":"TDW","markdown":"1. The chart is the app. Everything else is one tap away.\n2. Legible in sunlight, with wet hands.\n3. No account, no ads, no surprises.\n"}))')" >/dev/null

DB=$(asj maya do doc.create '{"kind":"database","title":"Tide stations","icon":"📍","project":"TDW"}' | json 'd.get("ref") or d["results"][0]["ref"]')
do_ maya property.create "{\"database\":\"$DB\",\"name\":\"Region\",\"type\":\"select\"}"
do_ maya property.create "{\"database\":\"$DB\",\"name\":\"Status\",\"type\":\"select\"}"
do_ maya property.create "{\"database\":\"$DB\",\"name\":\"Offline\",\"type\":\"checkbox\"}"
do_ maya property.create "{\"database\":\"$DB\",\"name\":\"Range\",\"type\":\"number\"}"
while IFS='|' read -r name region status offline off; do
  as maya row "$DB" "$name" Region="$region" Status="$status" Offline="$offline" Range="$off"
done <<'ROWS'
Port Townsend|Pacific NW|Live|true|1.42
Astoria|Pacific NW|Live|true|1.18
Monterey|California|Live|true|0.97
Bar Harbor|New England|Checking|false|1.91
Charleston|Southeast|Live|false|0.88
Key West|Southeast|Live|true|0.31
Kodiak|Alaska|Checking|false|2.07
Hobart|Australia|Live|true|0.64
Auckland|New Zealand|Live|false|1.55
ROWS

echo "seeded $B/$WS  (sign in as maya@harbor.example / $PASS)"
