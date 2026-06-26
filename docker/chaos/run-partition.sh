#!/usr/bin/env bash
# 混沌 ②：网络分区 / broker 短暂不可达（docker pause 冻结 broker 进程）。
#   wave1(在线收) → pause broker 6s(冻结) → unpause → wave2 → sub 应收齐 100(零丢失)。
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
C="docker compose -f docker/chaos/docker-compose.chaos.yml"

echo "[part] 起 broker + sub(watch)..."; $C down -v >/dev/null 2>&1
$C up -d --build broker >/dev/null 2>&1; sleep 4
$C up -d sub >/dev/null 2>&1; sleep 3

echo "[part] wave1: 50 events"; $C run --rm -e CONN=1 -e COUNT=50 -e DELIVERY=store_if_offline pub 2>&1 | grep -aE 'PUBLISHED'
sleep 2
echo "[part] ⏸ pause broker 6s（冻结=网络黑洞）..."; $C pause broker >/dev/null 2>&1; sleep 6
echo "[part] ▶ unpause broker..."; $C unpause broker >/dev/null 2>&1; sleep 5
echo "[part] wave2: 50 events"; $C run --rm -e CONN=1 -e COUNT=50 -e DELIVERY=store_if_offline pub 2>&1 | grep -aE 'PUBLISHED'
sleep 5

$C stop -t 6 sub >/dev/null 2>&1
got=$($C logs sub 2>&1 | grep -aoE 'unique=[0-9]+' | grep -aoE '[0-9]+' | tail -1)
$C down -v >/dev/null 2>&1
echo
if [ "${got:-0}" = "100" ]; then
  echo "==== 混沌② 网络分区(pause)：PASS ✅  (跨 6s 冻结，sub 收齐 ${got}/100 零丢失) ===="; exit 0
else
  echo "==== 混沌② 网络分区(pause)：观察值 sub=${got:-0}/100 ===="
  echo "注：若 <100，多半暴露已知 gap——无 WS 心跳，冻结连接靠 onclose 才触发重连(§8.2 backlog)。"; exit 1
fi
