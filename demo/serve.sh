#!/usr/bin/env bash
# 起一个只读的静态服务给 demo 用（不碰 $DSH_HOME、不碰真实会话）。
#   用法： bash demo/serve.sh            # 前台跑，Ctrl-C 停
#          bash demo/serve.sh stop       # 停掉后台实例
set -euo pipefail
PORT="${PORT:-5180}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="/tmp/redline-demo-$PORT.pid"

if [ "${1:-run}" = "stop" ]; then
  if [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null; then echo "已停止 (pid $(cat "$PIDFILE"))"; rm -f "$PIDFILE"; else echo "没有在跑"; fi
  exit 0
fi

IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '')"
echo "本机：      http://127.0.0.1:$PORT/redline-panel.html"
[ -n "$IP" ] && echo "同一局域网： http://$IP:$PORT/redline-panel.html"
echo "单文件版（不需要服务）： demo/redline-panel.standalone.html"
echo
echo "$PORT" >/dev/null
exec python3 -m http.server "$PORT" --bind 0.0.0.0 --directory "$HERE"
