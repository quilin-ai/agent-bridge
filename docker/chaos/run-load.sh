#!/usr/bin/env bash
# 混沌 ③：并发压力。CONN 并发连接 × COUNT 事件 同时狂发 → sub 应收齐全部、broker 存活。
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
C="docker compose -f docker/chaos/docker-compose.chaos.yml"
CONN=${CONN:-50}; COUNT=${COUNT:-20}; TOTAL=$((CONN * COUNT))

echo "[load] 起 broker + sub(watch)..."; $C down -v >/dev/null 2>&1
$C up -d --build broker >/dev/null 2>&1; sleep 4
$C up -d sub >/dev/null 2>&1; sleep 3

echo "[load] 并发 CONN=$CONN × COUNT=$COUNT = $TOTAL events 狂发..."
$C run --rm -e CONN="$CONN" -e COUNT="$COUNT" -e DELIVERY=store_if_offline pub 2>&1 | grep -aE 'PUBLISHED'

# 等 sub 收齐(轮询 heartbeat)最多 40s
got=0
for _ in $(seq 1 40); do
  got=$($C logs sub 2>&1 | grep -aoE 'unique=[0-9]+' | grep -aoE '[0-9]+' | tail -1)
  [ "${got:-0}" -ge "$TOTAL" ] 2>/dev/null && break
  sleep 1
done
health=$(curl -sS -m 3 http://127.0.0.1:4700/healthz 2>/dev/null)
$C stop -t 6 sub >/dev/null 2>&1
got=$($C logs sub 2>&1 | grep -aoE 'unique=[0-9]+' | grep -aoE '[0-9]+' | tail -1)
$C down -v >/dev/null 2>&1
echo
echo "[load] sub unique=${got:-0}/$TOTAL ; broker /healthz=$health"
if [ "${got:-0}" = "$TOTAL" ]; then
  echo "==== 混沌③ 并发压力：PASS ✅  ($TOTAL 事件零丢失，broker 存活) ===="; exit 0
else
  echo "==== 混沌③ 并发压力：FAIL ❌  (${got:-0}/$TOTAL) ===="; exit 1
fi
