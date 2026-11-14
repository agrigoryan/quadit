#!/usr/bin/env bash
# Fills a fresh local server with a workspace, people, agents, tasks and a
# decision with pictures, so there is something to look at while developing.
#
#   make server && QUADIT_DATA=./data ./bin/quadit serve --listen 127.0.0.1:4780 &
#   ./scripts/dev-seed.sh
#
# Sign in as owner@example.com / correct-horse-battery
set -euo pipefail

B=${QUADIT_SEED_URL:-http://127.0.0.1:4780}
Q=${QUADIT_BIN:-./bin/quadit}
TMP=$(mktemp -d)
JAR=$TMP/jar
trap 'rm -rf "$TMP"' EXIT

uuid() { python3 -c 'import os,time;t=int(time.time()*1000);b=bytearray(t.to_bytes(6,"big")+os.urandom(10));b[6]=0x70|(b[6]&15);b[8]=0x80|(b[8]&63);h=b.hex();print(f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}")'; }
change() { curl -sf -b "$JAR" -X POST "$B/api/v1/w/games/changes" -d "{\"id\":\"$(uuid)\",\"type\":\"$1\",\"args\":$2}" >/dev/null || { echo "failed: $1 $2" >&2; exit 1; }; }
png() { python3 - "$1" "$2" "$3" "$4" <<'PY'
import struct, sys, zlib, math
path, w, h, kind = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
rows = []
for y in range(h):
    row = bytearray([0])
    for x in range(w):
        dx, dy = x - w / 2, y - h / 2
        d = math.hypot(dx, dy) / (w / 2)
        if kind == "ring":
            v = 1 - min(1, abs(d - 0.6) * 6)
            px = (int(255 * v), int(120 * v), int(30 * v))
        elif kind == "burst":
            a = math.atan2(dy, dx)
            v = max(0, 1 - d) * (0.6 + 0.4 * math.cos(a * 9))
            px = (int(255 * v), int(210 * v), int(60 * v))
        else:
            v = max(0, 1 - d * 1.1) * (0.5 + 0.5 * math.sin(x * 0.09) * math.cos(y * 0.07))
            px = (int(130 * v + 40), int(130 * v + 40), int(140 * v + 45))
        row += bytes(px)
    rows.append(bytes(row))
def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
open(path, "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"".join(rows))) + chunk(b"IEND", b""))
PY
}

curl -sf -c "$JAR" -X POST "$B/api/v1/auth/setup" -d '{"name":"Aram","email":"owner@example.com","password":"correct-horse-battery","workspace_name":"Games"}' >/dev/null \
  || { echo "setup failed: is the server fresh and running at $B?" >&2; exit 1; }

change project.create '{"key":"SVA","name":"Samurai vs Alien","description":"A side-scrolling brawler.","settings":{"cycles":true,"cycle_days":14,"estimates":true}}'
change project.create '{"key":"OPS","name":"Operations"}'
for a in '"name":"Coordinator","handle":"coordinator","role":"admin","description":"Plans the work and hands it out"' '"name":"Artist","handle":"artist","description":"Sprites and effects"' '"name":"Coder","handle":"coder","description":"Gameplay code"'; do change agent.create "{$a}"; done
for l in art:#ec4899 code:#3b82f6 audio:#10b981 bug:#ef4444; do change label.create "{\"name\":\"${l%%:*}\",\"color\":\"${l##*:}\",\"project\":\"SVA\"}"; done
change epic.create '{"project":"SVA","name":"Boss fight","description":"The first boss: an alien mothership pilot.","state":"active","lead":"@coordinator","target_on":"2027-01-15"}'
change epic.create '{"project":"SVA","name":"Level 2: the docks","state":"planned","target_on":"2027-02-20"}'
change template.create '{"name":"Review","project":"SVA","title":"Review: ","preset":{"priority":2,"labels":["art"]}}'
change preference.create '{"body":"No rings as the main shape of an explosion.","project":"SVA","labels":["art"]}'

TOK=$(curl -sf -b "$JAR" -X POST "$B/api/v1/w/games/tokens" -d '{"user":"@artist","name":"seed"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
CODER=$(curl -sf -b "$JAR" -X POST "$B/api/v1/w/games/tokens" -d '{"user":"@coder","name":"seed"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
export QUADIT_URL=$B

change task.create '{"project":"SVA","title":"Boss explosion effect","assignee":"@artist","labels":["art"],"epic":"Boss fight","priority":2,"estimate":3,"description":"When the boss dies it should feel **big**.\n\n- readable at 1x\n- no more than 24 frames"}'
change task.create '{"project":"SVA","title":"Boss attack patterns","assignee":"@coder","labels":["code"],"epic":"Boss fight","priority":1,"estimate":5,"status":"In Progress"}'
change task.create '{"project":"SVA","title":"Hit flash is too subtle","labels":["art","bug"],"priority":3}'
change task.create '{"project":"SVA","title":"Dock crane sprites","labels":["art"],"epic":"Level 2: the docks","status":"Backlog"}'
change task.create '{"project":"SVA","title":"Jump feels floaty","assignee":"@coder","labels":["code","bug"],"priority":2,"due_on":"2026-12-01"}'
change task.create '{"project":"SVA","title":"Boss music loop","labels":["audio"],"epic":"Boss fight","status":"Backlog","estimate":2}'
change task.create '{"project":"SVA","parent":"SVA-2","title":"Phase 2: laser sweep","assignee":"@coder","labels":["code"]}'
change task.create '{"project":"SVA","parent":"SVA-2","title":"Phase 3: summon drones","labels":["code"],"status":"Done"}'
change task.create '{"project":"OPS","title":"Set up the build machine","assignee":"@coordinator"}'
change relation.add '{"task":"SVA-1","type":"blocked_by","other":"SVA-2"}'
change resource.create '{"name":"minipc","description":"The shared build and test machine"}'

png "$TMP/ring.png" 960 720 ring; png "$TMP/burst.png" 960 720 burst; png "$TMP/smoke.png" 960 720 smoke
QUADIT_TOKEN=$TOK $Q take SVA-1 >/dev/null
QUADIT_TOKEN=$TOK $Q ask SVA-1 "Which explosion for the boss?" option="A: ring::A classic shockwave ring" option="B: burst::Spiky burst, reads well small" option="C: smoke::Slow rolling smoke" recommended=2 why="B reads best at small size" >/dev/null
OPTS=$(QUADIT_TOKEN=$TOK $Q --json show SVA-1 | python3 -c 'import json,sys;print(" ".join(o["id"] for o in json.load(sys.stdin)["decisions"][0]["options"]))')
i=0; for o in $OPTS; do f=(ring burst smoke); QUADIT_TOKEN=$TOK $Q attach SVA-1 "$TMP/${f[$i]}.png" option="$o" >/dev/null; i=$((i+1)); done
QUADIT_TOKEN=$CODER $Q take SVA-5 >/dev/null
QUADIT_TOKEN=$CODER $Q comment SVA-5 "Gravity is 0.35 now; tried 0.5 and it feels right to me. @aram can you try the build?" waiting_on=@aram >/dev/null
QUADIT_TOKEN=$CODER $Q approval SVA-5 "Merge the jump fix into main?" action=task.delete >/dev/null || true
QUADIT_TOKEN=$CODER $Q do resource.acquire '{"resource":"minipc","task":"SVA-5","note":"playtest build"}' >/dev/null
QUADIT_TOKEN=$TOK $Q do resource.acquire '{"resource":"minipc","note":"render sprites"}' >/dev/null

echo "seeded. Open $B and sign in as owner@example.com / correct-horse-battery"
echo "agent tokens:  artist=$TOK"
echo "               coder=$CODER"
