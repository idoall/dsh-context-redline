#!/usr/bin/env python3
"""demo 用的**只读**静态服务（不碰 $DSH_HOME、不碰真实会话、不写任何文件）。

为什么不用 `python3 -m http.server`：
它不发 `Cache-Control`，于是浏览器会把 `redline-panel.standalone.html` 这类**没有查询串**的页面
缓存起来 —— 用户看到的还是旧版，却以为是最新版（2026-09-30 实际发生过一次）。
这里统一加 `no-store`，让"刷新即最新"成立；出问题时也更容易判断是版本旧还是代码坏。

用法：python3 demo/serve.py   （或 bash demo/serve.sh，它会带上地址）
"""
import functools
import http.server
import os
import socket
import socketserver
import sys

PORT = int(os.environ.get("PORT", "5180"))
DIR = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # 顺序要紧：先发自己的头，再走父类
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


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


with http.server.ThreadingHTTPServer(("0.0.0.0", PORT),
                                     functools.partial(Handler, directory=DIR)) as httpd:
    print(f"本机：      http://127.0.0.1:{PORT}/redline-panel.html", flush=True)
    print(f"同一局域网： http://{lan_ip()}:{PORT}/redline-panel.html", flush=True)
    print(f"单文件版（同一个服务也能打开）： http://{lan_ip()}:{PORT}/redline-panel.standalone.html", flush=True)
    print("已发 Cache-Control: no-store —— 刷新就是最新版", flush=True)
    httpd.serve_forever()
