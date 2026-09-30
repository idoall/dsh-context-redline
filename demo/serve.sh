#!/usr/bin/env bash
# 起一个只读的静态服务给 demo 用（不碰 $DSH_HOME、不碰真实会话、不写仓库里的文件）。
#
# 用法：
#   bash demo/serve.sh            # 后台常驻（推荐；跟这个终端退不退出无关）
#   bash demo/serve.sh fg         # 前台跑，Ctrl-C 停
#   bash demo/serve.sh status     # 看是否在跑
#   bash demo/serve.sh stop       # 停
#
# 为什么默认改成后台常驻：以前用"shell 后台任务"起服务，父进程一收工，用户那边就"打不开"了
# （2026-09-30 发生过）。serve.py --daemon 用双 fork + setsid，自己也就不受任何终端影响。
set -euo pipefail
PORT="${PORT:-5180}"
HERE="$(cd "$(dirname "$0")" && pwd)"

case "${1:-start}" in
  stop)   exec python3 "$HERE/serve.py" --stop ;;
  status) exec python3 "$HERE/serve.py" --status ;;
  fg)     echo "前台运行，Ctrl-C 停止"; exec python3 "$HERE/serve.py" ;;
  start)  exec python3 "$HERE/serve.py" --daemon ;;
  *)      echo "用法：bash demo/serve.sh [start|fg|status|stop]"; exit 2 ;;
esac
