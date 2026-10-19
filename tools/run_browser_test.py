#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
run_browser_test.py — 用无头 Edge 跑浏览器端的 JS 测试页（本机没有 Node）

用法:
  python tools/run_browser_test.py medium/engine/tests/terrain.test.html [more.html ...] [--timeout 60]

测试页约定（见 medium/engine/tests/harness.js）：页面把结果写进 <pre id="out">，
每行 "PASS 名字" / "FAIL 名字: 原因"，最后一行 "DONE passed=N failed=M"。
本脚本自己起一个临时静态服务（仓库根目录），逐页用 Edge --headless --dump-dom 抓取，
打印结果；任一页有 FAIL 或没有 DONE 则退出码 1。
"""
from __future__ import annotations

import argparse
import html
import os
import re
import subprocess
import sys
import tempfile
import threading
import uuid
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def find_edge() -> str | None:
    for p in (
        os.path.join(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"), r"Microsoft\Edge\Application\msedge.exe"),
        os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), r"Microsoft\Edge\Application\msedge.exe"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), r"Microsoft\Edge\Application\msedge.exe"),
    ):
        if p and os.path.isfile(p):
            return p
    return None


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main(argv=None) -> int:
    for s in (sys.stdout, sys.stderr):
        if s is not None and hasattr(s, "reconfigure"):
            s.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("pages", nargs="+", help="仓库内的测试页相对路径")
    ap.add_argument("--timeout", type=int, default=60)
    ap.add_argument("--budget", type=int, default=8000, help="virtual-time-budget（毫秒）")
    args = ap.parse_args(argv)

    edge = find_edge()
    if not edge:
        print("找不到 msedge.exe", file=sys.stderr)
        return 2
    srv = ThreadingHTTPServer(("127.0.0.1", 0), partial(Quiet, directory=str(ROOT)))
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    failed_pages = 0
    try:
        for page in args.pages:
            rel = Path(page.split("?")[0]).as_posix().lstrip("./") + ("?" + page.split("?", 1)[1] if "?" in page else "")  # 可带 ?query
            if not (ROOT / rel.split("?")[0]).exists():
                print(f"[{rel}] 文件不存在")
                failed_pages += 1
                continue
            url = f"http://127.0.0.1:{port}/{rel}"
            profile = os.path.join(tempfile.gettempdir(), "edge-test-" + uuid.uuid4().hex[:8])
            cmd = [edge, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
                   f"--user-data-dir={profile}", f"--virtual-time-budget={args.budget}", "--dump-dom", url]
            try:
                res = subprocess.run(cmd, capture_output=True, timeout=args.timeout)
                dom = res.stdout.decode("utf-8", errors="replace")
            except subprocess.TimeoutExpired:
                print(f"[{rel}] 超时（{args.timeout}s）")
                failed_pages += 1
                continue
            m = re.search(r'<pre id="out">(.*?)</pre>', dom, re.S)
            text = html.unescape(m.group(1)).strip() if m else ""
            print(f"==== {rel} ====")
            if not text:
                print("（页面没有输出 #out；可能是语法错误或模块加载失败）")
                # 把 body 的前几百字打出来帮助定位
                body = re.search(r"<body[^>]*>(.*)</body>", dom, re.S)
                print((html.unescape(body.group(1))[:600] if body else dom[:600]).strip())
                failed_pages += 1
                continue
            print(text)
            if "FAIL " in text or "DONE" not in text:
                failed_pages += 1
    finally:
        srv.shutdown()
    print(f"\n{'全部通过' if not failed_pages else str(failed_pages) + ' 个页面失败'}")
    return 1 if failed_pages else 0


if __name__ == "__main__":
    sys.exit(main())
