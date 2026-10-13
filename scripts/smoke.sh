#!/usr/bin/env bash
# Смоук-тест API через Caddy: ./scripts/smoke.sh [https://localhost:8443]
set -euo pipefail
B="${1:-https://localhost:8443}/api"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
c() { curl -sk "$@"; }
enc() { python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "$1"; }
first_id() { python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["data"][0]["id"])' "$1"; }

echo "== health: $(c "$B/health")"

echo "== stations (второй запрос из кэша)"
for i in 1 2; do c -o "$T/st.json" -w "   %{http_code} %{time_total}s\n" "$B/stations?q=Frankfurt%20Hbf"; done
python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));[print("  ",s) for s in d["data"][:3]]' "$T/st.json"
FROM=$(first_id "$T/st.json")
c -o "$T/st2.json" "$B/stations?q=K%C3%B6ln%20Hbf"; TO=$(first_id "$T/st2.json")

WHEN=$(TZ=Europe/Berlin date -v+1d +%Y-%m-%dT08:00 2>/dev/null || TZ=Europe/Berlin date -d tomorrow +%Y-%m-%dT08:00)
Q="from=$(enc "$FROM")&to=$(enc "$TO")&when=$WHEN&mode=dep&products=ice&transferTime=10"
echo "== journeys Frankfurt → Köln, $WHEN, только ICE"
c -o "$T/j.json" -w "   %{http_code} %{time_total}s\n" "$B/journeys?$Q"
python3 - "$T/j.json" > "$T/refs" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); x=d['data']
print('   ok', d['ok'], 'вариантов', len(x['journeys']), file=sys.stderr)
for j in x['journeys']:
    print('  ', j['departure']['planned'], '→', j['arrival']['planned'], j['durationMin'], 'мин, пересадок', j['transfers'], j['products'], 'rt', j['realtime'], file=sys.stderr)
l = x['journeys'][0]['legs'][0]
print('   leg0:', json.dumps({k: l[k] for k in ['line','number','direction','product','dep']}, ensure_ascii=False), 'stopovers', len(l['stopovers']), file=sys.stderr)
print(x['laterRef']); print(x['earlierRef']); print(x['journeys'][0]['id'])
PY
LATER=$(sed -n 1p "$T/refs"); EARLIER=$(sed -n 2p "$T/refs"); ID=$(sed -n 3p "$T/refs")

echo "== позже / раньше"
for ref in "$LATER" "$EARLIER"; do
  c "$B/journeys?$Q&cursor=$(enc "$ref")" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("  ",[j["departure"]["planned"][11:16] for j in d["data"]["journeys"]])'
done

echo "== refresh"
c "$B/journeys/refresh?id=$(enc "$ID")" | python3 -c 'import json,sys;d=json.load(sys.stdin);j=d["data"];print("  ",d["ok"],j["departure"],j["durationMin"])'

echo "== ошибки"
c -w "   %{http_code}\n" "$B/journeys?from=x" ; echo
c -w "   %{http_code}\n" "$B/journeys?from=a&to=b&products=nothing"; echo
c -w "   %{http_code}\n" "$B/nope"; echo
