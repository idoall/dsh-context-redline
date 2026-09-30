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
[ -n "$IP" ] && echo "单文件版：   http://$IP:$PORT/redline-panel.standalone.html"
echo "单文件版（连服务都不用）： demo/redline-panel.standalone.html"
echo
# 不用 `python3 -m http.server`：它不发 Cache-Control，页面会被浏览器缓存 → 看到旧版还以为是新版
# （2026-09-30 实际发生过）。serve.py 统一发 no-store；只读、不写盘。
exec python3 "$HERE/serve.py"
