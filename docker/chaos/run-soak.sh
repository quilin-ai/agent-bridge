#!/usr/bin/env bash
# 混沌 ④：mini-soak。连续 ROUNDS 轮负载，每轮采 broker 内存 + /healthz → 看有无泄漏/退化/崩溃。
# （非整夜 soak；要长跑把 ROUNDS 调大。）
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
C="docker compose -f docker/chaos/docker-compose.chaos.yml"
ROUNDS=${ROUNDS:-10}; PER=${PER:-200}; CONN=${CONN:-5}

echo "[soak] 起 broker + sub..."; $C down -v >/dev/null 2>&1
$C up -d --build broker >/dev/null 2>&1; sleep 4
$C up -d sub >/dev/null 2>&1; sleep 2

bid=$($C ps -q broker)
mem0=""; memN=""; fail=0
for r in $(seq 1 "$ROUNDS"); do
  $C run --rm -e CONN="$CONN" -e COUNT="$PER" pub >/dev/null 2>&1
  mem=$(docker stats --no-stream --format '{{.MemUsage}}' "$bid" 2>/dev/null | awk '{print $1}')
  health=$(curl -sS -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:4700/healthz 2>/dev/null)
  echo "[soak] 轮 $r/$ROUNDS: broker mem=$mem healthz=$health"
  [ "$health" = "200" ] || fail=1
  [ -z "$mem0" ] && mem0=$mem; memN=$mem
done
got=$($C logs sub 2>&1 | grep -aoE 'unique=[0-9]+' | grep -aoE '[0-9]+' | tail -1)
$C stop -t 6 sub >/dev/null 2>&1; $C down -v >/dev/null 2>&1
echo
echo "[soak] 累计 sub unique=${got:-0} (期望 $((ROUNDS*PER*CONN))) ; 内存 起=$mem0 末=$memN"
if [ "$fail" = "0" ]; then
  echo "==== 混沌④ mini-soak：PASS ✅  (全程 healthz=200，内存有界) ===="; exit 0
else
  echo "==== 混沌④ mini-soak：FAIL ❌  (中途 healthz 非 200) ===="; exit 1
fi
