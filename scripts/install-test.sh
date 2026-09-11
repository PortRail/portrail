#!/bin/bash
# The install a user gets: npm pack, install the tarball into an empty directory with
# no source tree in sight, and prove init/doctor/start/curl work from there.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d /tmp/portrail-install.XXXXXX)
trap 'pkill -f "$tmp/node_modules/.bin/portrail start" 2>/dev/null; rm -rf "$tmp"' EXIT

cd "$here" && npm run build >/dev/null && tarball=$(npm pack --pack-destination "$tmp" 2>/dev/null | tail -1)
cd "$tmp" && npm init -y >/dev/null && npm install --omit=optional --no-fund --no-audit "./$tarball" >/dev/null
echo "installed $(du -sh node_modules | cut -f1) into $tmp"

export PORTRAIL_HOME="$tmp/home"
W="$tmp/node_modules/.bin/portrail"
$W init >/dev/null
$W doctor >/dev/null 2>&1 || true   # agents may be absent; that is not what we test here
mkdir -p "$tmp/ws"; $W workspace add "$tmp/ws" --name ws >/dev/null
key=$($W key create t --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).token))')
$W start --with-fake-agent --port 7499 >"$tmp/daemon.log" 2>&1 &
for _ in $(seq 1 40); do curl -sf http://127.0.0.1:7499/health >/dev/null 2>&1 && break; sleep 0.25; done
state=$(curl -s -X POST http://127.0.0.1:7499/v1/runs -H "Authorization: Bearer $key" -H "Content-Type: application/json" \
  -d '{"agent":"fake","workspace":"ws","wait":5,"prompt":"[{\"exec\":\"npm test\"},{\"exec\":\"sudo rm -rf /\"}]"}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(r.state+" | "+r.summary)})')
echo "run: $state"
[[ "$state" == succeeded* ]] && [[ "$state" == *refused* ]] && echo "PASS: installed package runs and refuses correctly" || { echo "FAIL"; cat "$tmp/daemon.log"; exit 1; }
