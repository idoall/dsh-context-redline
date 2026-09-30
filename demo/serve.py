#!/usr/bin/env python3
"""demo 用的**只读**静态服务（不碰 $DSH_HOME、不碰真实会话、不写仓库里的文件）。

用法（一般用 `bash demo/serve.sh …` 调它，不必直接跑这个文件）：
    python3 demo/serve.py                 # 前台跑，Ctrl-C 停
    python3 demo/serve.py --daemon        # 后台常驻（双 fork + setsid，写 pidfile 与日志）
    python3 demo/serve.py --status        # 看状态
    python3 demo/serve.py --stop          # 停（按 pidfile，回退按端口找）

为什么不用 `python3 -m http.server`：
它不发 `Cache-Control`，浏览器会把 `redline-panel.standalone.html` 这类**没有查询串**的页面缓存起来
—— 用户看到的还是旧版，却以为是最新版（2026-09-30 实际发生过）。这里统一发 `no-store`。

为什么默认 `--daemon`（而不是 `nohup … &` 或 shell 后台任务）：
那种服务的寿命跟着父进程走 —— 已经因为父进程收工让用户遇到"打不开"（2026-09-30）。
双 fork + setsid 之后进程属于自己一个新的会话，跟任何终端/会话的退出都没关系。

顺序上的一个要点：**先绑定端口、成功之后才写 pidfile** ——
于是"pidfile 存在且进程活着"就等于"服务真的起来了"，报错也不会报成"启动成功"。
"""
import functools
import http.server
import os
import socket
import subprocess
import sys
import time

PORT = int(os.environ.get("PORT", "5180"))
DIR = os.path.dirname(os.path.abspath(__file__))
PIDFILE = os.environ.get("PIDFILE", f"/tmp/redline-demo-{PORT}.pid")
LOGFILE = os.environ.get("LOGFILE", f"/tmp/redline-demo-{PORT}.log")


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # 顺序要紧：先发自己的头，再走父类
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))
        sys.stderr.flush()


Handler.extensions_map.update({
    ".mjs": "text/javascript",
    ".md": "text/plain; charset=utf-8",
})


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))   # 不发包，只让内核选出口网卡
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def banner():
    ip = lan_ip()
    return (f"本机：      http://127.0.0.1:{PORT}/redline-panel.html\n"
            f"同一局域网： http://{ip}:{PORT}/redline-panel.html\n"
            f"单文件版：   http://{ip}:{PORT}/redline-panel.standalone.html\n"
            f"已发 Cache-Control: no-store —— 刷新就是最新版（日志 {LOGFILE}）")


def pidfile_pid():
    try:
        with open(PIDFILE) as f:
            return int(f.read().strip())
    except (OSError, ValueError):
        return None


def alive(pid):
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def pid_on_port():
    """pidfile 丢了就按端口反查（lsof 是 macOS 自带的）。"""
    try:
        out = subprocess.run(["lsof", "-nP", f"-iTCP:{PORT}", "-sTCP:LISTEN", "-t"],
                             capture_output=True, text=True, timeout=5).stdout.split()
        return int(out[0]) if out else None
    except Exception:
        return None


def current_pid():
    p = pidfile_pid()
    return p if alive(p) else pid_on_port()


def make_server():
    return http.server.ThreadingHTTPServer(
        ("0.0.0.0", PORT), functools.partial(Handler, directory=DIR))


def serve_forever(httpd):
    print(banner(), flush=True)
    httpd.serve_forever()


def run_foreground():
    try:
        httpd = make_server()
    except OSError as e:
        print(f"起不来：端口 {PORT} 用不了（{e}）。先跑 bash demo/serve.sh stop，或换个 PORT。", flush=True)
        sys.exit(1)
    serve_forever(httpd)


def run_daemon():
    """父进程：fork → 等子进程写 pidfile（写好才代表端口绑定成功）→ 报状态 → 自己退出。"""
    if os.fork() > 0:
        for _ in range(40):
            time.sleep(0.1)
            p = pidfile_pid()
            if p and alive(p) and p == pid_on_port():
                # ⚠️ 必须 flush：下面用 os._exit 退出，它**不刷新 stdout 缓冲** → 不 flush 就什么也看不到
                print(f"已启动 (pid {p})\n{banner()}", flush=True)
                os._exit(0)
        print(f"启动失败或没起来，看日志：{LOGFILE}", file=sys.stderr, flush=True)
        os._exit(1)

    # 子进程：脱离会话 → 再 fork 一次 → 重定向标准流 → 绑端口 → 写 pidfile → 服务
    os.setsid()
    if os.fork() > 0:
        os._exit(0)
    os.chdir("/")
    log = os.open(LOGFILE, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    os.dup2(log, 1)
    os.dup2(log, 2)
    os.dup2(os.open(os.devnull, os.O_RDONLY), 0)
    try:
        httpd = make_server()
    except OSError as e:
        print(f"起不来：端口 {PORT} 用不了（{e}）", flush=True)
        os._exit(1)
    with open(PIDFILE, "w") as f:
        f.write(str(os.getpid()))
    serve_forever(httpd)


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else ""

    if arg == "--status":
        pid = current_pid()
        print(f"在跑 (pid {pid})\n{banner()}" if pid else "没在跑")
        return

    if arg == "--stop":
        pid = current_pid()
        if pid and alive(pid):
            os.kill(pid, 15)
            print(f"已停止 (pid {pid})")
        else:
            print("没有在跑")
        try:
            os.remove(PIDFILE)
        except OSError:
            pass
        return

    if arg == "--daemon":
        running = current_pid()
        if running:
            print(f"已经在跑 (pid {running})\n{banner()}")
            return
        run_daemon()
        return

    run_foreground()


if __name__ == "__main__":
    main()
