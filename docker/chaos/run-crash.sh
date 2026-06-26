#!/usr/bin/env bash
# 混沌 ①：broker 崩溃恢复 + pending 跨崩溃续投。
#   1) 200 条 store_if_offline 事件发给【离线】成员 sub@ → broker 落 pending(WAL)
#   2) SIGKILL broker(模拟进程崩溃)
#   3) 同卷重启 broker → pending 必须存活
#   4) sub 重连 drain → 应拿到全部 200(零丢失)
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
C="docker compose -f docker/chaos/docker-compose.chaos.yml"
N=${N:-200}

echo "[crash] 清理 + 起 broker..."; $C down -v >/dev/null 2>&1
$C up -d --build broker >/dev/null 2>&1 || { echo "up broker 失败"; exit 1; }
sleep 4

echo "[crash] 发 $N 条 store_if_offline → 离线成员 sub@（broker 落 pending）..."
$C run --rm -e CONN=1 -e COUNT="$N" -e DELIVERY=store_if_offline pub 2>&1 | grep -aE 'PUBLISHED'
sleep 1

echo "[crash] 💥 SIGKILL broker（模拟崩溃）..."
$C kill -s SIGKILL broker >/dev/null 2>&1
sleep 1
echo "[crash] 重启 broker（同卷 → pending 应跨崩溃存活）..."
$C up -d broker >/dev/null 2>&1
sleep 4

echo "[crash] sub 重连 drain..."
out=$($C run --rm -e MODE=drain sub 2>&1)
echo "$out" | grep -aE 'DRAINED|sub\]'
got=$(printf '%s' "$out" | grep -aoE 'DRAINED unique=[0-9]+' | grep -aoE '[0-9]+' | tail -1)

$C down -v >/dev/null 2>&1
echo
if [ "${got:-0}" = "$N" ]; then
  echo "==== 混沌① broker崩溃恢复：PASS ✅  (崩溃后 drain ${got}/${N}，零丢失) ===="
  exit 0
else
  echo "==== 混沌① broker崩溃恢复：FAIL ❌  (drain ${got:-0}/${N}) ===="
  exit 1
fi
